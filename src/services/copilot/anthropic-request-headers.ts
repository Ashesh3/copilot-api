import { sanitizeCopilotHeaderValue } from "./copilot-contract"

export interface AnthropicRequestHeaderOptions {
  anthropicBeta?: string
  anthropicVersion?: string
  modelProviderPreference?: string
}

export interface AnthropicRequestHeaders extends AnthropicRequestHeaderOptions {
  anthropicVersion: string
}

export function isAnthropicBetaIdentifier(value: string): boolean {
  return /^[!#$%&'*+.^\w`|~-]+$/u.test(value)
}

export function canonicalizeAnthropicBeta(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined

  const identifiers = trimmed.split(",").map((beta) => beta.trim())
  if (
    identifiers.some((identifier) => !isAnthropicBetaIdentifier(identifier))
  ) {
    return undefined
  }
  const canonical = [...new Set(identifiers)].join(",")
  return sanitizeCopilotHeaderValue(canonical)
}

export function getCanonicalAnthropicBetaIdentifiers(
  value: string | undefined,
): ReadonlySet<string> {
  const canonical = canonicalizeAnthropicBeta(value)
  return new Set(canonical?.split(",") ?? [])
}

export function sanitizeAnthropicRequestHeaderOptions(options: {
  anthropicBeta?: string | null
  anthropicVersion?: string | null
  modelProviderPreference?: string | null
}): AnthropicRequestHeaderOptions {
  const anthropicBeta = canonicalizeAnthropicBeta(
    options.anthropicBeta ?? undefined,
  )
  const anthropicVersion = sanitizeAnthropicHeaderValue(
    options.anthropicVersion,
  )
  const modelProviderPreference = sanitizeAnthropicHeaderValue(
    options.modelProviderPreference,
  )
  return {
    ...(anthropicBeta ? { anthropicBeta } : {}),
    ...(anthropicVersion ? { anthropicVersion } : {}),
    ...(modelProviderPreference ? { modelProviderPreference } : {}),
  }
}

export function validateAnthropicRequestHeaderOptions(options: {
  anthropicBeta?: string | null
  anthropicVersion?: string | null
  modelProviderPreference?: string | null
}): AnthropicRequestHeaderOptions {
  return sanitizeAnthropicRequestHeaderOptions(options)
}

function sanitizeAnthropicHeaderValue(
  value: string | null | undefined,
): string | undefined {
  return sanitizeCopilotHeaderValue(value)
}
