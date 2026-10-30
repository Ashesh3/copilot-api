import { createHash } from "node:crypto"

import { readConnectionOwnershipRejection } from "./connection-ownership"

/**
 * Copilot issues every output item an opaque ID bound to the account that
 * produced it, and refuses a replayed ID it cannot verify with "input item ID
 * does not belong to this connection". An ID only names an item whose content
 * is replayed with it, so it can be removed without losing conversation state.
 */

type ReplayedItem = Record<string, unknown> & { id: string }

const MAX_REMEMBERED_REFUSALS = 4096
// Keyed by account and ID fingerprint, like refused reasoning state.
const refusedItemIds = new Set<string>()
const ITEM_ID_REFUSAL = /\binput item id does not belong to this connection\b/u
const ITEM_STATE_REFUSAL = /\binput item does not belong to this connection\b/u
const MISMATCH_CODE = "input_item_connection_mismatch"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fingerprint(id: string): string {
  return createHash("sha256").update(id).digest("base64url")
}

function accountItemKey(account: string, value: string): string {
  return `${account}:${value}`
}

/**
 * Codex replays only IDs of the form `prefix_suffix` and drops the others
 * before sending history. Copilot's opaque IDs have no such prefix.
 */
export function isPrefixedItemId(id: string): boolean {
  const separator = id.indexOf("_")
  return separator > 0 && separator < id.length - 1
}

// An item reference is nothing but its ID, so its ID always stays.
function replayedItems(items: Array<unknown>): Array<ReplayedItem> {
  return items.filter(
    (item): item is ReplayedItem =>
      isRecord(item)
      && item.type !== "item_reference"
      && typeof item.id === "string"
      && item.id.length > 0,
  )
}

function inputItems(body: Record<string, unknown>): Array<unknown> {
  return Array.isArray(body.input) ? body.input : []
}

/** Remove the replayed IDs `select` picks, returning their fingerprints. */
export function stripItemIds(
  body: Record<string, unknown>,
  select: (id: string, value: string) => boolean = () => true,
): Array<string> {
  const removed: Array<string> = []
  for (const item of replayedItems(inputItems(body))) {
    const value = fingerprint(item.id)
    if (!select(item.id, value)) continue
    removed.push(value)
    Reflect.deleteProperty(item, "id")
  }
  return removed
}

/** Drop the IDs Codex itself would not replay, as it does on HTTP. */
export function omitUnprefixedItemIds(items: Array<unknown>): number {
  let omitted = 0
  for (const item of replayedItems(items)) {
    if (isPrefixedItemId(item.id)) continue
    Reflect.deleteProperty(item, "id")
    omitted += 1
  }
  return omitted
}

/** Remove IDs the destination account already refused. */
export function omitRefusedItemIds(
  body: Record<string, unknown>,
  account: string,
): number {
  if (refusedItemIds.size === 0) return 0
  return stripItemIds(body, (_id, value) =>
    refusedItemIds.has(accountItemKey(account, value)),
  ).length
}

export function rememberRefusedItemIds(
  account: string,
  fingerprints: Iterable<string>,
): void {
  for (const value of fingerprints) {
    const key = accountItemKey(account, value)
    refusedItemIds.delete(key)
    if (refusedItemIds.size >= MAX_REMEMBERED_REFUSALS) {
      const oldest = refusedItemIds.values().next()
      if (!oldest.done) refusedItemIds.delete(oldest.value)
    }
    refusedItemIds.add(key)
  }
}

export function resetRefusedItemIdsForTest(): void {
  refusedItemIds.clear()
}

/**
 * Whether Copilot refused a replayed item ID. A bare mismatch code that does
 * not name item state is read as an ID refusal too, since removing IDs is
 * free; refused item state has its own recovery.
 */
export async function isItemIdOwnershipRejection(
  response: Response,
): Promise<boolean> {
  if (response.status !== 400) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.clone().text()) as unknown
  } catch {
    return false
  }
  const text = readConnectionOwnershipRejection(parsed)
  if (text === undefined) return false
  if (ITEM_ID_REFUSAL.test(text)) return true
  return (
    isRecord(parsed)
    && isRecord(parsed.error)
    && parsed.error.code === MISMATCH_CODE
    && !ITEM_STATE_REFUSAL.test(text)
  )
}
