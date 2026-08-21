/* eslint-disable max-lines -- exhaustive hostile-safe Messages boundary validation */
import util from "node:util"

import type { CopilotContractNormalizationClass } from "~/lib/copilot-contract-observability"
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
  body: AnthropicMessagesPayload
  headers: AnthropicRequestHeaders
  normalizationClasses: Array<CopilotContractNormalizationClass>
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

export function createMissingAnthropicMessagesMaxTokensError(): LocalHTTPError {
  return createMessagesValidationError("max_tokens")
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

function cloneAnthropicMessagesBody(
  payload: unknown,
): AnthropicMessagesPayload {
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
  return clone as AnthropicMessagesPayload
}

function validateMaxTokens(value: unknown, required: boolean): void {
  if (value === undefined && !required) return
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw createMessagesValidationError("max_tokens")
  }
}

function validateAnthropicMessagesPayload(
  payload: AnthropicMessagesPayload,
): void {
  if (typeof payload.model !== "string" || payload.model.trim().length === 0) {
    throw createMessagesValidationError("model")
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw createMessagesValidationError("messages")
  }
  validateMessages(payload.messages)
  validateTools(payload.tools)
}

function deleteOwnField(
  parent: Record<string, unknown>,
  field: string,
): boolean {
  if (!Object.hasOwn(parent, field)) return false
  Reflect.deleteProperty(parent, field)
  return true
}

function normalizeOptionalRecord(
  parent: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = parent[field]
  if (value === undefined) return undefined
  if (isRecord(value)) return value
  deleteOwnField(parent, field)
  return undefined
}

function normalizeOptionalString(
  parent: Record<string, unknown>,
  field: string,
): void {
  const value = parent[field]
  if (value !== undefined && typeof value !== "string") {
    deleteOwnField(parent, field)
  }
}

function validateNonEmptyString(value: unknown, param: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createInvalidMessagesFieldError(param)
  }
}

function normalizeOptionalBoolean(
  parent: Record<string, unknown>,
  field: string,
): void {
  const value = parent[field]
  if (value !== undefined && typeof value !== "boolean") {
    deleteOwnField(parent, field)
  }
}

function normalizeOptionalFiniteNumber(
  parent: Record<string, unknown>,
  field: string,
): void {
  const value = parent[field]
  if (
    value !== undefined
    && (typeof value !== "number" || !Number.isFinite(value))
  ) {
    deleteOwnField(parent, field)
  }
}

function normalizeOptionalStringArray(
  parent: Record<string, unknown>,
  field: string,
): void {
  const value = parent[field]
  if (
    value !== undefined
    && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    deleteOwnField(parent, field)
  }
}

function normalizeMaxTokens(payload: AnthropicMessagesPayload): void {
  if (payload.max_tokens === undefined) return
  try {
    validateMaxTokens(payload.max_tokens, true)
  } catch {
    deleteOwnField(payload, "max_tokens")
  }
}

function normalizeMetadata(payload: AnthropicMessagesPayload): void {
  const metadata = normalizeOptionalRecord(payload, "metadata")
  if (!metadata) return
  normalizeOptionalString(metadata, "user_id")
}

function normalizeToolChoice(payload: AnthropicMessagesPayload): void {
  const toolChoice = normalizeOptionalRecord(payload, "tool_choice")
  if (!toolChoice) return
  if (toolChoice.type !== undefined && typeof toolChoice.type !== "string") {
    deleteOwnField(payload, "tool_choice")
    return
  }
  if (
    toolChoice.name !== undefined
    && (typeof toolChoice.name !== "string"
      || toolChoice.name.trim().length === 0)
  ) {
    deleteOwnField(toolChoice, "name")
  }
  normalizeOptionalBoolean(toolChoice, "disable_parallel_tool_use")
  if (toolChoice.type === "tool" && typeof toolChoice.name !== "string") {
    deleteOwnField(payload, "tool_choice")
  }
}

