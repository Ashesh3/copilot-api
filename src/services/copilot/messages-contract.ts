/* eslint-disable max-lines -- exhaustive hostile-safe Messages boundary validation */
import util from "node:util"

import type { CopilotContractNormalizationClass } from "~/lib/copilot-contract-observability"

import { LocalHTTPError } from "~/lib/error"
import {
  type AnthropicContentBlock,
  asAnthropicUnknownContentType,
  asAnthropicUnknownRole,
  type AnthropicAssistantContentBlock,
  type AnthropicDocumentBlock,
  type AnthropicImageBlock,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicSystemContentBlock,
  type AnthropicTextBlock,
  type AnthropicTool,
  type AnthropicToolResultContentBlock,
  type AnthropicToolReferenceBlock,
  type AnthropicToolUseBlock,
  type AnthropicUnknownContentBlock,
  type AnthropicUserContentBlock,
  isAnthropicDocumentBlock,
  isAnthropicImageBlock,
  isAnthropicTextBlock,
  isAnthropicThinkingBlock,
  isAnthropicToolReferenceBlock,
  isAnthropicToolResultBlock,
  isAnthropicToolUseBlock,
} from "~/routes/messages/anthropic-types"

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
type SanitizedDocumentSourceContent =
  | string
  | Array<AnthropicTextBlock | AnthropicImageBlock>
type SanitizedMessageContentBlock = AnthropicContentBlock

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

function validateAnthropicMessagesPayload(
  payload: AnthropicMessagesPayload,
): void {
  if (typeof payload.model !== "string" || payload.model.trim().length === 0) {
    throw createMessagesValidationError("model")
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw createMessagesValidationError("messages")
  }
  payload.messages = sanitizeMessages(payload.messages)
  if (payload.messages.length === 0) {
    throw createMessagesValidationError("messages")
  }
  sanitizeTools(payload)
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function sanitizeTextBlock(
  block: Record<string, unknown>,
): AnthropicTextBlock | null {
  if (block.type !== "text" || typeof block.text !== "string") {
    return null
  }
  return { ...block, type: "text", text: block.text }
}

function sanitizeImageSource(
  source: unknown,
): AnthropicImageBlock["source"] | null {
  if (!isRecord(source) || typeof source.type !== "string") {
    return null
  }
  if (source.type === "url") {
    if (typeof source.url !== "string") {
      return null
    }
    return { ...source, type: "url", url: source.url }
  }
  if (
    source.type !== "base64"
    || !isNonEmptyString(source.media_type)
    || !source.media_type.startsWith("image/")
    || source.media_type.slice("image/".length).trim().length === 0
    || typeof source.data !== "string"
  ) {
    return null
  }
  return {
    ...source,
    type: "base64",
    media_type: source.media_type as `image/${string}`,
    data: source.data,
  }
}

function sanitizeImageBlock(
  block: Record<string, unknown>,
): AnthropicImageBlock | null {
  const source = sanitizeImageSource(block.source)
  if (!source) {
    return null
  }
  return { ...block, type: "image", source }
}

function sanitizeDocumentSourceContent(
  content: unknown,
): SanitizedDocumentSourceContent | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }
  const sanitized: Array<AnthropicTextBlock | AnthropicImageBlock> = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === "text") {
      const text = sanitizeTextBlock(block)
      if (text) sanitized.push(text)
      continue
    }
    if (block.type === "image") {
      const image = sanitizeImageBlock(block)
      if (image) sanitized.push(image)
    }
  }
  return sanitized
}

function sanitizeDocumentSource(
  source: unknown,
): AnthropicDocumentBlock["source"] | null {
  if (!isRecord(source) || typeof source.type !== "string") {
    return null
  }
  switch (source.type) {
    case "base64": {
      if (
        !isNonEmptyString(source.media_type)
        || typeof source.data !== "string"
      ) {
        return null
      }
      return {
        ...source,
        type: "base64",
        media_type: source.media_type,
        data: source.data,
      }
    }
    case "text": {
      if (typeof source.data !== "string") {
        return null
      }
      return {
        ...source,
        type: "text",
        data: source.data,
        ...(typeof source.media_type === "string" ?
          { media_type: source.media_type }
        : {}),
      }
    }
    case "url": {
      if (typeof source.url !== "string") {
        return null
      }
      return { ...source, type: "url", url: source.url }
    }
    case "content": {
      const content = sanitizeDocumentSourceContent(source.content)
      if (content === null) {
        return null
      }
      return { ...source, type: "content", content }
    }
    default: {
      return null
    }
  }
}

