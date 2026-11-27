import { AsyncLocalStorage } from "node:async_hooks"

import type { InterceptRequestSnapshot } from "./engine"

export type JsonPath = Array<string | number>

/** One change from the original to the approved body, with its precondition. */
export interface JsonChange {
  path: JsonPath
  before?: { value: unknown }
  after?: { value: unknown }
}

/** An operator's decision on a held request, replayed on its resends. */
export interface Approval {
  path: string
  original: string
  approved: string
  snapshot: InterceptRequestSnapshot
  /** Undefined when either body is not JSON: only exact resends replay. */
  changes?: Array<JsonChange>
}

export const approvalStorage = new AsyncLocalStorage<Array<Approval>>()

/**
 * Scope one inbound request (or WebSocket turn) for approval replay. Kept
 * free of runtime imports so request setup can use it without loading the
 * Intercept engine.
 */
export function runWithInterceptApprovals<T>(work: () => T): T {
  return approvalStorage.run([], work)
}
