import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

import type { LlmDebugFallbackObservation } from "~/lib/llm-debug-fallback"

import { extractRequestCredential } from "~/lib/credential-resolver"
import { getModelFallbackConversationIdentity } from "~/lib/model-fallback-conversation"
import { normalizeModelName } from "~/lib/model-resolver"
import { parseReasoningEffort } from "~/lib/model-suffix"

const CLIENT_RETRY_WINDOW_MS = 60_000
const MAX_CONVERSATIONS = 2000

interface RefusalEvidence {
  id: string
  model: string
  canonicalModel: string
  upstreamIdentity: string
  fingerprint: string
  endedAtMs: number
}

interface ObservationScope {
  admittedAtMs: number
  epoch: number
  expiresAtMs: number
  key?: string
  model?: string
  fingerprint?: string
  requested?: LlmDebugFallbackObservation
  client?: LlmDebugFallbackObservation
  candidate?: RefusalEvidence
  refusal?: RefusalEvidence
  decided: boolean
  lastLogId?: string
}

interface CaptureScope {
  scope: ObservationScope
  upstreamIdentity?: string
}

export interface FallbackCaptureIdentity {
  id: string
  model?: string
  url: string
  upstream?:
    | { kind: "custom"; providerId: string }
    | { kind: "copilot"; accountId?: number }
}

const scopes = new AsyncLocalStorage<ObservationScope>()
const conversations = new Map<string, ObservationScope>()
const captures = new Map<string, CaptureScope>()
let epoch = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function canonicalModel(model: string): string {
  const colon = model.lastIndexOf(":")
  const base =
    colon !== -1 && parseReasoningEffort(model.slice(colon + 1)) ?
      model.slice(0, colon)
    : model
  return normalizeModelName(base)
}

function requestFingerprint(
  payload: Record<string, unknown>,
): string | undefined {
  const body = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== "model"),
  )
  try {
    return digest(
      JSON.stringify(body, (_key, value: unknown) =>
        isRecord(value) ?
          Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : value,
      ),
    )
  } catch {
    return undefined
  }
}

export function pruneClientFallbackObservations(now = Date.now()): void {
  for (const [key, scope] of conversations) {
    const hasLiveCapture =
      scope.lastLogId !== undefined && captures.has(scope.lastLogId)
    if (scope.expiresAtMs <= now && (scope.refusal || !hasLiveCapture)) {
      conversations.delete(key)
    }
  }
}

export function runWithMessagesFallbackScope<T>(
  options: {
    request: Request
    payload: unknown
    requested?: LlmDebugFallbackObservation
  },
  callback: () => T,
): T {
  const now = Date.now()
  pruneClientFallbackObservations(now)
  const scope: ObservationScope = {
    admittedAtMs: now,
    epoch,
    expiresAtMs: now + CLIENT_RETRY_WINDOW_MS,
    requested: options.requested,
    decided: false,
  }
  const identity = getModelFallbackConversationIdentity({
    headers: options.request.headers,
    payload: options.payload,
  })
  const credential = extractRequestCredential(options.request)
  if (identity && credential && isRecord(options.payload)) {
    scope.key = digest(JSON.stringify([credential, identity]))
    scope.model =
      typeof options.payload.model === "string" ?
        options.payload.model
      : undefined
    scope.fingerprint = requestFingerprint(options.payload)
    const previous = conversations.get(scope.key)
    scope.candidate = previous?.refusal
    if (previous) previous.refusal = undefined
    conversations.delete(scope.key)
    conversations.set(scope.key, scope)
    while (conversations.size > MAX_CONVERSATIONS) {
      const oldest = conversations.keys().next().value
      if (!oldest) break
      conversations.delete(oldest)
    }
  }
  return scopes.run(scope, callback)
}

function upstreamIdentity(input: FallbackCaptureIdentity): string | undefined {
  if (!input.model) return undefined
  try {
    const url = new URL(input.url)
    return digest(
      JSON.stringify([
        url.origin,
        input.upstream?.kind,
        input.upstream?.kind === "custom" ?
          input.upstream.providerId
        : undefined,
        canonicalModel(input.model),
      ]),
    )
  } catch {
    return undefined
  }
}

function matchClientRetry(
  scope: ObservationScope,
  targetIdentity: string | undefined,
): void {
  if (scope.decided) return
  scope.decided = true
  const previous = scope.candidate
  scope.candidate = undefined
  if (
    !previous
    || !scope.key
    || !scope.model
    || !scope.fingerprint
    || !targetIdentity
    || scope.epoch !== epoch
    || conversations.get(scope.key) !== scope
    || !captures.has(previous.id)
    || previous.fingerprint !== scope.fingerprint
    || scope.admittedAtMs < previous.endedAtMs
    || scope.admittedAtMs - previous.endedAtMs > CLIENT_RETRY_WINDOW_MS
    || canonicalModel(scope.model) === previous.canonicalModel
    || targetIdentity === previous.upstreamIdentity
  )
    return
  scope.client = {
    kind: "client",
    fromModel: previous.model,
    targetModel: scope.model,
    previousLogId: previous.id,
    reason: "refusal",
    evidence: "inferred",
  }
}

export function startClientFallbackCapture(
  input: FallbackCaptureIdentity,
): Array<LlmDebugFallbackObservation> | undefined {
  const scope = scopes.getStore()
  if (!scope) return undefined
  const targetIdentity = upstreamIdentity(input)
  matchClientRetry(scope, targetIdentity)
  if (
    scope.epoch !== epoch
    || (scope.client?.kind === "client"
      && !captures.has(scope.client.previousLogId))
  ) {
    scope.client = undefined
  }
  scope.lastLogId = input.id
  scope.refusal = undefined
  if (scope.epoch === epoch)
    captures.set(input.id, { scope, upstreamIdentity: targetIdentity })
  return [scope.requested, scope.client]
    .filter(
      (entry): entry is LlmDebugFallbackObservation => entry !== undefined,
    )
    .map((entry) => structuredClone(entry))
}

export function recordClientFallbackRefusal(
  id: string,
  endedAtMs: number,
): void {
  const capture = captures.get(id)
  const scope = capture?.scope
  if (
    !capture?.upstreamIdentity
    || !scope?.key
    || !scope.model
    || !scope.fingerprint
    || scope.epoch !== epoch
    || scope.lastLogId !== id
    || conversations.get(scope.key) !== scope
  )
    return
  scope.expiresAtMs = endedAtMs + CLIENT_RETRY_WINDOW_MS
  scope.refusal = {
    id,
    model: scope.model,
    canonicalModel: canonicalModel(scope.model),
    upstreamIdentity: capture.upstreamIdentity,
    fingerprint: scope.fingerprint,
    endedAtMs,
  }
}

export function releaseClientFallbackCapture(id: string): void {
  const scope = captures.get(id)?.scope
  captures.delete(id)
  if (scope?.refusal?.id === id) scope.refusal = undefined
  if (
    scope?.key
    && scope.lastLogId === id
    && conversations.get(scope.key) === scope
  ) {
    conversations.delete(scope.key)
  }
}

export function clearClientFallbackObservations(): void {
  epoch++
  captures.clear()
  conversations.clear()
}
