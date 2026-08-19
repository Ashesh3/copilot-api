import * as Sentry from "@sentry/bun"
import consola from "consola"
import { randomUUID } from "node:crypto"

import { recordCopilotResponseMetadata } from "~/lib/copilot-contract-observability"
import {
  type CopilotRequestAttribution,
  getCopilotRequestAttribution,
  mergeCopilotRequestAttribution,
} from "~/lib/copilot-request-context"
import {
  abortLlmDebugLog,
  failLlmDebugLog,
  finishLlmDebugLog,
  startLlmDebugLog,
  toLlmDebugLogError,
} from "~/lib/llm-debug-log"
import {
  clearCopilotResponseHeaders,
  getClientSessionId,
  getRoutingTelemetryRequestState,
  getRequestId,
  setCopilotResponseHeader,
  updateRoutingTelemetryRequestState,
} from "~/lib/request-session"
import {
  recordUpstreamCall,
  type UpstreamOutcome,
  type UpstreamSendReason,
} from "~/lib/routing-telemetry"
import { state } from "~/lib/state"
import { deriveUpstreamSessionId } from "~/lib/upstream-session-affinity"
import {
  collectSafeCopilotResponseHeaders,
  COPILOT_API_VERSION,
  sanitizeCopilotHeaderValue,
} from "~/services/copilot/copilot-contract"
import { getCopilotToken } from "~/services/github/get-copilot-token"

import type { RetryBudget, RetryClaim } from "./transport-retry"

import { createCopilotTransportInit } from "./transport-options"
import {
  abortableSleep,
  BACKOFF_FACTOR,
  BASE_DELAY_SECONDS,
  createRetryBudget,
  createRetryClaim,
  createTransportChain,
  handleTransportFailure,
  isAbortLikeError,
  logChainResponse,
  MAX_DELAY_SECONDS,
  MAX_RETRIES,
} from "./transport-retry"

// --- Constants ---

export const INITIAL_RETRY_BACKOFF_EXTRA_SECONDS = 1
export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

export interface CopilotTelemetryOptions {
  accountId?: number
  destination: string
  model: string
  provider: "GitHub Copilot"
  reason: UpstreamSendReason
}

type HttpRetrySleep = (
  ms: number,
  signal: AbortSignal | null | undefined,
) => Promise<void>

let httpRetrySleep: HttpRetrySleep = abortableSleep

export function setHttpRetrySleepForTest(sleep?: HttpRetrySleep): void {
  httpRetrySleep = sleep ?? abortableSleep
}

// --- Base URL ---

export function copilotBaseUrl(): string {
  return state.accountType === "individual" ?
      "https://api.githubcopilot.com"
    : `https://api.${state.accountType}.githubcopilot.com`
}

// --- Headers ---

export interface CopilotHeaderOptions {
  anthropicBeta?: string
  /** Set the anthropic-version header (native /v1/messages requests). */
  anthropicVersion?: string
  attribution?: CopilotRequestAttribution
  copilotSessionToken?: string
  copilotToken?: string
  initiator?: "agent" | "user"
  modelProviderPreference?: string
  vision?: boolean
}

const attributionHeaderNames: Partial<
  Record<keyof CopilotRequestAttribution, string>
> = {
  clientExperimentAssignment: "X-Copilot-Client-Exp-Assignment-Context",
  clientMachineId: "X-Client-Machine-Id",
  harnessId: "Copilot-Harness-Id",
  parentAgentId: "X-Parent-Agent-Id",
  repositoryHost: "X-GitHub-Repository-Host",
  repositoryNwo: "X-GitHub-Repository-Nwo",
  subsystemId: "Copilot-Subsystem-Id",
}

function assignSanitizedHeader(
  headers: Record<string, string>,
  options: { maxLength?: number; name: string; value: string | undefined },
): void {
  const sanitized = sanitizeCopilotHeaderValue(options.value, options.maxLength)
  if (sanitized) headers[options.name] = sanitized
}

function assignAttributionHeaders(
  headers: Record<string, string>,
  attribution: CopilotRequestAttribution,
): void {
  for (const [key, name] of Object.entries(attributionHeaderNames) as Array<
    [keyof CopilotRequestAttribution, string]
  >) {
    const value = attribution[key]
    if (value) headers[name] = value
  }
}