function sanitizeDocumentBlock(
  block: Record<string, unknown>,
): AnthropicDocumentBlock | null {
  const source = sanitizeDocumentSource(block.source)
  if (!source) {
    return null
  }
  return {
    ...block,
    type: "document",
    source,
    ...(typeof block.title === "string" || block.title === null ?
      { title: block.title }
    : {}),
    ...(typeof block.context === "string" || block.context === null ?
      { context: block.context }
    : {}),
    ...((
      block.citations === null
      || (isRecord(block.citations)
        && (block.citations.enabled === undefined
          || typeof block.citations.enabled === "boolean"))
    ) ?
      { citations: block.citations }
    : {}),
  }
}

function sanitizeToolReferenceBlock(
  block: Record<string, unknown>,
): AnthropicToolReferenceBlock | null {
  if (!isNonEmptyString(block.tool_name)) {
    return null
  }
  return { ...block, type: "tool_reference", tool_name: block.tool_name }
}

function sanitizeToolResultContentBlock(
  block: unknown,
): AnthropicToolResultContentBlock | null {
  if (!isRecord(block) || !isNonEmptyString(block.type)) {
    return null
  }
  switch (block.type) {
    case "text": {
      return sanitizeTextBlock(block)
    }
    case "image": {
      return sanitizeImageBlock(block)
    }
    case "document": {
      return sanitizeDocumentBlock(block)
    }
    case "tool_reference": {
      return sanitizeToolReferenceBlock(block)
    }
    default: {
      return sanitizeUnknownContentBlock(block)
    }
  }
}

function sanitizeToolResultContent(
  content: unknown,
): string | Array<AnthropicToolResultContentBlock> {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return []
  }
  const sanitized = content.flatMap((block) => {
    const normalized = sanitizeToolResultContentBlock(block)
    return normalized ? [normalized] : []
  })
  return sanitized
}

function sanitizeToolUseBlock(
  block: Record<string, unknown>,
): AnthropicToolUseBlock | null {
  if (
    !isNonEmptyString(block.id)
    || !isNonEmptyString(block.name)
    || (block.input !== null && !isRecord(block.input))
  ) {
    return null
  }
  return {
    ...block,
    type: "tool_use",
    id: block.id,
    input: block.input ?? {},
    name: block.name,
  }
}

function sanitizeThinkingBlock(
  block: Record<string, unknown>,
): AnthropicAssistantContentBlock | null {
  if (typeof block.thinking !== "string") {
    return sanitizeUnknownContentBlock(block)
  }
  return {
    ...block,
    type: "thinking",
    thinking: block.thinking,
    ...(typeof block.signature === "string" ?
      { signature: block.signature }
    : {}),
  }
}

function sanitizeUnknownContentBlock(
  block: Record<string, unknown>,
): AnthropicUnknownContentBlock {
  return {
    ...block,
    type: asAnthropicUnknownContentType(String(block.type)),
  }
}

function sanitizeCompatibleContentBlock(
  block: unknown,
): SanitizedMessageContentBlock | null {
  if (!isRecord(block) || !isNonEmptyString(block.type)) {
    return null
  }
  switch (block.type) {
    case "text": {
      return sanitizeTextBlock(block)
    }
    case "image": {
      return sanitizeImageBlock(block)
    }
    case "document": {
      return sanitizeDocumentBlock(block)
    }
    case "tool_result": {
      if (!isNonEmptyString(block.tool_use_id)) {
        return null
      }
      return {
        ...block,
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: sanitizeToolResultContent(block.content),
        ...(typeof block.is_error === "boolean" ?
          { is_error: block.is_error }
        : {}),
      }
    }
    case "tool_use": {
      return sanitizeToolUseBlock(block)
    }
    case "thinking": {
      return sanitizeThinkingBlock(block)
    }
    case "tool_reference": {
      return sanitizeToolReferenceBlock(block)
    }
    default: {
      return sanitizeUnknownContentBlock(block)
    }
  }
}

