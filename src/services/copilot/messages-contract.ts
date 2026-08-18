import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { LocalHTTPError } from "~/lib/error"

import { sanitizeCopilotHeaderValue } from "./copilot-contract"

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
const GATEWAY_ONLY_MESSAGES_FIELDS = new Set([
  "_gateway_compaction",
  "_json_schema",
])

export interface AnthropicRequestHeaders {
  anthropicBeta?: string
  anthropicVersion: string
  modelProviderPreference?: string
}

export interface PreparedAnthropicMessagesRequest {
  body: Record<string, unknown>
  headers: AnthropicRequestHeaders
}

type NativeCacheControl = {
  type: "ephemeral"
  ttl?: "5m" | "1h"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createMessagesValidationError(param: string): LocalHTTPError {
  const message = `${param} is required for Messages requests.`
  const clientBody = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message,
    },
  }
  return new LocalHTTPError(
    message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

function validateAnthropicMessagesPayload(
  payload: AnthropicMessagesPayload,
  requireMaxTokens: boolean,
): void {
  if (typeof payload.model !== "string" || payload.model.trim().length === 0) {
    throw createMessagesValidationError("model")
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw createMessagesValidationError("messages")
  }
  if (
    requireMaxTokens
    && (!Number.isInteger(payload.max_tokens)
      || Number(payload.max_tokens) <= 0)
  ) {
    throw createMessagesValidationError("max_tokens")
  }
}

export function canonicalizeAnthropicBeta(
  value: string | undefined,
): string | undefined {
  const sanitized = sanitizeCopilotHeaderValue(value)
  if (!sanitized) return undefined

  const canonical = [
    ...new Set(
      sanitized
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean),
    ),
  ].join(",")
  return sanitizeCopilotHeaderValue(canonical)
}

export function prepareAnthropicMessagesRequest(options: {
  anthropicBeta?: string
  anthropicVersion?: string
  modelProviderPreference?: string
  payload: AnthropicMessagesPayload
  requireMaxTokens: boolean
}): PreparedAnthropicMessagesRequest {
  validateAnthropicMessagesPayload(options.payload, options.requireMaxTokens)

  const body = structuredClone(
    options.payload as unknown as Record<string, unknown>,
  )
  for (const field of GATEWAY_ONLY_MESSAGES_FIELDS) {
    Reflect.deleteProperty(body, field)
  }

  const anthropicBeta = canonicalizeAnthropicBeta(options.anthropicBeta)
  const anthropicVersion =
    sanitizeCopilotHeaderValue(options.anthropicVersion)
    ?? DEFAULT_ANTHROPIC_VERSION
  const modelProviderPreference = sanitizeCopilotHeaderValue(
    options.modelProviderPreference,
  )

  return {
    body,
    headers: {
      ...(anthropicBeta ? { anthropicBeta } : {}),
      anthropicVersion,
      ...(modelProviderPreference ? { modelProviderPreference } : {}),
    },
  }
}

export function serializeAnthropicMessagesRequest(
  body: Record<string, unknown>,
): string {
  return JSON.stringify(body, (key, value: unknown) => {
    if (
      key !== "cache_control"
      || !isRecord(value)
      || value.type !== "ephemeral"
    ) {
      return value
    }

    const cacheControl: NativeCacheControl = { type: "ephemeral" }
    if (value.ttl === "5m" || value.ttl === "1h") {
      cacheControl.ttl = value.ttl
    }
    return cacheControl
  })
}