function assignTypedOptionHeaders(
  headers: Record<string, string>,
  options: CopilotHeaderOptions | undefined,
): void {
  assignSanitizedHeader(headers, {
    name: "Anthropic-Beta",
    value: options?.anthropicBeta,
  })
  assignSanitizedHeader(headers, {
    name: "anthropic-version",
    value: options?.anthropicVersion,
  })
  assignSanitizedHeader(headers, {
    maxLength: 16 * 1024,
    name: "Copilot-Session-Token",
    value: options?.copilotSessionToken,
  })
  assignSanitizedHeader(headers, {
    name: "X-Model-Provider-Preference",
    value: options?.modelProviderPreference,
  })
}

export function copilotHeaders(
  options?: CopilotHeaderOptions,
): Record<string, string> {
  const token = options?.copilotToken ?? state.copilotToken
  if (!token) {
    throw new Error("Copilot token is not set. Cannot build request headers.")
  }

  const initiator = options?.initiator ?? "user"
  const affinityKey = getClientSessionId()
  const upstreamSessionId =
    affinityKey ? deriveUpstreamSessionId(affinityKey) : state.sessionId
  const attribution = mergeCopilotRequestAttribution(
    getCopilotRequestAttribution(),
    options?.attribution,
  )
  const agentTaskId = attribution.agentTaskId ?? upstreamSessionId

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "copilot-api",
    "Copilot-Integration-Id": state.copilotIntegrationId,
    "editor-version": `vscode/${state.vsCodeVersion ?? "1.104.3"}`,
    "Openai-Intent": attribution.openaiIntent ?? "conversation-agent",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
    "X-Initiator": initiator,
    "X-Request-Id": getRequestId() ?? randomUUID(),
    "X-Interaction-Id": upstreamSessionId,
    "X-Client-Session-Id": upstreamSessionId,
    "X-Agent-Task-Id": agentTaskId,
    "X-Interaction-Type":
      attribution.interactionType
      ?? (initiator === "user" ? "conversation-user" : "conversation-agent"),
  }

  assignAttributionHeaders(headers, attribution)

  if (options?.vision) {
    headers["Copilot-Vision-Request"] = "true"
  }

  assignTypedOptionHeaders(headers, options)

  return headers
}

// --- Quota Headers ---

export interface QuotaParams {
  [key: string]: string
}

export function parseQuotaHeaders(
  response: Response,
): Record<string, QuotaParams> | undefined {
  const quotaPrefix = "x-quota-snapshot-"
  const result: Record<string, QuotaParams> = {}
  let found = false

  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.startsWith(quotaPrefix)) {
      found = true
      const quotaType = lowerKey.slice(quotaPrefix.length)
      const params: QuotaParams = {}
      for (const part of value.split(/[;&]/)) {
        const trimmed = part.trim()
        const eqIndex = trimmed.indexOf("=")
        if (eqIndex !== -1) {
          params[trimmed.slice(0, eqIndex).trim()] = trimmed
            .slice(eqIndex + 1)
            .trim()
        }
      }
      result[quotaType] = params
    }
  }

  return found ? result : undefined
}

// --- Deterministic 400 Detection ---

/**
 * Check if a 400 response body indicates a deterministic (non-transient) error.
 * These should not be retried as they will fail the same way every time.
 */
export function isDeterministic400(body: string): boolean {
  const patterns = [
    "Invalid signature",
    "Invalid `signature`",
    "model_not_supported",
    "model is not supported",
    "messages must be non-empty",
    "invalid_request_body",
    "invalid_type",
    "invalid_value",
    "unexpected_field",
    "unknown_field",
    "not_supported",
    "unrecognized_field",
  ]
  if (patterns.some((pattern) => body.includes(pattern))) return true

  // Copilot's generic "Bad Request\n" response indicates a payload structure issue
  // (e.g. null max_tokens) that won't resolve on retry
  if (body.trim() === "Bad Request") return true

  return false
}

async function isDeterministic400Response(
  response: Response,
): Promise<boolean> {
  const body = await response.clone().text()
  if (!isDeterministic400(body)) return false
  consola.warn("Deterministic HTTP 400, skipping retry")
  return true
}

// --- Header Normalization ---

