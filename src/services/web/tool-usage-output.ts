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

function mergeUsageField(key: string, first: unknown, next: unknown): unknown {
  if (first === undefined && next === undefined) return undefined
  // The three wire dialects share these counter names, including nested details.
  if (key.endsWith("_tokens") || key.endsWith("_requests"))
    return sumCounter(first, next)
  if (
    key.endsWith("_tokens_details")
    || key === "cache_creation"
    || key === "server_tool_use"
  )
    return sumUsage(first, next) ?? null
  if (isRecord(next)) return sumUsage(first, next)
  if (next === undefined)
    return isRecord(first) ? sumUsage(first, undefined) : first
  // Preserve the existing merge behavior for ordinary provider metadata.
  if (typeof next === "number")
    return (typeof first === "number" ? first : 0) + next
  return next
}

/** Unknown counters stay null; invalid increments cannot erase measured usage. */
export function sumUsage(
  first: unknown,
  next: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(first) && !isRecord(next)) return undefined
  const previous = isRecord(first) ? first : {}
  const incoming = isRecord(next) ? next : {}
  const merged: Record<string, unknown> = {}
  for (const key of new Set([
    ...Object.keys(previous),
    ...Object.keys(incoming),
  ])) {
    const value = mergeUsageField(key, previous[key], incoming[key])
    if (value !== undefined) merged[key] = value
  }
  return merged
}
