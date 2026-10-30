/**
 * Copilot can refuse long-lived prompt caching (a `cache_control` ttl other
 * than 5m) for an account. Clients such as Claude Code keep asking for it
 * once configured, so after an account refuses, requests to that account
 * send the default lifetime instead of failing every time.
 */
const DEFAULT_CACHE_TTL = "5m"
const MAX_CACHE_CONTROL_DEPTH = 16

// Account scopes (see copilotAccountScope) that refused long-lived caching.
const refusingScopes = new Set<string>()

export function rememberExtendedCacheTtlRefusal(scope: string): void {
  refusingScopes.add(scope)
}

export function refusesExtendedCacheTtl(scope: string): boolean {
  return refusingScopes.has(scope)
}

export function resetExtendedCacheTtlRefusalForTest(): void {
  refusingScopes.clear()
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