function normalizeThinking(payload: AnthropicMessagesPayload): void {
  const thinking = normalizeOptionalRecord(payload, "thinking")
  if (!thinking) return
  if (typeof thinking.type !== "string" || thinking.type.trim().length === 0) {
    deleteOwnField(payload, "thinking")
    return
  }
  if (
    thinking.budget_tokens !== undefined
    && (!Number.isInteger(thinking.budget_tokens)
      || Number(thinking.budget_tokens) <= 0)
  ) {
    deleteOwnField(thinking, "budget_tokens")
  }
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

function normalizeOutputFormat(outputConfig: Record<string, unknown>): void {
  if (outputConfig.format === undefined) return
  if (
    !isRecord(outputConfig.format)
    || typeof outputConfig.format.type !== "string"
    || outputConfig.format.type.trim().length === 0
  ) {
    deleteOwnField(outputConfig, "format")
  }
}

function normalizeOutputTaskBudget(
  outputConfig: Record<string, unknown>,
): void {
  const taskBudget = outputConfig.task_budget
  if (taskBudget === undefined) return
  if (
    !isRecord(taskBudget)
    || taskBudget.type !== "tokens"
    || !Number.isInteger(taskBudget.total)
    || Number(taskBudget.total) <= 0
    || (taskBudget.remaining !== undefined
      && (!Number.isInteger(taskBudget.remaining)
        || Number(taskBudget.remaining) < 0))
  ) {
    deleteOwnField(outputConfig, "task_budget")
  }
}

function normalizeOutputConfig(payload: AnthropicMessagesPayload): void {
  const outputConfig = normalizeOptionalRecord(payload, "output_config")
  if (!outputConfig) return
  if (
    outputConfig.effort !== undefined
    && (typeof outputConfig.effort !== "string"
      || !REASONING_EFFORTS.has(outputConfig.effort))
  ) {
    deleteOwnField(outputConfig, "effort")
  }
  normalizeOutputFormat(outputConfig)
  normalizeOutputTaskBudget(outputConfig)
}

function isValidSystemBlock(block: unknown): boolean {
  if (!isRecord(block)) return false
  if (typeof block.type !== "string" || block.type.trim().length === 0) {
    return false
  }
  return block.type !== "text" || typeof block.text === "string"
}

function normalizeSystem(payload: AnthropicMessagesPayload): void {
  if (payload.system === undefined || typeof payload.system === "string") return
  if (
    !Array.isArray(payload.system)
    || !payload.system.every((block) => isValidSystemBlock(block))
  ) {
    deleteOwnField(payload, "system")
  }
}

function normalizeOptionalPayloadFields(
  payload: AnthropicMessagesPayload,
): void {
  normalizeMaxTokens(payload)
  normalizeMetadata(payload)
  normalizeToolChoice(payload)
  normalizeThinking(payload)
  normalizeOutputConfig(payload)
  normalizeSystem(payload)
  normalizeOptionalRecord(payload, "context_management")
  normalizeOptionalRecord(payload, "stop_details")
  normalizeOptionalStringArray(payload, "stop_sequences")
  normalizeOptionalFiniteNumber(payload, "temperature")
  normalizeOptionalFiniteNumber(payload, "top_p")
  normalizeOptionalFiniteNumber(payload, "top_k")
  normalizeOptionalBoolean(payload, "stream")
  normalizeOptionalString(payload, "fallback_credit_token")
  normalizeOptionalString(payload, "service_tier")
  normalizeOptionalString(payload, "speed")
}

function validateMessages(value: unknown): void {
  if (!Array.isArray(value)) throw createInvalidMessagesFieldError("messages")
  for (const [index, message] of value.entries()) {
    const param = `messages.${index}`
    if (!isRecord(message)) throw createInvalidMessagesFieldError(param)
    if (typeof message.role !== "string" || message.role.trim().length === 0) {
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
  _role: string,
): void {
  if (!isRecord(value)) throw createInvalidMessagesFieldError(param)
  validateNonEmptyString(value.type, `${param}.type`)
  switch (value.type) {
    case "text": {
      if (typeof value.text !== "string") {
        throw createInvalidMessagesFieldError(`${param}.text`)
      }
      return
    }
    case "image": {
      validateImageSource(value.source, `${param}.source`)
      return
    }
    case "document": {
      validateDocumentBlock(value, param)
      return
    }
    case "tool_result": {
      validateNonEmptyString(value.tool_use_id, `${param}.tool_use_id`)
      if (typeof value.content !== "string") {
        if (!Array.isArray(value.content)) {
          throw createInvalidMessagesFieldError(`${param}.content`)
        }
        for (const [index, nested] of value.content.entries()) {
          validateToolResultContent(nested, `${param}.content.${index}`)
        }
      }
      if (value.is_error !== undefined && typeof value.is_error !== "boolean") {
        throw createInvalidMessagesFieldError(`${param}.is_error`)
      }
      return
    }
    case "tool_use": {
      validateNonEmptyString(value.id, `${param}.id`)
      validateNonEmptyString(value.name, `${param}.name`)
      if (!isRecord(value.input)) {
        throw createInvalidMessagesFieldError(`${param}.input`)
      }
      return
    }
    case "thinking": {
      if (typeof value.thinking !== "string") {
        throw createInvalidMessagesFieldError(param)
      }
      if (
        value.signature !== undefined
        && typeof value.signature !== "string"
      ) {
        throw createInvalidMessagesFieldError(`${param}.signature`)
      }
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
    if (
      value.citations.enabled !== undefined
      && typeof value.citations.enabled !== "boolean"
    ) {
      throw createInvalidMessagesFieldError(`${param}.citations.enabled`)
    }
  }
}

function validateTools(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw createInvalidMessagesFieldError("tools")
  for (const [index, tool] of value.entries()) {
    validateTool(tool, index)
  }
}

function validateToolStringArray(value: unknown, param: string): void {
  if (
    value !== undefined
    && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    throw createInvalidMessagesFieldError(param)
  }
}

function validateTool(tool: unknown, index: number): void {
  const param = `tools.${index}`
  if (!isRecord(tool)) throw createInvalidMessagesFieldError(param)
  validateNonEmptyString(tool.name, `${param}.name`)
  if (tool.type !== undefined)
    validateNonEmptyString(tool.type, `${param}.type`)
  if (tool.description !== undefined && typeof tool.description !== "string") {
    throw createInvalidMessagesFieldError(`${param}.description`)
  }
  if (tool.input_schema !== undefined && !isRecord(tool.input_schema)) {
    throw createInvalidMessagesFieldError(`${param}.input_schema`)
  }
  validateToolStringArray(tool.allowed_domains, `${param}.allowed_domains`)
  validateToolStringArray(tool.blocked_domains, `${param}.blocked_domains`)
  if (
    tool.max_uses !== undefined
    && (!Number.isInteger(tool.max_uses) || Number(tool.max_uses) <= 0)
  ) {
    throw createInvalidMessagesFieldError(`${param}.max_uses`)
  }
}

export function prepareAnthropicMessagesRequest(options: {
  anthropicBeta?: string
  anthropicVersion?: string
  modelProviderPreference?: string
  payload: AnthropicMessagesPayload
  requireMaxTokens: boolean
}): PreparedAnthropicMessagesRequest {
  const body = cloneAnthropicMessagesBody(options.payload)
  validateAnthropicMessagesPayload(body)
  normalizeOptionalPayloadFields(body)
  const normalizationClasses: Array<CopilotContractNormalizationClass> = []
  let removedGatewayField = false
  for (const field of GATEWAY_ONLY_MESSAGES_FIELDS) {
    if (!Object.hasOwn(body, field)) continue
    Reflect.deleteProperty(body, field)
    removedGatewayField = true
  }
  if (removedGatewayField) normalizationClasses.push("gateway_only_fields")
  const cacheControlNormalized = hasCacheControlNormalization(body)
  normalizeCacheControls(body)
  if (cacheControlNormalized) {
    normalizationClasses.push("cache_control")
  }

  const sanitizedHeaders = sanitizeAnthropicRequestHeaderOptions(options)

  return {
    body,
    normalizationClasses,
    headers: {
      ...sanitizedHeaders,
      anthropicVersion:
        sanitizedHeaders.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
    },
  }
}

function hasCacheControlNormalization(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasCacheControlNormalization(item))
  }
  if (!isRecord(value)) return false

  for (const [key, nested] of Object.entries(value)) {
    if (
      key === "cache_control"
      && (!isRecord(nested)
        || nested.type !== "ephemeral"
        || (nested.ttl !== undefined
          && nested.ttl !== "5m"
          && nested.ttl !== "1h")
        || Object.keys(nested).some(
          (nestedKey) => nestedKey !== "type" && nestedKey !== "ttl",
        ))
    ) {
      return true
    }
    if (hasCacheControlNormalization(nested)) return true
  }
  return false
}

function normalizeCacheControls(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeCacheControls(item)
    return
  }
  if (!isRecord(value)) return

  for (const [key, nested] of Object.entries(value)) {
    if (key === "cache_control") {
      if (!isRecord(nested) || nested.type !== "ephemeral") {
        Reflect.deleteProperty(value, key)
        continue
      }
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
