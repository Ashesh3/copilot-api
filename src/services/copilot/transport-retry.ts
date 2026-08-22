import * as Sentry from "@sentry/bun"
import consola from "consola"

import {
  readDescriptorSnapshotValue,
  readNativeDomExceptionField,
  snapshotDescriptorChain,
} from "~/lib/descriptor-chain"
import { sleep } from "~/lib/utils"

// --- Constants ---

export const MAX_RETRIES = 1
export const BASE_DELAY_SECONDS = 5
export const BACKOFF_FACTOR = 2
export const MAX_DELAY_SECONDS = 180

/**
 * Ceiling for a backoff that runs *before* any response header has been sent.
 *
 * Cloudflare's origin read timeout is a ~120-125s inactivity timer. A single
 * `retry-after` large enough to clamp at `MAX_DELAY_SECONDS` therefore sleeps
 * 144-180s with zero bytes on the wire and produces a deterministic 524 on its
 * own. `MAX_ROUTED_SENDS` allows at most two such sleeps per routed call, so
 * 30s each keeps the worst case at 60s and leaves ~60s of edge budget for the
 * connect and TTFB of the remaining sends.
 *
 * This bounds *time-to-committed-headers* only. It is deliberately not a
 * statement that a large upstream `retry-after` should be ignored: honouring
 * the full duration is what the early-commit work (PR2) enables, by warming the
 * wire first. Until then a clamp is strictly better than a guaranteed 524, and
 * every clamp is logged so the shortfall is visible rather than silent.
 */
export const PRE_HEADER_MAX_DELAY_SECONDS = 30

/** Positive jitter floor/ceiling for connection-level retries. */
const CONNECTION_RETRY_MIN_DELAY_MS = 250
const CONNECTION_RETRY_MAX_DELAY_MS = 1000

/** Hard ceiling on upstream sends for one logical routed call. */
export const MAX_ROUTED_SENDS = 3

// --- Send Budget ---

/**
 * Extra sends (beyond the first) allowed across a whole routed call, shared by
 * every path that can issue one: a transport retry or retryable HTTP status
 * inside `copilotFetch`, plus the router's 401 refresh-resend and its
 * 401/403/429 failover-resend.
 *
 * Each of those starts its own `copilotFetch`, so a per-invocation limit alone
 * lets sends multiply across accounts. Callers additionally cap themselves at
 * `MAX_RETRIES` so one invocation cannot drain the shared allowance.
 */
export interface RetryBudget {
  compatibilityRetryUsed: boolean
  remaining: number
}

export function createRetryBudget(options?: {
  extraSends?: number
}): RetryBudget {
  return {
    compatibilityRetryUsed: false,
    remaining: options?.extraSends ?? MAX_ROUTED_SENDS - 1,
  }
}

/** Claim one shared extra-send allowance. Returns false when exhausted. */
export function consumeExtraSend(budget: RetryBudget): boolean {
  if (budget.remaining <= 0) return false
  budget.remaining -= 1
  return true
}

/** Claim the single deterministic compatibility resend for a routed call. */
export function claimCompatibilityRetry(budget: RetryBudget): boolean {
  if (budget.compatibilityRetryUsed || !consumeExtraSend(budget)) return false
  budget.compatibilityRetryUsed = true
  return true
}

/** Claims one extra send, honouring both the shared and per-invocation caps. */
export type RetryClaim = () => boolean

export function createRetryClaim(
  budget: RetryBudget,
  maxLocalRetries = MAX_RETRIES,
): RetryClaim {
  let localRetries = 0

  return () => {
    if (localRetries >= maxLocalRetries) return false
    if (!consumeExtraSend(budget)) return false
    localRetries += 1
    return true
  }
}

// --- Error Classification ---

/**
 * Connection-level failure codes. The socket died before a usable response
 * arrived, so the request never produced output and can be re-sent.
 */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "ERR_SOCKET_CLOSED",
  "ETIMEDOUT",
])