function toHeaderRecord(
  headersInit: RequestInit["headers"],
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!headersInit) return headers

  if (headersInit instanceof Headers) {
    for (const [key, value] of headersInit.entries()) {
      headers[key] = value
    }
    return headers
  }

  if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      headers[key] = value
    }
    return headers
  }

  for (const [key, value] of Object.entries(headersInit)) {
    if (typeof value === "string") {
      headers[key] = value
    }
  }
  return headers
}

function isLlmDebugPath(path: string): boolean {
  return (
    path === "/chat/completions"
    || path === "/responses"
    || path === "/embeddings"
    || path === "/v1/messages"
  )
}

type DebuggableBody = RequestInit["body"]

function isTypedArrayBody(value: unknown): value is NodeJS.TypedArray {
  return ArrayBuffer.isView(value)
}

function getBodyTypeName(body: object): string {
  return body.constructor.name || "object"
}

function bodyToDebugString(body: DebuggableBody): string | null {
  if (body === null || body === undefined) return null
  if (typeof body === "string") return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (isTypedArrayBody(body)) {
    return new TextDecoder().decode(body)
  }
  return `[unavailable body type: ${getBodyTypeName(body)}]`
}

async function captureLlmDebugResponse(
  logId: string,
  response: Response,
): Promise<void> {
  const responseHeaders = Object.fromEntries(response.headers.entries())
  try {
    const body = await response.clone().text()
    finishLlmDebugLog(logId, {
      body,
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    })
  } catch (error) {
    const debugResponse = {
      body: null,
      bodyReadError: toLlmDebugLogError(error),
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    }
    if (isAbortLikeError(error)) {
      abortLlmDebugLog(logId, { error, response: debugResponse })
      return
    }
    finishLlmDebugLog(logId, debugResponse)
  }
}

function startLlmDebugAttempt(opts: {
  headers: Record<string, string>
  path: string
  requestInit: RequestInit | undefined
  url: string
}): string | undefined {
  const { headers, path, requestInit, url } = opts
  if (!isLlmDebugPath(path)) return undefined

  return startLlmDebugLog({
    method: requestInit?.method ?? "GET",
    path,
    requestBody: bodyToDebugString(requestInit?.body),
    requestHeaders: headers,
    requestId: headers["X-Request-Id"] ?? headers["x-request-id"],
    url,
  })
}

function captureLlmDebugAttemptResponse(
  logId: string | undefined,
  response: Response,
): void {
  if (!logId) return
  void captureLlmDebugResponse(logId, response)
}

function failLlmDebugAttempt(logId: string | undefined, error: unknown): void {
  if (!logId) return
  if (isAbortLikeError(error)) {
    abortLlmDebugLog(logId, { error })
    return
  }
  failLlmDebugLog(logId, error)
}

function setAuthorizationHeader(
  headers: Record<string, string>,
  token: string,
): Record<string, string> {
  const value = `Bearer ${token}`
  const nextHeaders = { ...headers, Authorization: value }

  if ("authorization" in nextHeaders) {
    nextHeaders.authorization = value
  }

  return nextHeaders
}

function canRefreshSingleToken401(response: Response): boolean {
  return (
    response.status === 401 && !state.isMultiToken && Boolean(state.githubToken)
  )
}

function isRetryableStatus(response: Response): boolean {
  return RETRYABLE_STATUSES.has(response.status)
}

function outcomeForResponse(response: Response): UpstreamOutcome {
  if (response.status >= 500) return "server_error"
  if (response.status >= 400) return "client_error"
  return "success"
}

function outcomeForError(error: unknown): UpstreamOutcome {
  return isAbortLikeError(error) ? "aborted" : "transport_error"
}

function recordCopilotAttempt(options: {
  outcome: UpstreamOutcome
  reason: UpstreamSendReason
  telemetry: CopilotTelemetryOptions | undefined
}): void {
  const { outcome, reason, telemetry } = options
  if (!telemetry) return
  updateRoutingTelemetryRequestState({
    destination: telemetry.destination,
    model: telemetry.model,
    provider: telemetry.provider,
  })
  const requestState = getRoutingTelemetryRequestState()
  recordUpstreamCall({
    ...(telemetry.accountId === undefined ?
      {}
    : { accountId: telemetry.accountId }),
    model: telemetry.model,
    outcome,
    provider: telemetry.provider,
    reason,
    route:
      requestState ?
        `${requestState.sourceProtocol} -> ${telemetry.destination}`
      : telemetry.destination,
  })
}