function sanitizeUserMessageContent(
  content: unknown,
): string | Array<AnthropicUserContentBlock> {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return []
  }
  const sanitizedBlocks: Array<AnthropicUserContentBlock> = []
  for (const block of content) {
    const sanitized = sanitizeCompatibleContentBlock(block)
    if (!sanitized) {
      continue
    }
    if (
      isAnthropicTextBlock(sanitized)
      || isAnthropicImageBlock(sanitized)
      || isAnthropicDocumentBlock(sanitized)
      || isAnthropicToolResultBlock(sanitized)
    ) {
      sanitizedBlocks.push(sanitized)
      continue
    }
    sanitizedBlocks.push(sanitizeUnknownContentBlock(sanitized))
  }
  return sanitizedBlocks
}

function sanitizeAssistantMessageContent(
  content: unknown,
): string | Array<AnthropicAssistantContentBlock> {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return []
  }
  const sanitizedBlocks: Array<AnthropicAssistantContentBlock> = []
  for (const block of content) {
    const sanitized = sanitizeCompatibleContentBlock(block)
    if (!sanitized) {
      continue
    }
    if (
      isAnthropicTextBlock(sanitized)
      || isAnthropicToolUseBlock(sanitized)
      || isAnthropicThinkingBlock(sanitized)
    ) {
      sanitizedBlocks.push(sanitized)
      continue
    }
    sanitizedBlocks.push(sanitizeUnknownContentBlock(sanitized))
  }
  return sanitizedBlocks
}

function sanitizeCustomMessageContent(
  content: unknown,
): AnthropicMessage["content"] {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return []
  }
  return content.flatMap((block) => {
    const sanitized = sanitizeCompatibleContentBlock(block)
    return sanitized ? [sanitized] : []
  })
}

function sanitizeMessage(message: unknown): AnthropicMessage | null {
  if (!isRecord(message) || !isNonEmptyString(message.role)) {
    return null
  }
  if (message.role === "user") {
    return {
      ...message,
      role: "user",
      content: sanitizeUserMessageContent(message.content),
    }
  }
  if (message.role === "assistant") {
    return {
      ...message,
      role: "assistant",
      content: sanitizeAssistantMessageContent(message.content),
    }
  }
  return {
    ...message,
    role: asAnthropicUnknownRole(message.role),
    content: sanitizeCustomMessageContent(message.content),
  }
}

function sanitizeMessages(
  messages: AnthropicMessagesPayload["messages"],
): AnthropicMessagesPayload["messages"] {
  return messages.flatMap((message) => {
    const sanitized = sanitizeMessage(message)
    return sanitized ? [sanitized] : []
  })
}

function sanitizeTool(tool: unknown): AnthropicTool | null {
  if (!isRecord(tool)) {
    return null
  }
  return { ...tool }
}

function sanitizeTools(payload: AnthropicMessagesPayload): void {
  if (payload.tools === undefined) {
    return
  }
  if (!Array.isArray(payload.tools)) {
    deleteOwnField(payload, "tools")
    return
  }
  const sanitized = payload.tools.flatMap((tool) => {
    const normalized = sanitizeTool(tool)
    return normalized ? [normalized] : []
  })
  if (sanitized.length === 0) {
    deleteOwnField(payload, "tools")
    return
  }
  payload.tools = sanitized
}

function sanitizeSystemBlock(
  block: unknown,
): AnthropicSystemContentBlock | null {
  if (!isRecord(block) || !isNonEmptyString(block.type)) {
    return null
  }
  if (block.type === "text") {
    return sanitizeTextBlock(block)
  }
  return { ...block, type: asAnthropicUnknownContentType(block.type) }
}

function normalizeSystem(payload: AnthropicMessagesPayload): void {
  if (payload.system === undefined || typeof payload.system === "string") return
  if (!Array.isArray(payload.system)) {
    deleteOwnField(payload, "system")
    return
  }
  const sanitized = payload.system.flatMap((block) => {
    const normalized = sanitizeSystemBlock(block)
    return normalized ? [normalized] : []
  })
  if (sanitized.length === 0) {
    deleteOwnField(payload, "system")
    return
  }
  payload.system = sanitized
}