/**
 * Bun reports a reset pooled keep-alive socket as "The socket connection was
 * closed unexpectedly" and carries the real signal in `error.code`. That
 * message matches none of the conventional Node.js wordings, so classifying on
 * the message alone silently drops the most common upstream failure.
 */
const CONNECTION_ERROR_PATTERNS = [
  "socket connection was closed",
  "connection closed",
  "connection reset",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "other side closed",
  "unexpected eof",
]

const NETWORK_ERROR_PATTERNS = [
  "fetch failed",
  "network error",
  "timeout",
  "terminated",
  "goaway",
]

interface TransportErrorSnapshot {
  code?: string
  cause?: TransportErrorSnapshot
  message?: string
  name?: string
}

const TRANSPORT_ERROR_DESCRIPTOR_KEYS = new Set([
  "cause",
  "code",
  "message",
  "name",
])
const TRANSPORT_ERROR_DESCRIPTOR_DEPTH = 5

function snapshotTransportError(
  value: unknown,
  depth = 0,
): TransportErrorSnapshot | undefined {
  if (typeof value !== "object" || value === null || depth > 1) {
    return undefined
  }

  const snapshot = snapshotDescriptorChain(value, {
    keys: TRANSPORT_ERROR_DESCRIPTOR_KEYS,
    maxDepth: TRANSPORT_ERROR_DESCRIPTOR_DEPTH,
  })
  if (!snapshot) return undefined

  const codeValue =
    readNativeDomExceptionField(snapshot, "code")
    ?? readDescriptorSnapshotValue(snapshot, "code")
  const messageValue =
    readNativeDomExceptionField(snapshot, "message")
    ?? readDescriptorSnapshotValue(snapshot, "message")
  const nameValue =
    readNativeDomExceptionField(snapshot, "name")
    ?? readDescriptorSnapshotValue(snapshot, "name")
    ?? snapshot.errorKind
  const causeValue = readDescriptorSnapshotValue(snapshot, "cause")

  return {
    ...(typeof codeValue === "string" ? { code: codeValue } : {}),
    ...(typeof messageValue === "string" ? { message: messageValue } : {}),
    ...(typeof nameValue === "string" ? { name: nameValue } : {}),
    ...(causeValue === undefined ?
      {}
    : {
        cause: snapshotTransportError(causeValue, depth + 1),
      }),
  }
}

function getTransportErrorCode(
  snapshot: TransportErrorSnapshot | undefined,
): string | undefined {
  return snapshot?.code ?? snapshot?.cause?.code
}

export function getErrorCode(error: unknown): string | undefined {
  const code = getTransportErrorCode(snapshotTransportError(error))
  return code && CONNECTION_ERROR_CODES.has(code) ? code : undefined
}

function matchesErrorPattern(
  snapshot: TransportErrorSnapshot | undefined,
  patterns: ReadonlyArray<string>,
): boolean {
  const message = snapshot?.message?.toLowerCase() ?? ""
  const causeMessage = snapshot?.cause?.message?.toLowerCase() ?? ""

  return patterns.some(
    (pattern) => message.includes(pattern) || causeMessage.includes(pattern),
  )
}

export function isAbortLikeError(error: unknown): boolean {
  const snapshot = snapshotTransportError(error)
  if (!snapshot) return false
  if (snapshot.name === "AbortError") return true

  // A transport code outranks the wording. ECONNABORTED is a dead socket, not
  // a client cancellation, and its message routinely contains "aborted".
  const code = getTransportErrorCode(snapshot)
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return false

  const message = snapshot.message?.toLowerCase() ?? ""
  const causeMessage = snapshot.cause?.message?.toLowerCase() ?? ""
  return message.includes("aborted") || causeMessage.includes("aborted")
}

export function isConnectionError(error: unknown): boolean {
  const snapshot = snapshotTransportError(error)
  if (!snapshot || isAbortLikeError(error)) return false

  const code = getTransportErrorCode(snapshot)
  if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true
  if (snapshot.name === "ConnectionClosed") return true

  return matchesErrorPattern(snapshot, CONNECTION_ERROR_PATTERNS)
}