interface CopilotAttemptTelemetryState {
  reason: UpstreamSendReason
  telemetry?: CopilotTelemetryOptions
}

function createCopilotAttemptTelemetryState(
  options:
    | {
        telemetry?: CopilotTelemetryOptions
      }
    | undefined,
): CopilotAttemptTelemetryState {
  return {
    reason: options?.telemetry?.reason ?? "initial",
    ...(options?.telemetry ? { telemetry: options.telemetry } : {}),
  }
}

async function fetchCopilotAttempt(options: {
  init: RequestInit
  telemetryState: CopilotAttemptTelemetryState
  url: string
}): Promise<Response> {
  const { init, telemetryState, url } = options
  try {
    const response = await fetch(url, init)
    recordCopilotAttempt({
      outcome: outcomeForResponse(response),
      reason: telemetryState.reason,
      telemetry: telemetryState.telemetry,
    })
    return response
  } catch (error) {
    recordCopilotAttempt({
      outcome: outcomeForError(error),
      reason: telemetryState.reason,
      telemetry: telemetryState.telemetry,
    })
    throw error
  }
}

function setCurrentCopilotToken(token: string): void {
  state.copilotToken = token
}

// --- Retry Delay Calculation ---

function parseRetryAfterSeconds(
  retryAfterHeader: string | null,
): number | null {
  if (!retryAfterHeader) return null

  const parsedNumber = Number(retryAfterHeader)
  if (!Number.isNaN(parsedNumber)) {
    return Math.max(0, parsedNumber)
  }

  const parsedDate = Date.parse(retryAfterHeader)
  if (Number.isNaN(parsedDate)) {
    return null
  }

  const seconds = Math.ceil((parsedDate - Date.now()) / 1000)
  return Math.max(0, seconds)
}

function calculateHttpRetryDelay(
  retryAfterHeader: string | null,
  retryBackoffExtraSeconds: number,
): number {
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader)
  const baseDelay = retryAfterSeconds ?? BASE_DELAY_SECONDS
  return Math.min(baseDelay + retryBackoffExtraSeconds, MAX_DELAY_SECONDS)
}

function applyRetryJitter(delaySeconds: number): number {
  const jitterMultiplier = 0.8 + Math.random() * 0.4
  return Math.min(delaySeconds * jitterMultiplier, MAX_DELAY_SECONDS)
}

// --- Fetch with Retry ---

async function refreshTokenForRetry(
  headers: Record<string, string>,
  requestInit: RequestInit | undefined,
  path: string,
): Promise<RequestInit> {
  consola.warn(`HTTP 401 on ${path}, refreshing Copilot token`)
  const tokenData = await getCopilotToken()
  setCurrentCopilotToken(tokenData.token)

  return {
    ...requestInit,
    headers: setAuthorizationHeader(headers, tokenData.token),
  }
}

function planHttpRetryDelaySeconds(options: {
  attempt: number
  maxDelaySeconds: number
  path: string
  response: Response
  retryBackoffExtraSeconds: number
}): number {
  const { attempt, maxDelaySeconds, path, response, retryBackoffExtraSeconds } =
    options
  const rawDelaySeconds = calculateHttpRetryDelay(
    response.headers.get("retry-after"),
    retryBackoffExtraSeconds,
  )
  const jitteredDelaySeconds = applyRetryJitter(rawDelaySeconds)
  // This sleep runs before any response header is sent, so it counts directly
  // against Cloudflare's ~120-125s origin inactivity budget.
  const delaySeconds = Math.min(jitteredDelaySeconds, maxDelaySeconds)
  const clampedSeconds =
    delaySeconds < jitteredDelaySeconds ? jitteredDelaySeconds : undefined

  consola.warn(
    `HTTP ${response.status} on ${path} (attempt ${attempt + 1}), retrying in ${delaySeconds.toFixed(1)}s`,
  )
  Sentry.addBreadcrumb({
    category: "copilot",
    message: `HTTP ${response.status} on ${path} (attempt ${attempt + 1})`,
    level: "warning",
    data: {
      status: response.status,
      delay: delaySeconds,
      rawDelay: rawDelaySeconds,
      // Present only when the pre-header ceiling actually shortened the wait,
      // so an under-honoured `retry-after` is visible in production.
      ...(clampedSeconds === undefined ?
        {}
      : { clampedFromDelay: clampedSeconds }),
    },
  })

  return delaySeconds
}