function normalizeOptionalPayloadFields(
  payload: AnthropicMessagesPayload,
): void {
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

export function prepareAnthropicMessagesRequest(options: {
  anthropicBeta?: string
  anthropicVersion?: string
  modelProviderPreference?: string
  payload: AnthropicMessagesPayload
}): PreparedAnthropicMessagesRequest {
  const body = cloneAnthropicMessagesBody(options.payload)
  if (body.max_tokens === null) deleteOwnField(body, "max_tokens")
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
  const cacheControlNormalized = normalizeCacheControls(body)
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

function isNormalizedCacheControl(value: unknown): value is NativeCacheControl {
  return (
    isRecord(value)
    && value.type === "ephemeral"
    && (value.ttl === undefined || value.ttl === "5m" || value.ttl === "1h")
    && Object.keys(value).every((key) => key === "type" || key === "ttl")
  )
}

function normalizeCacheControlSlot(
  container: Record<string, unknown>,
): boolean {
  if (!Object.hasOwn(container, "cache_control")) {
    return false
  }
  const cacheControl = container.cache_control
  if (isNormalizedCacheControl(cacheControl)) {
    return false
  }
  if (!isRecord(cacheControl) || cacheControl.type !== "ephemeral") {
    Reflect.deleteProperty(container, "cache_control")
    return true
  }

  const normalized: NativeCacheControl = { type: "ephemeral" }
  if (cacheControl.ttl === "5m" || cacheControl.ttl === "1h") {
    normalized.ttl = cacheControl.ttl
  }
  container.cache_control = normalized
  return true
}

function normalizeToolResultCacheControls(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false
  }
  let normalized = false
  for (const block of content) {
    normalized = normalizeContentBlockCacheControls(block) || normalized
  }
  return normalized
}

function normalizeDocumentSourceContentCacheControls(
  block: AnthropicDocumentBlock,
): boolean {
  if (block.source.type !== "content" || !Array.isArray(block.source.content)) {
    return false
  }
  let normalized = false
  for (const nestedBlock of block.source.content) {
    if (
      !isAnthropicTextBlock(nestedBlock)
      && !isAnthropicImageBlock(nestedBlock)
    ) {
      continue
    }
    normalized = normalizeCacheControlSlot(nestedBlock) || normalized
  }
  return normalized
}

function normalizeContentBlockCacheControls(block: unknown): boolean {
  if (
    isAnthropicTextBlock(block)
    || isAnthropicImageBlock(block)
    || isAnthropicToolReferenceBlock(block)
    || isAnthropicToolUseBlock(block)
    || isAnthropicThinkingBlock(block)
  ) {
    return normalizeCacheControlSlot(block)
  }
  if (isAnthropicDocumentBlock(block)) {
    let normalized = normalizeCacheControlSlot(block)
    normalized =
      normalizeDocumentSourceContentCacheControls(block) || normalized
    return normalized
  }
  if (isAnthropicToolResultBlock(block)) {
    let normalized = normalizeCacheControlSlot(block)
    normalized = normalizeToolResultCacheControls(block.content) || normalized
    return normalized
  }
  return false
}

function normalizeSystemCacheControls(system: unknown): boolean {
  if (!Array.isArray(system)) {
    return false
  }
  let normalized = false
  for (const block of system) {
    if (!isAnthropicTextBlock(block)) {
      continue
    }
    normalized = normalizeCacheControlSlot(block) || normalized
  }
  return normalized
}

function normalizeMessageCacheControls(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false
  }
  let normalized = false
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      continue
    }
    for (const block of message.content) {
      normalized = normalizeContentBlockCacheControls(block) || normalized
    }
  }
  return normalized
}

function normalizeToolCacheControls(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false
  }
  let normalized = false
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue
    }
    normalized = normalizeCacheControlSlot(tool) || normalized
  }
  return normalized
}

function normalizeCacheControls(body: Record<string, unknown>): boolean {
  let normalized = normalizeCacheControlSlot(body)
  normalized = normalizeSystemCacheControls(body.system) || normalized
  normalized = normalizeMessageCacheControls(body.messages) || normalized
  normalized = normalizeToolCacheControls(body.tools) || normalized
  return normalized
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
