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

export function sanitizeCopilotHeaderValue(
  value: string | null | undefined,
  maxLength = 1024,
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > maxLength || /[\0\r\n]/.test(trimmed)) {
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

  for (const [name, value] of headers.entries()) {
    const canonicalName = name.toLowerCase()
    const isSafeName =
      SAFE_RESPONSE_HEADERS.has(canonicalName)
      || SAFE_RESPONSE_PREFIXES.some((prefix) =>
        canonicalName.startsWith(prefix),
      )
    if (
      !isSafeName
      || value.length > MAX_SAFE_RESPONSE_HEADER_VALUE_LENGTH
      || /[\0\r\n]/.test(value)
    ) {
      continue
    }
    result[canonicalName] = value
  }

  return result
}
