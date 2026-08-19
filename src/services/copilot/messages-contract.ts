/* eslint-disable max-lines -- exhaustive hostile-safe Messages boundary validation */
import util from "node:util"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { LocalHTTPError } from "~/lib/error"

import {
  type AnthropicRequestHeaders,
  sanitizeAnthropicRequestHeaderOptions,
} from "./anthropic-request-headers"

export {
  type AnthropicRequestHeaderOptions,
  type AnthropicRequestHeaders,
  canonicalizeAnthropicBeta,
  getCanonicalAnthropicBetaIdentifiers,
  isAnthropicBetaIdentifier,
  sanitizeAnthropicRequestHeaderOptions,
  validateAnthropicRequestHeaderOptions,
} from "./anthropic-request-headers"

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

type MessagesValidationParam =
  | "body"
  | "cache_control"
  | "content"
  | "format"
  | "headers"
  | "max_tokens"
  | "messages"
  | "metadata"
  | "model"
  | "output_config"
  | "source"
  | "system"
  | "thinking"
  | "tool_choice"
  | "tools"

function createMessagesError(options: {
  code: "invalid_json" | "invalid_type" | "invalid_value"
  message: string
  param: MessagesValidationParam
}): LocalHTTPError {
  const clientBody = {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: options.code,
      message: options.message,
      param: options.param,
    },
  }
  return new LocalHTTPError(
    options.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

function createMessagesValidationError(
  param: "max_tokens" | "messages" | "model",
): LocalHTTPError {
  return createMessagesError({
    code: "invalid_value",
    message: `${param} is required for Messages requests.`,
    param,
  })
}

function createInvalidMessagesFieldError(param: string): LocalHTTPError {
  return createMessagesError({
    code: "invalid_type",
    message: `The Messages request contains an invalid ${param} field.`,
    param: canonicalMessagesValidationParam(param),
  })
}

function createInvalidMessagesBodyError(): LocalHTTPError {
  return createMessagesError({
    code: "invalid_type",
    message: "The Messages request body must be a JSON object.",
    param: "body",
  })
}

function createInvalidMessagesJsonValueError(): LocalHTTPError {
  return createMessagesError({
    code: "invalid_type",
    message: "The Messages request body must contain only plain JSON values.",
    param: "body",
  })
}

export function createInvalidAnthropicMessagesJsonError(): LocalHTTPError {
  return createMessagesError({
    code: "invalid_json",
    message: "The Messages request body must contain valid JSON.",
    param: "body",
  })
}

function canonicalMessagesValidationParam(
  param: string,
): MessagesValidationParam {
  if (param.startsWith("tools")) return "tools"
  if (param.startsWith("tool_choice")) return "tool_choice"
  if (param.startsWith("metadata")) return "metadata"
  if (param.startsWith("thinking")) return "thinking"
  if (param.startsWith("output_config.format")) return "format"
  if (param.startsWith("output_config")) return "output_config"
  if (param.startsWith("cache_control")) return "cache_control"
  if (param.startsWith("system")) return "system"
  if (param.includes(".source")) return "source"
  if (param.includes(".content") || param.startsWith("content")) {
    return "content"
  }
  if (param.startsWith("messages")) return "messages"
  if (param === "model") return "model"
  if (param === "max_tokens") return "max_tokens"
  return "body"
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

function validateRawMaxTokens(payload: unknown): void {
  if (typeof payload !== "object" || payload === null || isProxy(payload))
    return
  const descriptors = getPlainJsonDescriptors(payload)
  if (descriptors === INVALID_MESSAGES_JSON) return
  if (!("max_tokens" in descriptors)) return
  const data = readDataDescriptor(descriptors.max_tokens)
  if (data === INVALID_MESSAGES_JSON) return
  validateMaxTokens(data.value, true)
}

function validateMaxTokens(value: unknown, required: boolean): void {
  if (value === undefined && !required) return
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw createMessagesValidationError("max_tokens")
  }
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
  validateMaxTokens(payload.max_tokens, requireMaxTokens)
  validateOptionalRecord(payload, "metadata", validateMetadata)
  validateOptionalRecord(payload, "tool_choice", validateToolChoice)
  validateOptionalRecord(payload, "cache_control", validateCacheControl)
  validateOptionalRecord(payload, "thinking", validateThinking)
  validateOptionalRecord(payload, "output_config", validateOutputConfig)
  validateOptionalRecord(payload, "context_management")
  validateOptionalRecord(payload, "stop_details")
  validateSystem(payload.system)
  validateMessages(payload.messages)
  validateTools(payload.tools)
  validateOptionalStringArray(payload, "stop_sequences")
  validateOptionalFiniteNumber(payload, "temperature")
  validateOptionalFiniteNumber(payload, "top_p")
  validateOptionalFiniteNumber(payload, "top_k")
  validateOptionalBoolean(payload, "stream")
  validateOptionalString(payload, "fallback_credit_token")
  if (
    payload.service_tier !== undefined
    && payload.service_tier !== "auto"
    && payload.service_tier !== "standard_only"
  ) {
    throw createInvalidMessagesFieldError("service_tier")
  }
  if (payload.speed !== undefined && payload.speed !== "fast") {
    throw createInvalidMessagesFieldError("speed")
  }
}

function validateOptionalRecord(
  parent: Record<string, unknown>,
  field: string,
  validate?: (value: Record<string, unknown>) => void,
): void {
  const value = parent[field]
  if (value === undefined) return
  if (!isRecord(value)) throw createInvalidMessagesFieldError(field)
  validate?.(value)
}

function validateOptionalString(
  parent: Record<string, unknown>,
  field: string,
): void {
  const value = parent[field]
  if (value !== undefined && typeof value !== "string") {
    throw createInvalidMessagesFieldError(field)
  }
}

function validateNonEmptyString(value: unknown, param: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createInvalidMessagesFieldError(param)
  }
}

