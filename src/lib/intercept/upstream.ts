import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import type { UpstreamSendReason } from "~/lib/routing-telemetry"

import {
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"
import { replaceModelFallbackResponse } from "~/lib/model-fallback"
import { getClientSessionId } from "~/lib/request-session"

import { isInterceptBypassed } from "./assistant"
import { type InterceptRequestSnapshot, interceptEngine } from "./engine"
import { replayConflictError } from "./items"

/**
 * Intercept sees individual upstream sends, but one logical request can be
 * sent several times: account failover, compatibility, payload, and HTTP
 * retries. The layer that owns such a retry loop runs it inside
 * `interceptLogicalSend`, which keeps the operator's view to one decision:
 *
 * - The first send is held (or passed through) and its decision recorded.
 *   Resends of that request, to the same destination, replay the decision
 *   instead of being held again, even if Intercept was turned off meanwhile.
 * - Sends never hold their own responses; the owner holds only the response
 *   the loop settles on.
 */

type JsonPath = Array<string | number>

/** One change from the original to the approved body, with its precondition. */
interface JsonChange {
  path: JsonPath
  before?: { value: unknown }
  after?: { value: unknown }
}

/**
 * An array on the path to an edit, by digest: index-based edits replay only
 * while that array is unchanged, so an index still names the same element.
 */
interface ArrayGuard {
  path: JsonPath
  digest: string
}

/** The decision on the first send of a logical request. */
interface Decision {
  path: string
  upstream: "copilot" | "custom"
  providerId?: string
  original: string
  /** The body sent; the original when the request passed through unheld. */
  approved: string
  snapshot: InterceptRequestSnapshot
  /** Undefined when either body is not JSON: only exact resends replay. */
  edits?: { changes: Array<JsonChange>; guards: Array<ArrayGuard> }
}

type Replay =
  | { kind: "replay"; body: string; snapshot: InterceptRequestSnapshot }
  /** The resend differs where the operator edited; it needs a new review. */
  | { kind: "conflict" }

interface SentRequest {
  method: string
  path: string
  url: string
  upstream: "copilot" | "custom"
  providerId?: string
  snapshot: InterceptRequestSnapshot
  signal?: AbortSignal | null
}

interface SendOwner {
  decision?: Decision
  /** Capture memory held for the decision until the logical send ends. */
  reservedBytes: number
  last?: SentRequest
}

const ownerStorage = new AsyncLocalStorage<SendOwner>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return undefined
  }
}

function diffJson(original: unknown, approved: unknown): Array<JsonChange> {
  const changes: Array<JsonChange> = []
  const walk = (before: unknown, after: unknown, path: JsonPath): void => {
    if (isDeepStrictEqual(before, after)) return
    if (isRecord(before) && isRecord(after)) {
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        if (!Object.hasOwn(after, key)) {
          changes.push({ path: [...path, key], before: { value: before[key] } })
        } else if (!Object.hasOwn(before, key)) {
          changes.push({ path: [...path, key], after: { value: after[key] } })
        } else {
          walk(before[key], after[key], [...path, key])
        }
      }
      return
    }
    if (
      Array.isArray(before)
      && Array.isArray(after)
      && before.length === after.length
    ) {
      for (const [index, value] of before.entries()) {
        walk(value, after[index], [...path, index])
      }
      return
    }
    changes.push({ path, before: { value: before }, after: { value: after } })
  }
  walk(original, approved, [])
  return changes
}

/**
 * Apply `changes` to `target` only where it still holds exactly what the
 * operator changed; anything else means the resend differs where the
 * operator edited, and it must be reviewed again.
 */
