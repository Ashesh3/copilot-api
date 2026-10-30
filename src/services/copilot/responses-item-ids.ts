/**
 * Copilot issues every output item an opaque ID bound to the account that
 * produced it, and refuses a replayed ID it cannot verify with "input item ID
 * does not belong to this connection". Codex never replays such IDs, and the
 * gateway's own continuation snapshots follow the same rule.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Codex replays only IDs of the form `prefix_suffix` and drops the others
 * before sending history. Copilot's opaque IDs have no such prefix.
 */
export function isPrefixedItemId(id: string): boolean {
  const separator = id.indexOf("_")
  return separator > 0 && separator < id.length - 1
}

// An item reference, or reasoning without its state, is only its ID.
function isReferenceOnly(item: Record<string, unknown>): boolean {
  return (
    item.type === "item_reference"
    || (item.type === "reasoning" && typeof item.encrypted_content !== "string")
  )
}

/** Drop the IDs Codex itself would not replay, as it does on HTTP. */
export function omitUnprefixedItemIds(items: Array<unknown>): number {
  let omitted = 0
  for (const item of items) {
    if (!isRecord(item) || isReferenceOnly(item)) continue
    if (typeof item.id !== "string" || item.id.length === 0) continue
    if (isPrefixedItemId(item.id)) continue
    Reflect.deleteProperty(item, "id")
    omitted += 1
  }
  return omitted
}
