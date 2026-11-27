import { AsyncLocalStorage } from "node:async_hooks"

import type { InterceptRequestSnapshot } from "./engine"

export type JsonPath = Array<string | number>

/** One change from the original to the approved body, with its precondition. */
export interface JsonChange {
  path: JsonPath
  before?: { value: unknown }
  after?: { value: unknown }
}

/**
 * An array on the path to an edit, by digest: index-based edits replay only
 * while that array is unchanged, so an index still names the same element.
 */
export interface ArrayGuard {
  path: JsonPath
  digest: string
}

/** The decision on the first send of a logical request. */
export interface Decision {
  path: string
  upstream: "copilot" | "custom"
  providerId?: string
  /** The request passed through unheld; its resends do too. */
  passThrough: boolean
  originalDigest: string
  /** The approved body, when capture memory could hold it. */
  approved?: string
  /** Undefined when not JSON or not held: such resends replay only exactly. */
  edits?: { changes: Array<JsonChange>; guards: Array<ArrayGuard> }
}

/** A send whose response the owner may hold; its snapshot is built on demand. */
export interface SentRequest {
  method: string
  path: string
  url: string
  upstream: "copilot" | "custom"
  providerId?: string
  model?: string
  body: unknown
  snapshot?: InterceptRequestSnapshot
  signal?: AbortSignal | null
}

type Settle = (response: Response) => Promise<Response>

export interface SendOwner {
  decision?: Decision
  /** Capture memory reserved for the decision until it is replaced or ends. */
  decisionBytes: number
  last?: SentRequest
  /** Work that must see the response the operator lets through. */
  settle: Map<object, Settle>
}

export const ownerStorage = new AsyncLocalStorage<SendOwner>()

/**
 * Defer `settle` until the final response of the current logical send is
 * decided, so durable bookkeeping never records a response the operator drops
 * or edits. A later registration with the same key replaces an earlier one,
 * since only the settled attempt counts. Returns false outside a logical send.
 */
export function deferUntilResponseDecided(
  key: object,
  settle: Settle,
): boolean {
  const owner = ownerStorage.getStore()
  if (!owner) return false
  owner.settle.set(key, settle)
  return true
}