function applyChanges(
  target: unknown,
  changes: Array<JsonChange>,
): { value: unknown } | undefined {
  let root = structuredClone(target)
  for (const change of changes) {
    if (change.path.length === 0) {
      if (!isDeepStrictEqual(root, change.before?.value)) return undefined
      root = structuredClone(change.after?.value)
      continue
    }
    let parent: unknown = root
    for (const key of change.path.slice(0, -1)) {
      parent =
        (
          (isRecord(parent) || Array.isArray(parent))
          && Object.hasOwn(parent, key)
        ) ?
          (parent as Record<string | number, unknown>)[key]
        : undefined
    }
    const key = change.path.at(-1) as string | number
    if (!isRecord(parent) && !Array.isArray(parent)) return undefined
    const container = parent as Record<string | number, unknown>
    const present = Object.hasOwn(container, key)
    if (
      change.before ?
        !present || !isDeepStrictEqual(container[key], change.before.value)
      : present
    ) {
      return undefined
    }
    if (change.after) {
      // A plain assignment to a `__proto__` key would replace the prototype.
      Object.defineProperty(container, key, {
        value: structuredClone(change.after.value),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    } else {
      Reflect.deleteProperty(container, key)
    }
  }
  return { value: root }
}

function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

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

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** The value at `path`, following own properties only. */
function valueAt(
  root: unknown,
  path: JsonPath,
): { value: unknown } | undefined {
  let current: unknown = root
  for (const key of path) {
    if (
      (!isRecord(current) && !Array.isArray(current))
      || !Object.hasOwn(current, key)
    ) {
      return undefined
    }
    current = (current as Record<string | number, unknown>)[key]
  }
  return { value: current }
}

function arrayGuards(
  original: unknown,
  changes: Array<JsonChange>,
): Array<ArrayGuard> {
  const guards = new Map<string, ArrayGuard>()
  for (const change of changes) {
    for (const [index, key] of change.path.entries()) {
      if (typeof key !== "number") continue
      const path = change.path.slice(0, index)
      const id = JSON.stringify(path)
      const array = valueAt(original, path)
      if (!guards.has(id) && array) {
        guards.set(id, { path, digest: digestJson(array.value) })
      }
    }
  }
  return [...guards.values()]
}

/** Edits from the original to the approved body; undefined when not JSON. */
function approvalEdits(original: string, approved: string): Decision["edits"] {
  if (approved === original) return { changes: [], guards: [] }
  const before = parseJson(original)
  const after = parseJson(approved)
  if (!before || !after) return undefined
  const changes = diffJson(before.value, after.value)
  return { changes, guards: arrayGuards(before.value, changes) }
}

function recordDecision(
  owner: SendOwner,
  request: TextSend,
  outcome: { body: string; requestSnapshot: InterceptRequestSnapshot },
): void {
  const approved = outcome.body
  let edits = approvalEdits(request.body, approved)
  // The bodies are shared with the held item and the send; only the edit set
  // is new. Without room for it, only exact resends replay the approval.
  const bytes = edits ? textBytes(JSON.stringify(edits)) : 0
  if (reserveDebugCaptureMemory(bytes)) owner.reservedBytes += bytes
  else edits = undefined
  owner.decision = {
    path: request.path,
    upstream: request.upstream,
    providerId: request.providerId,
    original: request.body,
    approved,
    snapshot: outcome.requestSnapshot,
    edits,
  }
}

/** Apply the operator's edits to a changed resend, or report a conflict. */
function replayEdits(decision: Decision, body: string): Replay {
  const parsed = decision.edits && parseJson(body)
  if (!decision.edits || !parsed) return { kind: "conflict" }
  for (const guard of decision.edits.guards) {
    const array = valueAt(parsed.value, guard.path)
    if (!array || digestJson(array.value) !== guard.digest) {
      return { kind: "conflict" }
    }
  }
  const replayed = applyChanges(parsed.value, decision.edits.changes)
  if (!replayed) return { kind: "conflict" }
  const replayedBody = JSON.stringify(replayed.value)
  return {
    kind: "replay",
    body: replayedBody,
    snapshot: { ...decision.snapshot, body: replayedBody },
  }
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
  if (request.body === decision.original) {
    return {
      kind: "replay",
      body: decision.approved,
      snapshot: decision.snapshot,
    }
  }
  if (decision.approved === decision.original) {
    return {
      kind: "replay",
      body: request.body,
      snapshot: { ...decision.snapshot, body: request.body },
    }
  }
  return replayEdits(decision, request.body)
}

async function decideRequest(
  owner: SendOwner | undefined,
  request: TextSend,
): Promise<{ body: string; snapshot: InterceptRequestSnapshot }> {
  const outcome = await interceptEngine.interceptRequest(request)
  if (owner) recordDecision(owner, request, outcome)
  return { body: outcome.body, snapshot: outcome.requestSnapshot }
}

async function holdResponse(
  sent: SentRequest,
  response: Response,
): Promise<Response> {
  const held = await interceptEngine.interceptResponse({
    method: sent.method,
    path: sent.path,
    url: sent.url,
    upstream: sent.upstream,
    providerId: sent.providerId,
    response,
    requestSnapshot: sent.snapshot,
    signal: sent.signal,
  })
  if (held !== response) replaceModelFallbackResponse(response, held)
  return held
}

function binarySnapshot(request: UpstreamSend): InterceptRequestSnapshot {
  return {
    method: request.method,
    path: request.path,
    model: request.model,
    body: "",
    headers: {},
    sessionId: getClientSessionId(),
  }
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
  const { body: requestBody } = request
  const textRequest =
    typeof requestBody === "string" ?
      { ...request, body: requestBody }
    : undefined
  const replay = textRequest && replayDecision(owner, textRequest)
  if (replay?.kind !== "replay" && !interceptEngine.isEnabled()) {
    // An approved request must not go out without the operator's edits.
    if (replay?.kind === "conflict") throw replayConflictError()
    return await send(undefined)
  }

  let decided: { body: string | undefined; snapshot: InterceptRequestSnapshot }
  if (replay?.kind === "replay") decided = replay
  else if (textRequest) decided = await decideRequest(owner, textRequest)
  else decided = { body: undefined, snapshot: binarySnapshot(request) }
  const body = decided.body === requestBody ? undefined : decided.body

  const sent: SentRequest = { ...request, snapshot: decided.snapshot }
  if (owner) {
    owner.last = sent
    return await send(body)
  }
  return await holdResponse(sent, await send(body))
}

/**
 * Own one logical request: sends inside `work` share the first send's
 * decision and never hold their responses, so intermediate ones (failover
 * 429s, compatibility 400s, overloaded streams) reach the retry loop
 * untouched, and only the response `work` finally returns is held. The owner
 * exists even while Intercept is off, so turning it on mid-loop still holds
 * only the settled response. Nested owners defer to the outermost.
 */
export async function interceptLogicalSend<T extends { response: Response }>(
  work: () => Promise<T>,
): Promise<T> {
  if (ownerStorage.getStore()) return await work()
  const owner: SendOwner = { reservedBytes: 0 }
  let result: T
  try {
    result = await ownerStorage.run(owner, work)
  } finally {
    releaseDebugCaptureMemory(owner.reservedBytes)
    owner.reservedBytes = 0
  }
  if (!owner.last) return result
  return {
    ...result,
    response: await holdResponse(owner.last, result.response),
  }
}