function validateOptionalBoolean(
  parent: Record<string, unknown>,
  field: string,
): void {
  const value = parent[field]
  if (value !== undefined && typeof value !== "boolean") {
    throw createInvalidMessagesFieldError(field)
  }
}

function validateOptionalFiniteNumber(
  parent: Record<string, unknown>,
  field: string,
): void {
  const value = parent[field]
  if (
    value !== undefined
    && (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw createInvalidMessagesFieldError(field)
  }
}

function validateOptionalStringArray(
  parent: Record<string, unknown>,
  field: string,
): void {
  const value = parent[field]
  if (
    value !== undefined
    && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    throw createInvalidMessagesFieldError(field)
  }
}

function validateMetadata(value: Record<string, unknown>): void {
  validateOptionalString(value, "user_id")
}

function validateCacheControl(value: Record<string, unknown>): void {
  if (value.type !== "ephemeral") {
    throw createInvalidMessagesFieldError("cache_control.type")
  }
  if (value.ttl !== undefined && typeof value.ttl !== "string") {
    throw createInvalidMessagesFieldError("cache_control.ttl")
  }
  validatePlainNestedValues(value, "cache_control")
}

function validateToolChoice(value: Record<string, unknown>): void {
  if (
    value.type !== "auto"
    && value.type !== "any"
    && value.type !== "tool"
    && value.type !== "none"
  ) {
    throw createInvalidMessagesFieldError("tool_choice.type")
  }
  if (value.name !== undefined) {
    validateNonEmptyString(value.name, "tool_choice.name")
  }
  if (value.type === "tool" && value.name === undefined) {
    throw createInvalidMessagesFieldError("tool_choice.name")
  }
  validateOptionalBoolean(value, "disable_parallel_tool_use")
  validatePlainNestedValues(value, "tool_choice")
}

function validateThinking(value: Record<string, unknown>): void {
  if (value.type !== "enabled" && value.type !== "adaptive") {
    throw createInvalidMessagesFieldError("thinking.type")
  }
  if (
    value.budget_tokens !== undefined
    && (!Number.isInteger(value.budget_tokens)
      || Number(value.budget_tokens) <= 0)
  ) {
    throw createInvalidMessagesFieldError("thinking.budget_tokens")
  }
  validatePlainNestedValues(value, "thinking")
}

const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

function validateOutputConfig(value: Record<string, unknown>): void {
  if (
    value.effort !== undefined
    && (typeof value.effort !== "string"
      || !REASONING_EFFORTS.has(value.effort))
  ) {
    throw createInvalidMessagesFieldError("output_config.effort")
  }
  if (value.format !== undefined) {
    if (!isRecord(value.format)) {
      throw createInvalidMessagesFieldError("output_config.format")
    }
    validateNonEmptyString(value.format.type, "output_config.format.type")
  }
  if (value.task_budget !== undefined) {
    if (!isRecord(value.task_budget) || value.task_budget.type !== "tokens") {
      throw createInvalidMessagesFieldError("output_config.task_budget")
    }
    if (
      !Number.isInteger(value.task_budget.total)
      || Number(value.task_budget.total) <= 0
      || (value.task_budget.remaining !== undefined
        && (!Number.isInteger(value.task_budget.remaining)
          || Number(value.task_budget.remaining) < 0))
    ) {
      throw createInvalidMessagesFieldError("output_config.task_budget")
    }
    validatePlainNestedValues(value.task_budget, "output_config.task_budget")
  }
  validatePlainNestedValues(value, "output_config")
}

function validateSystem(value: unknown): void {
  if (value === undefined || typeof value === "string") return
  if (!Array.isArray(value)) throw createInvalidMessagesFieldError("system")
  for (const [index, block] of value.entries()) {
    const param = `system.${index}`
    if (!isRecord(block)) throw createInvalidMessagesFieldError(param)
    validateNonEmptyString(block.type, `${param}.type`)
    if (block.type === "text") validateTextBlock(block, param)
  }
}

function validateMessages(value: unknown): void {
  if (!Array.isArray(value)) throw createInvalidMessagesFieldError("messages")
  for (const [index, message] of value.entries()) {
    const param = `messages.${index}`
    if (!isRecord(message)) throw createInvalidMessagesFieldError(param)
    if (message.role !== "user" && message.role !== "assistant") {
      throw createInvalidMessagesFieldError(`${param}.role`)
    }
    if (typeof message.content === "string") continue
    if (!Array.isArray(message.content)) {
      throw createInvalidMessagesFieldError(`${param}.content`)
    }
    for (const [contentIndex, block] of message.content.entries()) {
      validateContentBlock(
        block,
        `${param}.content.${contentIndex}`,
        message.role,
      )
    }
  }
}

// Wire-union validation is kept centralized so every caller fails identically.
// eslint-disable-next-line complexity
function validateContentBlock(
  value: unknown,
  param: string,
  role: "assistant" | "user",
): void {
  if (!isRecord(value)) throw createInvalidMessagesFieldError(param)
  validateNonEmptyString(value.type, `${param}.type`)
  switch (value.type) {
    case "text": {
      if (typeof value.text !== "string") {
        throw createInvalidMessagesFieldError(`${param}.text`)
      }
      validateNestedCacheControl(value, param)
      return
    }
    case "image": {
      if (role !== "user") throw createInvalidMessagesFieldError(param)
      validateImageSource(value.source, `${param}.source`)
      validateNestedCacheControl(value, param)
      return
    }
    case "document": {
      if (role !== "user") throw createInvalidMessagesFieldError(param)
      validateDocumentBlock(value, param)
      return
    }
    case "tool_result": {
      if (role !== "user") throw createInvalidMessagesFieldError(param)
      validateNonEmptyString(value.tool_use_id, `${param}.tool_use_id`)
      if (typeof value.content !== "string") {
        if (!Array.isArray(value.content)) {
          throw createInvalidMessagesFieldError(`${param}.content`)
        }
        for (const [index, nested] of value.content.entries()) {
          validateToolResultContent(nested, `${param}.content.${index}`)
        }
      }
      validateOptionalBoolean(value, "is_error")
      validateNestedCacheControl(value, param)
      return
    }
    case "tool_use": {
      if (role !== "assistant") throw createInvalidMessagesFieldError(param)
      validateNonEmptyString(value.id, `${param}.id`)
      validateNonEmptyString(value.name, `${param}.name`)
      if (!isRecord(value.input)) {
        throw createInvalidMessagesFieldError(`${param}.input`)
      }
      validateNestedCacheControl(value, param)
      return
    }
    case "thinking": {
      if (role !== "assistant" || typeof value.thinking !== "string") {
        throw createInvalidMessagesFieldError(param)
      }
      if (
        value.signature !== undefined
        && typeof value.signature !== "string"
      ) {
        throw createInvalidMessagesFieldError(`${param}.signature`)
      }
      validateNestedCacheControl(value, param)
      return
    }
    default: {
      return
    }
  }
}

function validateToolResultContent(value: unknown, param: string): void {
  if (!isRecord(value)) throw createInvalidMessagesFieldError(param)
  if (value.type === "tool_reference") {
    validateNonEmptyString(value.tool_name, `${param}.tool_name`)
    validateNestedCacheControl(value, param)
    return
  }
  validateContentBlock(value, param, "user")
}

function validateTextBlock(value: unknown, param: string): void {
  if (
    !isRecord(value)
    || value.type !== "text"
    || typeof value.text !== "string"
  ) {
    throw createInvalidMessagesFieldError(param)
  }
  validateNestedCacheControl(value, param)
}

function validateNestedCacheControl(
  value: Record<string, unknown>,
  param: string,
): void {
  if (value.cache_control === undefined) return
  if (!isRecord(value.cache_control)) {
    throw createInvalidMessagesFieldError(`${param}.cache_control`)
  }
  validateCacheControl(value.cache_control)
}

function validatePlainNestedValues(
  value: Record<string, unknown>,
  param: string,
): void {
  for (const [key, nested] of Object.entries(value)) {
    if (
      nested !== null
      && typeof nested === "object"
      && !Array.isArray(nested)
      && !isRecord(nested)
    ) {
      throw createInvalidMessagesFieldError(`${param}.${key}`)
    }
  }
}

function validateImageSource(value: unknown, param: string): void {
  if (!isRecord(value)) throw createInvalidMessagesFieldError(param)
  if (value.type === "url") {
    if (typeof value.url !== "string") {
      throw createInvalidMessagesFieldError(`${param}.url`)
    }
    return
  }
  if (value.type !== "base64")
    throw createInvalidMessagesFieldError(`${param}.type`)
  if (
    value.media_type !== "image/jpeg"
    && value.media_type !== "image/png"
    && value.media_type !== "image/gif"
    && value.media_type !== "image/webp"
  ) {
    throw createInvalidMessagesFieldError(`${param}.media_type`)
  }
  if (typeof value.data !== "string") {
    throw createInvalidMessagesFieldError(`${param}.data`)
  }
}

// Document source variants share one exact public-boundary validator.
// eslint-disable-next-line complexity
function validateDocumentBlock(
  value: Record<string, unknown>,
  param: string,
): void {
  const source = value.source
  if (!isRecord(source)) {
    throw createInvalidMessagesFieldError(`${param}.source`)
  }
  switch (source.type) {
    case "base64": {
      validateNonEmptyString(source.media_type, `${param}.source.media_type`)
      if (typeof source.data !== "string") {
        throw createInvalidMessagesFieldError(`${param}.source.data`)
      }
      break
    }
    case "text": {
      if (
        source.media_type !== undefined
        && typeof source.media_type !== "string"
      ) {
        throw createInvalidMessagesFieldError(`${param}.source.media_type`)
      }
      if (typeof source.data !== "string") {
        throw createInvalidMessagesFieldError(`${param}.source.data`)
      }
      break
    }
    case "url": {
      if (typeof source.url !== "string") {
        throw createInvalidMessagesFieldError(`${param}.source.url`)
      }
      break
    }
    case "content": {
      if (typeof source.content === "string") break
      if (!Array.isArray(source.content)) {
        throw createInvalidMessagesFieldError(`${param}.source.content`)
      }
      for (const [index, nested] of source.content.entries()) {
        if (!isRecord(nested)) {
          throw createInvalidMessagesFieldError(
            `${param}.source.content.${index}`,
          )
        }
        if (nested.type === "text") {
          validateTextBlock(nested, `${param}.source.content.${index}`)
        } else if (nested.type === "image") {
          validateImageSource(
            nested.source,
            `${param}.source.content.${index}.source`,
          )
        } else {
          throw createInvalidMessagesFieldError(
            `${param}.source.content.${index}.type`,
          )
        }
      }
      break
    }
    default: {
      throw createInvalidMessagesFieldError(`${param}.source.type`)
    }
  }
  if (
    value.title !== undefined
    && value.title !== null
    && typeof value.title !== "string"
  ) {
    throw createInvalidMessagesFieldError(`${param}.title`)
  }
  if (
    value.context !== undefined
    && value.context !== null
    && typeof value.context !== "string"
  ) {
    throw createInvalidMessagesFieldError(`${param}.context`)
  }
  if (value.citations !== undefined && value.citations !== null) {
    if (!isRecord(value.citations)) {
      throw createInvalidMessagesFieldError(`${param}.citations`)
    }
    validateOptionalBoolean(value.citations, "enabled")
  }
  validateNestedCacheControl(value, param)
}

function validateTools(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw createInvalidMessagesFieldError("tools")
  for (const [index, tool] of value.entries()) {
    const param = `tools.${index}`
    if (!isRecord(tool)) throw createInvalidMessagesFieldError(param)
    validateNonEmptyString(tool.name, `${param}.name`)
    if (tool.type !== undefined)
      validateNonEmptyString(tool.type, `${param}.type`)
    if (
      tool.description !== undefined
      && typeof tool.description !== "string"
    ) {
      throw createInvalidMessagesFieldError(`${param}.description`)
    }
    if (tool.input_schema !== undefined && !isRecord(tool.input_schema)) {
      throw createInvalidMessagesFieldError(`${param}.input_schema`)
    }
    if (tool.type === undefined && tool.input_schema === undefined) {
      throw createInvalidMessagesFieldError(`${param}.input_schema`)
    }
    validateOptionalStringArray(tool, "allowed_domains")
    validateOptionalStringArray(tool, "blocked_domains")
    if (
      tool.max_uses !== undefined
      && (!Number.isInteger(tool.max_uses) || Number(tool.max_uses) <= 0)
    ) {
      throw createInvalidMessagesFieldError(`${param}.max_uses`)
    }
    validateNestedCacheControl(tool, param)
  }
}

export function prepareAnthropicMessagesRequest(options: {
  anthropicBeta?: string
  anthropicVersion?: string
  modelProviderPreference?: string
  payload: AnthropicMessagesPayload
  requireMaxTokens: boolean
}): PreparedAnthropicMessagesRequest {
  validateRawMaxTokens(options.payload)
  const body = cloneAnthropicMessagesBody(options.payload)
  validateAnthropicMessagesPayload(body, options.requireMaxTokens)
  for (const field of GATEWAY_ONLY_MESSAGES_FIELDS) {
    Reflect.deleteProperty(body, field)
  }

  const sanitizedHeaders = sanitizeAnthropicRequestHeaderOptions(options)

  return {
    body,
    headers: {
      ...sanitizedHeaders,
      anthropicVersion:
        sanitizedHeaders.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
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
