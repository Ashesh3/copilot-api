import {
  addUsageTokenCount,
  normalizeUsageTokenCount,
} from "~/lib/storage/usage-counters"

import { isRecord } from "./tool-context"

function sumCounter(first: unknown, next: unknown): number | null {
  const subtotal = normalizeUsageTokenCount(first)
  const increment = normalizeUsageTokenCount(next)
  if (increment === null) return subtotal
  if (subtotal === null) return increment
  return addUsageTokenCount(subtotal, increment).total
}

function snapshotCounter(first: unknown, next: unknown): number | null {
  return normalizeUsageTokenCount(next) ?? normalizeUsageTokenCount(first)
}

function mergeUsageField(
  key: string,
  values: { first: unknown; next: unknown },
  replace: boolean,
): unknown {
  const { first, next } = values
  if (first === undefined && next === undefined) return undefined
  // The three wire dialects share these counter names, including nested details.
  if (key.endsWith("_tokens") || key.endsWith("_requests"))
    return replace ? snapshotCounter(first, next) : sumCounter(first, next)
  if (
    key.endsWith("_tokens_details")
    || key === "cache_creation"
    || key === "server_tool_use"
  )
    return mergeUsage(first, next, replace) ?? null
  if (isRecord(next)) return mergeUsage(first, next, replace)
  if (next === undefined)
    return isRecord(first) ? mergeUsage(first, undefined, replace) : first
  // Preserve the existing merge behavior for ordinary provider metadata.
  if (!replace && typeof next === "number")
    return (typeof first === "number" ? first : 0) + next
  return next
}

/** Unknown counters stay null; invalid increments cannot erase measured usage. */
function mergeUsage(
  first: unknown,
  next: unknown,
  replace: boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(first) && !isRecord(next)) return undefined
  const previous = isRecord(first) ? first : {}
  const incoming = isRecord(next) ? next : {}
  const merged: Record<string, unknown> = {}
  for (const key of new Set([
    ...Object.keys(previous),
    ...Object.keys(incoming),
  ])) {
    const value = mergeUsageField(
      key,
      { first: previous[key], next: incoming[key] },
      replace,
    )
    if (value !== undefined) merged[key] = value
  }
  return merged
}

/** Combine distinct upstream rounds without losing measured counter subtotals. */
export function sumUsage(
  first: unknown,
  next: unknown,
): Record<string, unknown> | undefined {
  return mergeUsage(first, next, false)
}

/** Replace valid same-round snapshots; invalid updates retain prior measurements. */
export function updateUsageSnapshot(
  first: unknown,
  next: unknown,
): Record<string, unknown> | undefined {
  return mergeUsage(first, next, true)
}