export function isRetryableError(error: unknown): boolean {
  const snapshot = snapshotTransportError(error)
  if (!snapshot || isAbortLikeError(error)) return false

  return (
    isConnectionError(error)
    || matchesErrorPattern(snapshot, NETWORK_ERROR_PATTERNS)
  )
}

// --- Backoff ---

/**
 * Connection resets arrive in bursts, so a retry fired instantly tends to land
 * inside the same burst. Jitter with a positive floor spreads the retry past it
 * without paying the multi-second backoff a slow upstream would warrant.
 */
function calculateConnectionRetryDelayMs(): number {
  const spread = CONNECTION_RETRY_MAX_DELAY_MS - CONNECTION_RETRY_MIN_DELAY_MS
  return CONNECTION_RETRY_MIN_DELAY_MS + Math.random() * spread
}

function calculateNetworkRetryDelay(attempt: number): number {
  const exponentialDelay = BASE_DELAY_SECONDS * BACKOFF_FACTOR ** attempt
  return Math.min(exponentialDelay, MAX_DELAY_SECONDS)
}

function toAbortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (Error.isError(reason)) return reason

  const error = new Error("The operation was aborted")
  error.name = isAbortLikeError(reason) ? "AbortError" : "Error"
  // Preserve non-Error reasons (e.g. a DOMException) for diagnostics.
  if (reason !== undefined && reason !== null) {
    error.cause = reason
  }
  return error
}

/** Sleep that gives up early when the caller disconnects mid-backoff. */
export async function abortableSleep(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (!signal) {
    await sleep(ms)
    return
  }

  // Bound to a const so the narrowing survives into the hoisted abort handler.
  const abortSignal = signal
  if (abortSignal.aborted) {
    throw toAbortReason(abortSignal)
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      reject(toAbortReason(abortSignal))
    }

    abortSignal.addEventListener("abort", onAbort, { once: true })
  })
}

// --- Telemetry ---

/**
 * Durable outcomes for one transport attempt. `response_received` records that
 * a send produced an HTTP response — it is not a success claim, so the status
 * rides along and a 503 stays distinguishable from a recovery.
 */
type TransportOutcome =
  | "cancelled"
  | "exhausted"
  | "response_received"
  | "retrying"

interface TransportEventFields {
  attempt: number
  /** Duration of the send itself, captured before any backoff. */
  attemptMs: number
  chainStartedAtMs: number
  delayMs?: number
  error?: unknown
  path: string
  retryChainId: string
  status?: number
}

type TransportEventSink = (
  message: string,
  attributes: Record<string, unknown>,
) => void

let transportEventSink: TransportEventSink | undefined

/** Observe transport telemetry in tests without initializing Sentry. */
export function setTransportEventSinkForTest(sink?: TransportEventSink): void {
  transportEventSink = sink
}

