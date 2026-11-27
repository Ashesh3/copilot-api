import { AsyncLocalStorage } from "node:async_hooks"
import { isDeepStrictEqual } from "node:util"

import type { UpstreamSendReason } from "~/lib/routing-telemetry"

import { getClientSessionId } from "~/lib/request-session"

import {
  approvalStorage,
  type JsonChange,
  type JsonPath,
  runWithInterceptApprovals,
} from "./approvals"
import { isInterceptBypassed } from "./assistant"
import { type InterceptRequestSnapshot, interceptEngine } from "./engine"

/**
 * Intercept at the upstream boundary sees individual sends, but one logical
 * request can be sent several times: transport retries, account failover,
 * compatibility and payload retries. Two scopes keep the operator's view to
 * one decision per logical request:
 *
 * - Approvals (per inbound request): a held request's decision is replayed on
 *   its resends instead of holding it again.
 * - Send owners (per retry loop): sends inside an owner never hold their
 *   response; the owner holds only the final one it returns.
 */

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
        if (!(key in after)) {
          changes.push({ path: [...path, key], before: { value: before[key] } })
        } else if (!(key in before)) {
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
        isRecord(parent) || Array.isArray(parent) ?
          (parent as Record<string | number, unknown>)[key]
        : undefined
    }
    const key = change.path.at(-1) as string | number
    if (!isRecord(parent) && !Array.isArray(parent)) return undefined
    const container = parent as Record<string | number, unknown>
    const present = key in container
    if (
      change.before ?
        !present || !isDeepStrictEqual(container[key], change.before.value)
      : present
    ) {
      return undefined
    }
    if (change.after) container[key] = structuredClone(change.after.value)
    else Reflect.deleteProperty(container, key)
  }
  return { value: root }
}

function recordApproval(
  request: { path: string; body: string },
  approved: string,
  snapshot: InterceptRequestSnapshot,
): void {
  const approvals = approvalStorage.getStore()
  if (!approvals) return
  const before = parseJson(request.body)
  const after = parseJson(approved)
  approvals.push({
    path: request.path,
    original: request.body,
    approved,
    snapshot,
    changes: before && after ? diffJson(before.value, after.value) : undefined,
  })
}

/** The approved body for a resend, or undefined when it needs a new review. */
function replayApproval(request: {
  path: string
  body: string
  reason?: UpstreamSendReason
}): { body: string; snapshot: InterceptRequestSnapshot } | undefined {
  const approvals = approvalStorage.getStore() ?? []
  const exact = approvals.findLast(
    (approval) =>
      approval.path === request.path && approval.original === request.body,
  )
  if (exact) return { body: exact.approved, snapshot: exact.snapshot }
  // Only a resend of the same logical request inherits its approval; a new
  // request (another tool-loop round, a fallback model) is reviewed anew.
  if (!request.reason || request.reason === "initial") return undefined
  const latest = approvals.findLast(
    (approval) => approval.path === request.path,
  )
  const parsed = latest?.changes && parseJson(request.body)
  if (!latest?.changes || !parsed) return undefined
  const replayed = applyChanges(parsed.value, latest.changes)
  if (!replayed) return undefined
  const body = JSON.stringify(replayed.value)
  return { body, snapshot: { ...latest.snapshot, body } }
}

export interface UpstreamSend {
  method: string
  path: string
  url: string
  upstream: "copilot" | "custom"
  providerId?: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal | null
  reason?: UpstreamSendReason
}

async function decideRequest(
  request: UpstreamSend & { body: string },
): Promise<{ body: string | undefined; snapshot: InterceptRequestSnapshot }> {
  const replayed = replayApproval(request)
  if (replayed) {
    return {
      body: replayed.body === request.body ? undefined : replayed.body,
      snapshot: replayed.snapshot,
    }
  }
  const outcome = await interceptEngine.interceptRequest(request)
  if (outcome.held) {
    recordApproval(request, outcome.body, outcome.requestSnapshot)
  }
  return {
    body: outcome.modified ? outcome.body : undefined,
    snapshot: outcome.requestSnapshot,
  }
}

async function holdResponse(
  sent: SentRequest,
  response: Response,
): Promise<Response> {
  return await interceptEngine.interceptResponse({
    method: sent.method,
    path: sent.path,
    url: sent.url,
    upstream: sent.upstream,
    providerId: sent.providerId,
    response,
    requestSnapshot: sent.snapshot,
    signal: sent.signal,
  })
}

/**
 * Hold or replay one upstream request, send it, and hold its response unless
 * an enclosing `interceptLogicalSend` owns the response. `send` receives the
 * body to send instead of the original, or undefined to send it unchanged.
 * Request bodies that are not text (multipart uploads) are never edited, but
 * their responses are still held.
 */
export async function interceptUpstreamSend(
  request: UpstreamSend,
  send: (body: string | undefined) => Promise<Response>,
): Promise<Response> {
  if (!interceptEngine.isEnabled() || isInterceptBypassed()) {
    return await send(undefined)
  }
  const { body: requestBody } = request
  const decided =
    typeof requestBody === "string" ?
      await decideRequest({ ...request, body: requestBody })
    : {
        body: undefined,
        snapshot: {
          method: request.method,
          path: request.path,
          body: "",
          headers: {},
          sessionId: getClientSessionId(),
        },
      }
  const sent: SentRequest = { ...request, snapshot: decided.snapshot }
  const owner = ownerStorage.getStore()
  if (owner) {
    owner.last = sent
    return await send(decided.body)
  }
  return await holdResponse(sent, await send(decided.body))
}

/**
 * Own the responses of a retry loop: sends inside `work` never hold their
 * responses, so intermediate ones (failover 429s, compatibility 400s) reach
 * the loop untouched, and only the response `work` finally returns is held.
 * Nested owners defer to the outermost. Outside an inbound request (direct
 * service calls) the owner also scopes approvals, so its resends replay.
 */
export async function interceptLogicalSend<T extends { response: Response }>(
  work: () => Promise<T>,
): Promise<T> {
  if (!interceptEngine.isEnabled() || ownerStorage.getStore()) {
    return await work()
  }
  const owner: SendOwner = {}
  const ownedWork = async () => await ownerStorage.run(owner, work)
  const result =
    approvalStorage.getStore() ?
      await ownedWork()
    : await runWithInterceptApprovals(ownedWork)
  if (!owner.last) return result
  return {
    ...result,
    response: await holdResponse(owner.last, result.response),
  }
}
