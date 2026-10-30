/**
 * Copilot can refuse long-lived prompt caching (a `cache_control` ttl other
 * than 5m) for an account. Clients such as Claude Code keep asking for it
 * once configured, so after an account refuses, requests to that account
 * send the default lifetime for an hour instead of failing every time. The
 * refusal expires so an account that gains long-lived caching uses it again.
 */
const DEFAULT_CACHE_TTL = "5m"
const MAX_CACHE_CONTROL_DEPTH = 16
const REFUSAL_MEMORY_MS = 60 * 60 * 1000
// Tool inputs and schemas are data the client sent, not request controls.
const DATA_KEYS = new Set(["input", "input_schema"])

// When each refusing account scope (see copilotAccountScope) may ask again.
const refusalExpiry = new Map<string, number>()

export function rememberExtendedCacheTtlRefusal(
  scope: string,
  now = Date.now(),
): void {
  refusalExpiry.set(scope, now + REFUSAL_MEMORY_MS)
}

export function refusesExtendedCacheTtl(
  scope: string,
  now = Date.now(),
): boolean {
  const expiry = refusalExpiry.get(scope)
  if (expiry === undefined) return false
  if (now < expiry) return true
  refusalExpiry.delete(scope)
  return false
}

export function resetExtendedCacheTtlRefusalForTest(): void {
  refusalExpiry.clear()
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
  for (const [key, nested] of Object.entries(value)) {
    if (!DATA_KEYS.has(key)) visitCacheControls(nested, visit, depth + 1)
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