function logTransportEvent(
  outcome: TransportOutcome,
  fields: TransportEventFields,
): void {
  const {
    attempt,
    attemptMs,
    chainStartedAtMs,
    delayMs,
    error,
    path,
    retryChainId,
    status,
  } = fields
  const errorCode = getErrorCode(error)

  const message = `copilot transport ${outcome}`
  const attributes: Record<string, unknown> = {
    attempt: attempt + 1,
    attemptMs: Math.round(attemptMs),
    // Computed at emit time so backoff burned before a cancellation counts.
    elapsedMs: Math.round(Date.now() - chainStartedAtMs),
    outcome,
    path,
    retryChainId,
    ...(delayMs === undefined ? {} : { delayMs: Math.round(delayMs) }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(status === undefined ? {} : { status }),
  }

  transportEventSink?.(message, attributes)
  Sentry.logger.info(message, attributes)
}

function warnTransportRetry(options: {
  attempt: number
  delayMs: number
  error: unknown
  path: string
  retryChainId: string
}): void {
  const { attempt, delayMs, error, path, retryChainId } = options
  const errorCode = getErrorCode(error)
  const errorClass = isConnectionError(error) ? "connection" : "network"

  consola.warn(
    `Fetch ${errorClass} error on ${path} (attempt ${attempt + 1}), retrying in ${(delayMs / 1000).toFixed(2)}s`,
    {
      ...(errorCode === undefined ? {} : { errorCode }),
      retryChainId,
    },
  )
  Sentry.addBreadcrumb({
    category: "copilot",
    message: `Fetch ${errorClass} error on ${path} (attempt ${attempt + 1})`,
    level: "warning",
    data: {
      delayMs,
      errorClass,
      ...(errorCode === undefined ? {} : { errorCode }),
      retryChainId,
    },
  })
}

// --- Chain Handling ---

/**
 * Mutable state for one `copilotFetch` retry chain. `retried` gates telemetry:
 * chains that never retried emit nothing, so every `retrying` event pairs with
 * exactly one terminal event carrying the same `retryChainId`.
 */
export interface TransportChain {
  attempt: number
  chainStartedAtMs: number
  path: string
  retried: boolean
  retryChainId: string
}

export function createTransportChain(
  path: string,
  retryChainId: string,
): TransportChain {
  return {
    attempt: 0,
    chainStartedAtMs: Date.now(),
    path,
    retried: false,
    retryChainId,
  }
}

/** Record that a chain ended with an HTTP response in hand. */
export function logChainResponse(
  chain: TransportChain,
  attemptMs: number,
  status: number,
): void {
  if (!chain.retried) return

  logTransportEvent("response_received", {
    attempt: chain.attempt,
    attemptMs,
    chainStartedAtMs: chain.chainStartedAtMs,
    path: chain.path,
    retryChainId: chain.retryChainId,
    status,
  })
}

function decideTransportRetry(options: {
  attempt: number
  claimRetry: RetryClaim
  error: unknown
  signal: AbortSignal | null | undefined
}): { delayMs: number } | { delayMs?: undefined; cancelled: boolean } {
  const { attempt, claimRetry, error, signal } = options

  if (isAbortLikeError(error)) return { cancelled: true }
  // A caller that has already disconnected gets no retry — claiming budget and
  // logging `retrying` here would bill a send that can never happen.
  if (signal?.aborted) return { cancelled: true }
  if (!isRetryableError(error)) return { cancelled: false }
  if (!claimRetry()) return { cancelled: false }

  return {
    delayMs:
      isConnectionError(error) ?
        calculateConnectionRetryDelayMs()
      : calculateNetworkRetryDelay(attempt) * 1000,
  }
}

/**
 * Handle a thrown transport error. Resolves once the backoff has elapsed and
 * the caller should re-send; throws to end the chain, after emitting the single
 * terminal event that closes it.
 */
export async function handleTransportFailure(options: {
  attemptMs: number
  chain: TransportChain
  claimRetry: RetryClaim
  error: unknown
  signal: AbortSignal | null | undefined
}): Promise<void> {
  const { attemptMs, chain, claimRetry, error, signal } = options
  const eventFields: TransportEventFields = {
    attempt: chain.attempt,
    attemptMs,
    chainStartedAtMs: chain.chainStartedAtMs,
    error,
    path: chain.path,
    retryChainId: chain.retryChainId,
  }

  const decision = decideTransportRetry({
    attempt: chain.attempt,
    claimRetry,
    error,
    signal,
  })

  if (decision.delayMs === undefined) {
    if (chain.retried) {
      logTransportEvent(
        decision.cancelled ? "cancelled" : "exhausted",
        eventFields,
      )
    }
    throw error
  }

  chain.retried = true
  logTransportEvent("retrying", { ...eventFields, delayMs: decision.delayMs })
  warnTransportRetry({
    attempt: chain.attempt,
    delayMs: decision.delayMs,
    error,
    path: chain.path,
    retryChainId: chain.retryChainId,
  })

  try {
    await abortableSleep(decision.delayMs, signal)
  } catch (abortError) {
    logTransportEvent("cancelled", { ...eventFields, error: abortError })
    throw abortError
  }
}