function logQuotaSnapshot(response: Response): void {
  const quota = parseQuotaHeaders(response)
  if (quota) {
    consola.debug("Copilot quota snapshot:", quota)
  }
}

function recordFinalResponseHeaders(response: Response): void {
  clearCopilotResponseHeaders()
  const metadata = collectSafeCopilotResponseHeaders(response.headers)
  for (const [name, value] of Object.entries(metadata)) {
    setCopilotResponseHeader(name, value)
  }
  recordCopilotResponseMetadata(metadata)
}

type ResponseAction =
  | { delaySeconds: number; kind: "retry-status" }
  | { kind: "refresh-token" }
  | { kind: "return" }

/** Decide what an upstream response means, claiming budget for any resend. */
async function classifyResponse(options: {
  attempt: number
  claimRetry: RetryClaim
  maxHttpRetryDelaySeconds: number
  path: string
  response: Response
  retryBackoffExtraSeconds: number
}): Promise<ResponseAction> {
  const {
    attempt,
    claimRetry,
    maxHttpRetryDelaySeconds,
    path,
    response,
    retryBackoffExtraSeconds,
  } = options

  if (canRefreshSingleToken401(response) && claimRetry()) {
    return { kind: "refresh-token" }
  }

  if (response.status === 400) {
    await isDeterministic400Response(response)
    return { kind: "return" }
  }

  if (isRetryableStatus(response) && claimRetry()) {
    return {
      delaySeconds: planHttpRetryDelaySeconds({
        attempt,
        maxDelaySeconds: maxHttpRetryDelaySeconds,
        path,
        response,
        retryBackoffExtraSeconds,
      }),
      kind: "retry-status",
    }
  }

  return { kind: "return" }
}

export async function copilotFetch(
  path: string,
  init?: RequestInit,
  fetchOptions?: {
    baseUrl?: string
    maxHttpRetryDelaySeconds?: number
    retryBudget?: RetryBudget
    telemetry?: CopilotTelemetryOptions
  },
): Promise<Response> {
  const url = `${fetchOptions?.baseUrl ?? copilotBaseUrl()}${path}`
  const budget = fetchOptions?.retryBudget ?? createRetryBudget()
  const maxHttpRetryDelaySeconds =
    fetchOptions?.maxHttpRetryDelaySeconds ?? MAX_DELAY_SECONDS
  // Both caps apply: the shared routed-call allowance and this invocation's
  // own limit, so one copilotFetch can never drain the whole budget.
  const claimRetry: RetryClaim = createRetryClaim(budget)
  const chain = createTransportChain(path, randomUUID())
  const maxAttempts = MAX_RETRIES + 1
  let retryBackoffExtraSeconds = INITIAL_RETRY_BACKOFF_EXTRA_SECONDS
  let requestInit = init
  const telemetryState = createCopilotAttemptTelemetryState(fetchOptions)

  let lastError: Error | undefined
  let lastResponse: Response | undefined
  clearCopilotResponseHeaders()

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let debugLogId: string | undefined
    const attemptStartedAtMs = Date.now()
    chain.attempt = attempt

    try {
      const headers = toHeaderRecord(requestInit?.headers)

      debugLogId = startLlmDebugAttempt({ headers, path, requestInit, url })

      const transportInit = createCopilotTransportInit({
        ...requestInit,
        headers,
      })
      const response = await fetchCopilotAttempt({
        init: transportInit,
        telemetryState,
        url,
      })

      captureLlmDebugAttemptResponse(debugLogId, response)
      logQuotaSnapshot(response)

      const action = await classifyResponse({
        attempt,
        claimRetry,
        maxHttpRetryDelaySeconds,
        path,
        response,
        retryBackoffExtraSeconds,
      })

      if (action.kind === "refresh-token") {
        clearCopilotResponseHeaders()
        requestInit = await refreshTokenForRetry(headers, requestInit, path)
        telemetryState.reason = "token_refresh"
        continue
      }

      if (action.kind === "retry-status") {
        lastResponse = response
        clearCopilotResponseHeaders()
        retryBackoffExtraSeconds *= BACKOFF_FACTOR
        await httpRetrySleep(action.delaySeconds * 1000, requestInit?.signal)
        telemetryState.reason = "http_retry"
        continue
      }

      logChainResponse(chain, Date.now() - attemptStartedAtMs, response.status)
      recordFinalResponseHeaders(response)
      return response
    } catch (error) {
      lastError = error as Error
      failLlmDebugAttempt(debugLogId, error)
      clearCopilotResponseHeaders()

      // Resolves once the backoff has elapsed; throws to end the chain.
      await handleTransportFailure({
        attemptMs: Date.now() - attemptStartedAtMs,
        chain,
        claimRetry,
        error,
        signal: requestInit?.signal,
      })
      telemetryState.reason = "transport_retry"
    }
  }

  if (lastResponse) {
    recordFinalResponseHeaders(lastResponse)
    return lastResponse
  }

  throw lastError ?? new Error("Request failed without a captured error")
}

