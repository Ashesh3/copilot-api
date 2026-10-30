/**
 * Copilot can refuse long-lived prompt caching (a `cache_control` ttl other
 * than 5m) for an account. Clients such as Claude Code keep asking for it
 * once configured, so after a refusal this process sends the default
 * lifetime instead of failing every request.
 */
const DEFAULT_CACHE_TTL = "5m"
const MAX_CACHE_CONTROL_DEPTH = 16

let extendedCacheTtlRefused = false

export function rememberExtendedCacheTtlRefusal(): void {
  extendedCacheTtlRefused = true
}

export function refusesExtendedCacheTtl(): boolean {
  return extendedCacheTtlRefused
}

export function resetExtendedCacheTtlRefusalForTest(): void {
  extendedCacheTtlRefused = false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isExtendedCacheControl(value: unknown): value is {
  ttl: unknown
} {
  return (
    isRecord(value)
    && Object.hasOwn(value, "ttl")
    && value.ttl !== DEFAULT_CACHE_TTL
  )
}

function visitCacheControls(
  value: unknown,
  visit: (cacheControl: { ttl: unknown }) => void,
  depth = 0,
): void {
  if (depth > MAX_CACHE_CONTROL_DEPTH) return
  if (Array.isArray(value)) {
    for (const item of value) visitCacheControls(item, visit, depth + 1)
    return
  }
  if (!isRecord(value)) return
  if (isExtendedCacheControl(value.cache_control)) visit(value.cache_control)
  for (const nested of Object.values(value)) {
    visitCacheControls(nested, visit, depth + 1)
  }
}

export function hasExtendedCacheTtl(body: Record<string, unknown>): boolean {
  let found = false
  visitCacheControls(body, () => {
    found = true
  })
  return found
}

/** Drop every long-lived ttl so each breakpoint uses the default lifetime. */
export function removeExtendedCacheTtl(body: Record<string, unknown>): boolean {
  let removed = false
  visitCacheControls(body, (cacheControl) => {
    Reflect.deleteProperty(cacheControl, "ttl")
    removed = true
  })
  return removed
}
