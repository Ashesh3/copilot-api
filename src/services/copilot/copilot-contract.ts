export const COPILOT_API_VERSION = "2026-08-01"
export const DEFAULT_COPILOT_INTEGRATION_ID = "vscode-chat"

const MAX_INTEGRATION_ID_LENGTH = 128

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