// --- Message Types ---

interface ContentPart {
  type: string
}

// --- Helper Functions ---

export function hasVisionContent(
  messages: ReadonlyArray<{
    content?: string | ReadonlyArray<ContentPart> | null
  }>,
): boolean {
  // Image parts across dialects, plus file/document attachment parts (PDFs)
  // which also ride the vision pipeline upstream.
  const attachmentTypes = new Set([
    "image_url",
    "image",
    "input_image",
    "file",
    "input_file",
    "document",
  ])

  for (const message of messages) {
    if (Array.isArray(message.content)) {
      const parts = message.content as ReadonlyArray<ContentPart>
      for (const part of parts) {
        if (attachmentTypes.has(part.type)) {
          return true
        }
      }
    }
  }

  return false
}

export function detectInitiator(
  messages: ReadonlyArray<{ role: string }>,
  override?: "agent" | "user",
): "agent" | "user" {
  if (override) return override

  if (messages.length === 0) return "user"

  const lastMessage = messages.at(-1)
  if (
    lastMessage
    && (lastMessage.role === "assistant" || lastMessage.role === "tool")
  ) {
    return "agent"
  }

  return "user"
}

export function addPromptCaching(
  messages: Array<{
    role: string
    content?: string | Array<unknown> | null
    tool_calls?: Array<unknown>
    reasoning_text?: string | null
    reasoning_opaque?: string | null
    encrypted_content?: string | null
  }>,
  tools?: Array<object>,
): void {
  // Add cache control to last system message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "system") {
      ;(messages[i] as Record<string, unknown>).copilot_cache_control = {
        type: "ephemeral",
      }
      break
    }
  }

  // CAPI caching is most effective when the checkpoint is on the last non-user turn.
  // Avoid pure reasoning-only assistant turns to prevent Anthropic validation issues.
  const lastNonUserIndex = messages.findLastIndex(
    (message) => message.role !== "user" && !isReasoningOnlyMessage(message),
  )
  if (lastNonUserIndex !== -1) {
    ;(
      messages[lastNonUserIndex] as Record<string, unknown>
    ).copilot_cache_control = {
      type: "ephemeral",
    }
  }

  // Add cache control to last tool definition
  if (tools && tools.length > 0) {
    const lastTool = tools.at(-1)
    if (lastTool) {
      ;(lastTool as Record<string, unknown>).copilot_cache_control = {
        type: "ephemeral",
      }
    }
  }
}

function isReasoningOnlyMessage(message: {
  role: string
  content?: string | Array<unknown> | null
  tool_calls?: Array<unknown>
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  encrypted_content?: string | null
}): boolean {
  if (message.role !== "assistant") return false

  const hasReasoning = Boolean(
    message.reasoning_text
      || message.reasoning_opaque
      || message.encrypted_content,
  )
  if (!hasReasoning) return false

  const hasContent =
    typeof message.content === "string" ?
      message.content.trim().length > 0
    : Array.isArray(message.content) && message.content.length > 0

  const hasToolCalls =
    Array.isArray(message.tool_calls) && message.tool_calls.length > 0

  return !hasContent && !hasToolCalls
}
