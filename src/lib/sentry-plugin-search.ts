import {
  containsCodexPluginCategoryReference,
  containsCodexPluginSearchReference,
  sanitizeCodexPluginSearchDiagnosticQuery,
  sanitizeRequestDiagnosticReference,
} from "~/lib/request-diagnostics"

const MAX_DEPTH = 64
const OPAQUE_FIELDS = new Set([
  "upstreamResponseBody",
  "upstreamResponseBodyBytes",
  "upstreamResponseContentType",
])

interface OwnDataEntry {
  key: string
  value: unknown
}

interface ScrubContext {
  inheritedPluginSearchContext: boolean
  seen: WeakMap<object, boolean>
}

const QUERY_STRING_KEYS = new Set([
  "http.query",
  "query",
  "query_string",
  "url.query",
])
const PRIVATE_QUERY_KEYS = new Set(["pagetoken", "q"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function inspectOwnDataEntries(value: Record<string, unknown>): {
  complete: boolean
  entries: Array<OwnDataEntry>
} {
  const entries: Array<OwnDataEntry> = []
  let keys: Array<string>
  try {
    keys = Object.keys(value)
  } catch {
    return { complete: false, entries }
  }
  for (const key of keys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) return { complete: false, entries }
      if (!Object.hasOwn(descriptor, "value")) continue
      entries.push({ key, value: descriptor.value })
    } catch {
      return { complete: false, entries }
    }
  }
  return { complete: true, entries }
}

function setOwnDataValue(
  owner: Record<string, unknown>,
  key: string,
  value: string,
): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return false
    if (descriptor.writable || descriptor.configurable) {
      Object.defineProperty(owner, key, { ...descriptor, value })
      return true
    }
    return Object.is(descriptor.value, value)
  } catch {
    return false
  }
}

function hasLocalContext(entries: ReadonlyArray<OwnDataEntry>): boolean {
  return entries.some(
    ({ key, value }) =>
      !OPAQUE_FIELDS.has(key)
      && typeof value === "string"
      && (containsCodexPluginSearchReference(value)
        || containsCodexPluginCategoryReference(value)),
  )
}

function scrubString(
  key: string,
  value: string,
  inheritedContext: boolean,
): string {
  const isPrivatePluginQuery =
    inheritedContext
    || containsCodexPluginSearchReference(value)
    || containsCodexPluginCategoryReference(value)
  if (!isPrivatePluginQuery) return value
  if (QUERY_STRING_KEYS.has(key.toLowerCase())) {
    return sanitizeCodexPluginSearchDiagnosticQuery(value)
  }
  return sanitizeRequestDiagnosticReference("GET", value)
}

// eslint-disable-next-line complexity -- descriptor checks make hostile query containers fail closed
function scrubQueryContainer(value: unknown): boolean {
  if (typeof value === "string") return true
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      if (typeof entry[0] !== "string") continue
      if (!PRIVATE_QUERY_KEYS.has(entry[0].toLowerCase())) continue
      if (
        !setOwnDataValue(
          entry as unknown as Record<string, unknown>,
          "1",
          "[REDACTED]",
        )
      ) {
        return false
      }
    }
    return true
  }
  if (!isRecord(value)) return true
  let keys: Array<string>
  try {
    keys = Object.keys(value)
  } catch {
    return false
  }
  for (const key of keys) {
    if (!PRIVATE_QUERY_KEYS.has(key.toLowerCase())) continue
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return false
    } catch {
      return false
    }
  }
  const inspected = inspectOwnDataEntries(value)
  let safe = inspected.complete
  for (const { key, value: queryValue } of inspected.entries) {
    if (!PRIVATE_QUERY_KEYS.has(key.toLowerCase())) continue
    void queryValue
    if (!setOwnDataValue(value, key, "[REDACTED]")) safe = false
  }
  return safe
}

// eslint-disable-next-line complexity -- fail-closed traversal handles hostile query containers
function scrubRecord(
  value: unknown,
  context: ScrubContext,
  depth = 0,
): boolean {
  if (!isRecord(value)) return true
  if (depth > MAX_DEPTH) return false
  const seenInContext = context.seen.get(value)
  if (
    seenInContext === true
    || (seenInContext === false && !context.inheritedPluginSearchContext)
  ) {
    return true
  }
  context.seen.set(value, context.inheritedPluginSearchContext)

  const inspected = inspectOwnDataEntries(value)
  let safe = inspected.complete
  const localContext =
    context.inheritedPluginSearchContext || hasLocalContext(inspected.entries)
  if (localContext) context.seen.set(value, true)

  for (const { key, value: nestedValue } of inspected.entries) {
    if (OPAQUE_FIELDS.has(key)) continue
    if (localContext && QUERY_STRING_KEYS.has(key.toLowerCase())) {
      if (typeof nestedValue === "string") {
        const scrubbed = sanitizeCodexPluginSearchDiagnosticQuery(nestedValue)
        if (
          scrubbed !== nestedValue
          && !setOwnDataValue(value, key, scrubbed)
        ) {
          safe = false
        }
      } else if (!scrubQueryContainer(nestedValue)) {
        safe = false
      }
      continue
    }
    if (typeof nestedValue === "string") {
      const scrubbed = scrubString(key, nestedValue, localContext)
      if (scrubbed !== nestedValue && !setOwnDataValue(value, key, scrubbed)) {
        safe = false
      }
      continue
    }
    if (
      !scrubRecord(
        nestedValue,
        {
          inheritedPluginSearchContext: localContext,
          seen: context.seen,
        },
        depth + 1,
      )
    ) {
      safe = false
    }
  }
  return safe
}

/** Returns false when hostile telemetry prevents complete fail-closed traversal. */
export function scrubCodexPluginSearchData(value: unknown): boolean {
  return scrubRecord(value, {
    inheritedPluginSearchContext: false,
    seen: new WeakMap<object, boolean>(),
  })
}
