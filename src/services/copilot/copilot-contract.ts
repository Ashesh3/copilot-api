import { Buffer } from "node:buffer"
import util from "node:util"

export const COPILOT_API_VERSION = "2026-08-01"
export const DEFAULT_COPILOT_INTEGRATION_ID = "vscode-chat"

const MAX_INTEGRATION_ID_LENGTH = 128
const MAX_SAFE_RESPONSE_HEADER_VALUE_LENGTH = 8 * 1024

const SAFE_RESPONSE_HEADERS = new Set([
  "retry-after",
  "x-copilot-api-exp-assignment-context",
  "x-copilot-service-request-id",
  "x-github-copilot-request-te",
  "x-github-request-id",
])
const SAFE_RESPONSE_PREFIXES = ["x-quota-snapshot-", "x-usage-ratelimit-"]
const HEADERS_ENTRIES = Object.getOwnPropertyDescriptor(
  Headers.prototype,
  "entries",
)?.value as (() => IterableIterator<[string, string]>) | undefined

export function sanitizeCopilotHeaderValue(
  value: string | null | undefined,
  maxLength = 1024,
): string | undefined {
  const trimmed = value?.trim()
  if (
    !trimmed
    || Buffer.byteLength(trimmed, "utf8") > maxLength
    || /[\0\r\n]/.test(trimmed)
  ) {
    return undefined
  }
  return trimmed
}

export function resolveCopilotIntegrationId(value: string | undefined): string {
  const raw = value?.trim()
  if (!raw) return DEFAULT_COPILOT_INTEGRATION_ID
  const sanitized = sanitizeCopilotHeaderValue(raw, MAX_INTEGRATION_ID_LENGTH)
  if (!sanitized) {
    throw new Error(
      "COPILOT_INTEGRATION_ID must be 128 characters or fewer and contain no control characters",
    )
  }
  return sanitized
}

export function collectSafeCopilotResponseHeaders(
  headers: Headers,
): Record<string, string> {
  const result: Record<string, string> = {}

  try {
    if (util.types.isProxy(headers)) return result
  } catch {
    return result
  }

  let entries: IterableIterator<[string, string]>
  if (HEADERS_ENTRIES) {
    try {
      entries = Reflect.apply(HEADERS_ENTRIES, headers, [])
    } catch {
      entries = headers.entries()
    }
  } else {
    entries = headers.entries()
  }

  for (const [name, value] of entries) {
    const canonicalName = name.toLowerCase()
    const isSafeName =
      SAFE_RESPONSE_HEADERS.has(canonicalName)
      || SAFE_RESPONSE_PREFIXES.some((prefix) =>
        canonicalName.startsWith(prefix),
      )
    if (
      !isSafeName
      || Buffer.byteLength(value, "utf8")
        > MAX_SAFE_RESPONSE_HEADER_VALUE_LENGTH
      || /[\0\r\n]/.test(value)
    ) {
      continue
    }
    result[canonicalName] = value
  }

  return result
}
