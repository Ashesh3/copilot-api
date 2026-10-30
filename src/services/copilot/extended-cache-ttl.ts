/**
 * Copilot can refuse long-lived prompt caching (a `cache_control` ttl other
 * than 5m) for an account. Clients such as Claude Code keep asking for it
 * once configured, so after an account refuses, requests to that account
 * send the default lifetime for an hour instead of failing every time. The
 * refusal expires so an account that gains long-lived caching uses it again.
 */
const DEFAULT_CACHE_TTL = "5m"
const REFUSAL_MEMORY_MS = 60 * 60 * 1000

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

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => isRecord(item)) : []
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

type CacheControlVisitor = (cacheControl: { ttl: unknown }) => void

function visitControl(
  owner: Record<string, unknown>,
  visit: CacheControlVisitor,
) {
  if (isExtendedCacheControl(owner.cache_control)) visit(owner.cache_control)
}

/** A content block's breakpoint, and those of a tool result's own blocks. */
function visitBlock(
  block: Record<string, unknown>,
  visit: CacheControlVisitor,
) {
  visitControl(block, visit)
  if (block.type !== "tool_result") return
  for (const nested of records(block.content)) visitControl(nested, visit)
}

/**
 * Visit only the places Messages reads `cache_control`: the request itself,
 * system blocks, tools, and message content blocks, including a tool
 * result's blocks. Tool inputs, schemas and examples are client data and are
 * never touched.
 */
function visitCacheControls(
  body: Record<string, unknown>,
  visit: CacheControlVisitor,
): void {
  visitControl(body, visit)
  for (const block of records(body.system)) visitBlock(block, visit)
  for (const tool of records(body.tools)) visitControl(tool, visit)
  for (const message of records(body.messages)) {
    for (const block of records(message.content)) visitBlock(block, visit)
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
