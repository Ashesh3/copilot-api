import { LocalHTTPError } from "~/lib/error"

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
  const sanitized = sanitizeAnthropicRequestHeaderOptions(options)
  validateHeader({
    input: options.anthropicBeta,
    output: sanitized.anthropicBeta,
    message: "The Anthropic-Beta header is invalid.",
    param: "anthropic_beta",
  })
  validateHeader({
    input: options.anthropicVersion,
    output: sanitized.anthropicVersion,
    message: "The anthropic-version header is invalid.",
    param: "anthropic_version",
  })
  validateHeader({
    input: options.modelProviderPreference,
    output: sanitized.modelProviderPreference,
    message: "The model provider preference header is invalid.",
    param: "model_provider_preference",
  })
  return sanitized
}

function sanitizeAnthropicHeaderValue(
  value: string | null | undefined,
): string | undefined {
  const sanitized = sanitizeCopilotHeaderValue(value)
  if (!sanitized) return undefined
  for (const character of sanitized) {
    const code = character.codePointAt(0)
    if (code === undefined || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return undefined
    }
  }
  return sanitized
}

function validateHeader(options: {
  input: string | null | undefined
  message: string
  output: string | undefined
  param: "anthropic_beta" | "anthropic_version" | "model_provider_preference"
}): void {
  if (!options.input?.trim() || options.output !== undefined) return
  const clientBody = {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "invalid_value",
      message: options.message,
      param: options.param,
    },
  }
  throw new LocalHTTPError(
    options.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}
