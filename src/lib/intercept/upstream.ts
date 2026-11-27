import type { UpstreamSendReason } from "~/lib/routing-telemetry"

import {
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"
import { replaceModelFallbackResponse } from "~/lib/model-fallback"
import { getClientSessionId } from "~/lib/request-session"

import { isInterceptBypassed } from "./assistant"
import { extractModelFromBody } from "./canonical"
import { type InterceptRequestSnapshot, interceptEngine } from "./engine"
import { replayConflictError } from "./items"
import { applyEdits, computeEdits, digestText } from "./json-edits"
import {
  type Decision,
  ownerStorage,
  type SendOwner,
  type SentRequest,
} from "./send-owner"

/**
 * Intercept sees individual upstream sends, but one logical request can be
 * sent several times: account failover, compatibility, payload, and HTTP
 * retries. The layer that owns such a retry loop runs it inside
 * `interceptLogicalSend`, which keeps the operator's view to one decision:
 *
 * - The first send is held (or passed through) and its decision recorded.
 *   Resends of that request, to the same destination, replay the decision
 *   instead of being held again, even if Intercept was turned off meanwhile.
 *   A resend that no longer fits the approved edits is held again, or, when
 *   it cannot be, refused rather than sent without them.
 * - Sends never hold their own responses; the owner holds only the response
 *   the loop settles on, then runs bookkeeping deferred until that decision.
 */

export interface UpstreamSend {
  method: string
  path: string
  url: string
  upstream: "copilot" | "custom"
  providerId?: string
  headers: Record<string, string>
  body: unknown
  /** The routed model, for requests whose body is not text. */
  model?: string
  signal?: AbortSignal | null
  reason?: UpstreamSendReason
}

type TextSend = UpstreamSend & { body: string }

/** A resend inherits the decision, or differs where the operator edited. */
type Replay = { kind: "replay"; body: string } | { kind: "conflict" }

function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/** Swap the owner's decision reservation; false when the new one does not fit. */
function reserveDecision(owner: SendOwner, bytes: number): boolean {
  if (bytes > owner.decisionBytes) {
    if (!reserveDebugCaptureMemory(bytes - owner.decisionBytes)) return false
  } else {
    releaseDebugCaptureMemory(owner.decisionBytes - bytes)
  }
  owner.decisionBytes = bytes
  return true
}

function recordDecision(
  owner: SendOwner,
  request: TextSend,
  outcome: { body: string; held: boolean },
): void {
  // Forwarding a held request unchanged loses nothing on a resend, so it is
  // replayed like one that was never held, without reserving anything.
  const unchanged = !outcome.held || outcome.body === request.body
  const decision: Decision = {
    path: request.path,
    upstream: request.upstream,
    providerId: request.providerId,
    passThrough: unchanged,
    originalDigest: digestText(request.body),
  }
  if (!unchanged) {
    // The approval outlives the held item in history, so it is reserved for
    // as long as the logical send can resend. Without room for the body, the
    // edit set alone replays it; without room for either, resends are
    // reviewed again (or refused), never sent without the edits.
    const edits = computeEdits(request.body, outcome.body)
    const editBytes = edits ? textBytes(JSON.stringify(edits)) : 0
    if (reserveDecision(owner, textBytes(outcome.body) + editBytes)) {
      decision.approved = outcome.body
      decision.edits = edits
    } else if (edits && reserveDecision(owner, editBytes)) {
      decision.edits = edits
    } else {
      reserveDecision(owner, 0)
    }
  } else {
    reserveDecision(owner, 0)
  }
  owner.decision = decision
}

/** How a resend inherits the decision, or undefined when none applies. */
function replayDecision(
  owner: SendOwner | undefined,
  request: TextSend,
): Replay | undefined {
  const decision = owner?.decision
  // A new request is always decided on its own, even with an identical body.
  if (!decision || !request.reason || request.reason === "initial") {
    return undefined
  }
  if (
    decision.path !== request.path
    || decision.upstream !== request.upstream
    || decision.providerId !== request.providerId
  ) {
    return undefined
  }
  if (decision.passThrough) return { kind: "replay", body: request.body }
  if (
    decision.approved !== undefined
    && digestText(request.body) === decision.originalDigest
  ) {
    return { kind: "replay", body: decision.approved }
  }
  const replayed = decision.edits && applyEdits(request.body, decision.edits)
  return replayed === undefined ?
      { kind: "conflict" }
    : { kind: "replay", body: replayed }
}

function snapshotOf(sent: SentRequest): InterceptRequestSnapshot {
  if (sent.snapshot) return sent.snapshot
  const body = typeof sent.body === "string" ? sent.body : ""
  return {
    method: sent.method,
    path: sent.path,
    // The body actually sent names the model; a replayed edit may change it.
    model: (body && extractModelFromBody(body)) || sent.model,
    body,
    headers: {},
    sessionId: getClientSessionId(),
  }
}

async function holdResponse(
  sent: SentRequest,
  response: Response,
): Promise<Response> {
  if (!interceptEngine.isEnabled()) return response
  const held = await interceptEngine.interceptResponse({
    method: sent.method,
    path: sent.path,
    url: sent.url,
    upstream: sent.upstream,
    providerId: sent.providerId,
    response,
    requestSnapshot: snapshotOf(sent),
    signal: sent.signal,
  })
  if (held !== response) replaceModelFallbackResponse(response, held)
  return held
}

/** The body to send for a request, deciding or replaying as needed. */
async function bodyToSend(
  owner: SendOwner | undefined,
  request: TextSend,
): Promise<{ body: string; snapshot?: InterceptRequestSnapshot }> {
  const replay = replayDecision(owner, request)
  if (replay?.kind === "replay") return { body: replay.body }
  // An approved request must not go out without the operator's edits: a
  // conflicting resend needs a fresh hold, or it is not sent at all.
  if (replay?.kind === "conflict" && !interceptEngine.isEnabled()) {
    throw replayConflictError()
  }
  const outcome = await interceptEngine.interceptRequest(request)
  if (replay?.kind === "conflict" && !outcome.held) throw replayConflictError()
  if (owner) recordDecision(owner, request, outcome)
  return { body: outcome.body, snapshot: outcome.requestSnapshot }
}

/**
 * Hold, pass through, or replay one upstream request, send it, and hold its
 * response unless an enclosing `interceptLogicalSend` owns the response.
 * `send` receives the body to send instead of the original, or undefined to
 * send it unchanged. Request bodies that are not text (multipart uploads) are
 * never edited, but their responses are still held.
 */
export async function interceptUpstreamSend(
  request: UpstreamSend,
  send: (body: string | undefined) => Promise<Response>,
): Promise<Response> {
  if (isInterceptBypassed()) return await send(undefined)
  const owner = ownerStorage.getStore()
  const sent: SentRequest = { ...request }
  const { body: requestBody } = request
  if (
    typeof requestBody === "string"
    && (owner?.decision || interceptEngine.isEnabled())
  ) {
    const decided = await bodyToSend(owner, { ...request, body: requestBody })
    sent.body = decided.body
    sent.snapshot = decided.snapshot
  }
  const body = sent.body === requestBody ? undefined : (sent.body as string)
  if (owner) {
    // Recorded even while Intercept is off, so turning it on mid-send still
    // attributes the settled response to the attempt that produced it.
    owner.last = sent
    return await send(body)
  }
  if (!interceptEngine.isEnabled()) return await send(body)
  return await holdResponse(sent, await send(body))
}

/**
 * Own one logical request: sends inside `work` share the first send's
 * decision and never hold their responses, so intermediate ones (failover
 * 429s, compatibility 400s, overloaded streams) reach the retry loop
 * untouched, and only the response `work` finally returns is held. Work
 * deferred with `deferUntilResponseDecided` then runs on the response the
 * operator let through. The owner exists even while Intercept is off, so
 * turning it on mid-loop still holds only the settled response. Nested
 * owners defer to the outermost.
 */
export async function interceptLogicalSend<T extends { response: Response }>(
  work: () => Promise<T>,
): Promise<T> {
  if (ownerStorage.getStore()) return await work()
  const owner: SendOwner = { decisionBytes: 0, settle: new Map() }
  let result: T
  try {
    result = await ownerStorage.run(owner, work)
  } finally {
    // Retries are over: let go of the approval before its reservation.
    owner.decision = undefined
    releaseDebugCaptureMemory(owner.decisionBytes)
    owner.decisionBytes = 0
  }
  let { response } = result
  if (owner.last) response = await holdResponse(owner.last, response)
  for (const settle of owner.settle.values()) response = await settle(response)
  return response === result.response ? result : { ...result, response }
}
