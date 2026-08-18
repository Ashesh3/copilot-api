import util from "node:util"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { LocalHTTPError } from "~/lib/error"

import { sanitizeCopilotHeaderValue } from "./copilot-contract"

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
const INVALID_MESSAGES_JSON = Symbol("invalid-messages-json")
type PlainJsonClone =
  | Array<unknown>
  | Record<string, unknown>
  | boolean
  | null
  | number
  | string
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

function createMessagesError(message: string): LocalHTTPError {
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

function createMessagesValidationError(param: string): LocalHTTPError {
  return createMessagesError(`${param} is required for Messages requests.`)
}

function createInvalidMessagesBodyError(): LocalHTTPError {
  return createMessagesError("The Messages request body must be a JSON object.")
}

function createInvalidMessagesJsonValueError(): LocalHTTPError {
  return createMessagesError(
    "The Messages request body must contain only plain JSON values.",
  )
}

export function createInvalidAnthropicMessagesJsonError(): LocalHTTPError {
  return createMessagesError(
    "The Messages request body must contain valid JSON.",
  )
}

function isProxy(value: object): boolean {
  try {
    return util.types.isProxy(value)
  } catch {
    return true
  }
}

function getPlainJsonDescriptors(
  value: object,
): Record<PropertyKey, PropertyDescriptor> | typeof INVALID_MESSAGES_JSON {
  if (isProxy(value)) return INVALID_MESSAGES_JSON
  try {
    const prototype: unknown = Object.getPrototypeOf(value)
    const isArray = Array.isArray(value)
    if (
      (isArray && prototype !== Array.prototype)
      || (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      return INVALID_MESSAGES_JSON
    }
    return Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >
  } catch {
    return INVALID_MESSAGES_JSON
  }
}

function readDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): { enumerable?: boolean; value: unknown } | typeof INVALID_MESSAGES_JSON {
  if (!descriptor || !("value" in descriptor)) return INVALID_MESSAGES_JSON
  return descriptor as { enumerable?: boolean; value: unknown }
}

function clonePlainJsonArray(
  value: Array<unknown>,
  seen: Set<object>,
): Array<unknown> | typeof INVALID_MESSAGES_JSON {
  const descriptors = getPlainJsonDescriptors(value)
  if (descriptors === INVALID_MESSAGES_JSON) return INVALID_MESSAGES_JSON
  const lengthDescriptor = readDataDescriptor(descriptors.length)
  if (
    lengthDescriptor === INVALID_MESSAGES_JSON
    || typeof lengthDescriptor.value !== "number"
  ) {
    return INVALID_MESSAGES_JSON
  }

  const length = lengthDescriptor.value
  const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length")
  if (keys.length !== length || keys.some((key) => typeof key !== "string")) {
    return INVALID_MESSAGES_JSON
  }

  const clone: Array<unknown> = []
  seen.add(value)
  try {
    for (let index = 0; index < length; index += 1) {
      const descriptor = readDataDescriptor(descriptors[String(index)])
      if (
        descriptor === INVALID_MESSAGES_JSON
        || descriptor.enumerable !== true
      ) {
        return INVALID_MESSAGES_JSON
      }
      const nested = clonePlainJsonValue(descriptor.value, seen)
      if (nested === INVALID_MESSAGES_JSON) return INVALID_MESSAGES_JSON
      clone.push(nested)
    }
  } finally {
    seen.delete(value)
  }
  return clone
}

function clonePlainJsonObject(
  value: Record<string, unknown>,
  seen: Set<object>,
): Record<string, unknown> | typeof INVALID_MESSAGES_JSON {
  const descriptors = getPlainJsonDescriptors(value)
  if (descriptors === INVALID_MESSAGES_JSON) return INVALID_MESSAGES_JSON

  const clone: Record<string, unknown> = {}
  seen.add(value)
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return INVALID_MESSAGES_JSON
      const descriptor = readDataDescriptor(descriptors[key])
      if (
        descriptor === INVALID_MESSAGES_JSON
        || descriptor.enumerable !== true
      ) {
        return INVALID_MESSAGES_JSON
      }
      const nested = clonePlainJsonValue(descriptor.value, seen)
      if (nested === INVALID_MESSAGES_JSON) return INVALID_MESSAGES_JSON
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: nested,
        writable: true,
      })
    }
  } finally {
    seen.delete(value)
  }
  return clone
}

function clonePlainJsonValue(
  value: unknown,
  seen: Set<object>,
): PlainJsonClone | typeof INVALID_MESSAGES_JSON {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return value
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_MESSAGES_JSON
  }
  if (typeof value !== "object" || isProxy(value) || seen.has(value)) {
    return INVALID_MESSAGES_JSON
  }
  try {
    return Array.isArray(value) ?
        clonePlainJsonArray(value, seen)
      : clonePlainJsonObject(value as Record<string, unknown>, seen)
  } catch {
    return INVALID_MESSAGES_JSON
  }
}

function cloneAnthropicMessagesBody(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    throw createInvalidMessagesBodyError()
  }
  if (isProxy(payload)) throw createInvalidMessagesJsonValueError()
  let isArray: boolean
  try {
    isArray = Array.isArray(payload)
  } catch {
    throw createInvalidMessagesJsonValueError()
  }
  if (isArray) throw createInvalidMessagesBodyError()

  const clone = clonePlainJsonValue(payload, new Set<object>())
  if (clone === INVALID_MESSAGES_JSON || !isRecord(clone)) {
    throw createInvalidMessagesJsonValueError()
  }
  return clone
}

function validateAnthropicMessagesPayload(
  payload: Record<string, unknown>,
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

function hasUnsafeHeaderControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined
      && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true
    }
  }
  return false
}

export function canonicalizeAnthropicBeta(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || hasUnsafeHeaderControl(trimmed)) {
    return undefined
  }

  const canonical = [
    ...new Set(
      trimmed
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean),
    ),
  ].join(",")
  if (!canonical) return undefined
  return sanitizeCopilotHeaderValue(canonical)
}

export function prepareAnthropicMessagesRequest(options: {
  anthropicBeta?: string
  anthropicVersion?: string
  modelProviderPreference?: string
  payload: AnthropicMessagesPayload
  requireMaxTokens: boolean
}): PreparedAnthropicMessagesRequest {
  const body = cloneAnthropicMessagesBody(options.payload)
  validateAnthropicMessagesPayload(body, options.requireMaxTokens)
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

function normalizeCacheControls(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeCacheControls(item)
    return
  }
  if (!isRecord(value)) return

  for (const [key, nested] of Object.entries(value)) {
    if (
      key === "cache_control"
      && isRecord(nested)
      && nested.type === "ephemeral"
    ) {
      const cacheControl: NativeCacheControl = { type: "ephemeral" }
      if (nested.ttl === "5m" || nested.ttl === "1h") {
        cacheControl.ttl = nested.ttl
      }
      value[key] = cacheControl
      continue
    }
    normalizeCacheControls(nested)
  }
}

export function normalizeAnthropicMessagesRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = cloneAnthropicMessagesBody(body)
  normalizeCacheControls(normalized)
  return normalized
}

export function serializeAnthropicMessagesRequest(
  body: Record<string, unknown>,
): string {
  return JSON.stringify(normalizeAnthropicMessagesRequest(body))
}
