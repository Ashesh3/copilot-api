import type { CopilotContractNormalizationClass } from "~/lib/copilot-contract-observability"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { LocalHTTPError } from "~/lib/error"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const SUPPORTED_CHAT_ROLES = new Set([
  "assistant",
  "developer",
  "system",
  "tool",
  "user",
])

function createInvalidChatBodyError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_type",
    message: "The request body must be a JSON object.",
    param: "body",
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  try {
    return (
      !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    )
  } catch {
    return false
  }
}

function createChatValidationError(options: {
  code: string
  message: string
  param: string
}): LocalHTTPError {
  const clientBody = {
    error: {
      code: options.code,
      message: options.message,
      param: options.param,
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    options.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

function normalizeFunctionParameters(value: unknown): Record<string, unknown> {
  const parameters = isRecord(value) ? value : {}
  if (!parameters.type) parameters.type = "object"
  if (!isRecord(parameters.properties)) parameters.properties = {}
  return parameters
}

function validateMessages(messages: ChatCompletionsPayload["messages"]): void {
  const seenToolCallIds = new Set<string>()
  let pendingToolCallIds: Array<string> = []
  for (const message of messages as Array<unknown>) {
    if (!isRecord(message)) throw createInvalidMessagesError()
    validateMessageRole(message)
    pendingToolCallIds = validateToolHistoryMessage({
      message,
      pendingToolCallIds,
      seenToolCallIds,
    })
    validateMessageContent(message)
  }
  if (pendingToolCallIds.length > 0) throw createInvalidToolHistoryError()
}

function validateMessageRole(message: Record<string, unknown>): void {
  if (
    typeof message.role !== "string"
    || !SUPPORTED_CHAT_ROLES.has(message.role)
  ) {
    throw createInvalidMessageRoleError()
  }
}

function validateToolHistoryMessage(options: {
  message: Record<string, unknown>
  pendingToolCallIds: Array<string>
  seenToolCallIds: Set<string>
}): Array<string> {
  const { message, pendingToolCallIds, seenToolCallIds } = options
  if (pendingToolCallIds.length > 0 && message.role !== "tool") {
    throw createInvalidToolHistoryError()
  }
  if (message.role === "assistant") {
    return validateAssistantToolCalls(message.tool_calls, seenToolCallIds)
  }
  if (message.role === "tool") {
    return consumeToolResult(message, pendingToolCallIds)
  }
  return pendingToolCallIds
}

function validateMessageContent(message: Record<string, unknown>): void {
  if (!hasOwn(message, "content")) return
  const content = message.content
  if (typeof content === "string" || content === null) return
  if (!Array.isArray(content)) throw createInvalidMessagesError()
  for (const part of content) {
    if (part === null) throw createInvalidMessagesError()
    if (!isRecord(part)) throw createInvalidMessagesError()
    if (!hasOwn(part, "type") || typeof part.type !== "string") {
      throw createInvalidMessagesError()
    }
    validateKnownContentPart(part)
  }
}

function createInvalidMessageRoleError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_value",
    message: "Each message must use a supported role.",
    param: "messages",
  })
}

function createInvalidToolHistoryError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_value",
    message: "Tool calls and tool results must be complete and ordered.",
    param: "messages",
  })
}

function validateAssistantToolCalls(
  toolCalls: unknown,
  seenToolCallIds: Set<string>,
): Array<string> {
  if (toolCalls === undefined || toolCalls === null) return []
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw createInvalidToolHistoryError()
  }

  const pending: Array<string> = []
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || toolCall.type !== "function") {
      throw createInvalidToolHistoryError()
    }
    if (
      typeof toolCall.id !== "string"
      || toolCall.id.trim() === ""
      || seenToolCallIds.has(toolCall.id)
      || !isRecord(toolCall.function)
      || typeof toolCall.function.name !== "string"
      || toolCall.function.name.trim() === ""
      || typeof toolCall.function.arguments !== "string"
    ) {
      throw createInvalidToolHistoryError()
    }
    seenToolCallIds.add(toolCall.id)
    pending.push(toolCall.id)
  }
  return pending
}

function consumeToolResult(
  message: Record<string, unknown>,
  pendingToolCallIds: Array<string>,
): Array<string> {
  const expected = pendingToolCallIds[0]
  if (
    typeof message.tool_call_id !== "string"
    || message.tool_call_id !== expected
  ) {
    throw createInvalidToolHistoryError()
  }
  return pendingToolCallIds.slice(1)
}

function validateKnownContentPart(part: Record<string, unknown>): void {
  switch (part.type) {
    case "text": {
      validateTextContentPart(part)
      return
    }
    case "image_url": {
      validateImageContentPart(part)
      return
    }
    case "file": {
      validateFileContentPart(part)
      return
    }
    case "document": {
      validateDocumentContentPart(part)
      return
    }
    default: {
      return
    }
  }
}

function validateTextContentPart(part: Record<string, unknown>): void {
  if (typeof part.text !== "string") throw createInvalidMessagesError()
}

function validateImageContentPart(part: Record<string, unknown>): void {
  const image = part.image_url
  if (!isRecord(image) || typeof image.url !== "string") {
    throw createInvalidMessagesError()
  }
  if (image.url.trim().length === 0) throw createInvalidMessagesError()
  if (
    image.detail !== undefined
    && image.detail !== "low"
    && image.detail !== "high"
    && image.detail !== "auto"
  ) {
    throw createInvalidMessagesError()
  }
}

function validateFileContentPart(part: Record<string, unknown>): void {
  const file = part.file
  if (!isRecord(file)) return
  if (
    !isOptionalString(file.filename)
    || !isOptionalString(file.file_data)
    || !isOptionalString(file.file_id)
  ) {
    throw createInvalidMessagesError()
  }
}

function validateDocumentContentPart(part: Record<string, unknown>): void {
  if (hasOwn(part, "source") && !isRecord(part.source)) {
    throw createInvalidMessagesError()
  }
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string"
}

function createInvalidMessagesError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_type",
    message:
      "Each message content must be a string, null, or a valid content-part array.",
    param: "messages",
  })
}

function validateToolsContainer(tools: unknown): void {
  if (tools === undefined || tools === null || Array.isArray(tools)) return
  throw createChatValidationError({
    code: "invalid_type",
    message: "The tools field must be an array or null.",
    param: "tools",
  })
}

function validateTools(tools: ChatCompletionsPayload["tools"]): Set<string> {
  const functionNames = new Set<string>()
  if (!Array.isArray(tools)) return functionNames

  for (const tool of tools as Array<unknown>) {
    if (
      !isRecord(tool)
      || typeof tool.type !== "string"
      || tool.type.trim().length === 0
    ) {
      throw createInvalidToolsError()
    }
    if (tool.type !== "function") continue

    const func = tool.function
    if (
      !isRecord(func)
      || typeof func.name !== "string"
      || func.name.trim().length === 0
      || (func.description !== undefined
        && typeof func.description !== "string")
      || !isRecord(func.parameters)
    ) {
      throw createInvalidToolsError()
    }
    functionNames.add(func.name)
  }

  return functionNames
}

function createInvalidToolsError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_type",
    message: "Each tools entry must be a valid tool definition.",
    param: "tools",
  })
}

function validateToolChoice(
  toolChoice: ChatCompletionsPayload["tool_choice"],
  functionNames: Set<string>,
): void {
  if (
    toolChoice === undefined
    || toolChoice === null
    || toolChoice === "none"
  ) {
    return
  }

  if (functionNames.size === 0) throw createInvalidToolChoiceError()
  if (typeof toolChoice === "string") {
    return
  }
  if (!isRecord(toolChoice)) throw createInvalidToolChoiceError()
  if (toolChoice.type !== "function") {
    if (typeof toolChoice.type !== "string" || toolChoice.type.trim() === "") {
      throw createInvalidToolChoiceError()
    }
    return
  }
  if (!isMatchingFunctionToolChoice(toolChoice, functionNames)) {
    throw createInvalidToolChoiceError()
  }
}

function isMatchingFunctionToolChoice(
  toolChoice: Record<string, unknown>,
  functionNames: Set<string>,
): boolean {
  if (!isRecord(toolChoice.function)) return false
  const name = toolChoice.function.name
  return (
    typeof name === "string"
    && name.trim().length > 0
    && functionNames.has(name)
  )
}

function createInvalidToolChoiceError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_value",
    message:
      "The tool_choice field must select a declared function when tools are used.",
    param: "tool_choice",
  })
}

function normalizeModernFunctionTools(
  payload: ChatCompletionsPayload,
): boolean {
  if (!Array.isArray(payload.tools)) return false

  let changed = false
  for (const tool of payload.tools as Array<unknown>) {
    if (!isRecord(tool) || tool.type !== "function") continue
    if (!isRecord(tool.function)) continue
    const parameters = tool.function.parameters
    if (!isRecord(parameters)) {
      tool.function.parameters = normalizeFunctionParameters(parameters)
      changed = true
      continue
    }
    if (!parameters.type) {
      parameters.type = "object"
      changed = true
    }
    if (!isRecord(parameters.properties)) {
      parameters.properties = {}
      changed = true
    }
  }
  return changed
}

function normalizeDeprecatedFunctions(
  payload: ChatCompletionsPayload,
): boolean {
  const legacyFunctions = payload.functions
  if (legacyFunctions === undefined || legacyFunctions === null) {
    const changed = hasOwn(payload, "functions")
    delete payload.functions
    return changed
  }
  if (!Array.isArray(legacyFunctions)) {
    throw createChatValidationError({
      code: "invalid_type",
      message: "The functions field must be an array.",
      param: "functions",
    })
  }

  const converted = legacyFunctions.map((legacyFunction) => {
    if (!isRecord(legacyFunction)) {
      throw createInvalidLegacyFunctionError()
    }
    const { description, name, parameters } = legacyFunction
    if (typeof name !== "string" || name.trim().length === 0) {
      throw createInvalidLegacyFunctionError()
    }
    if (description !== undefined && typeof description !== "string") {
      throw createInvalidLegacyFunctionError()
    }

    return {
      type: "function" as const,
      function: {
        name,
        ...(description === undefined ? {} : { description }),
        parameters: normalizeFunctionParameters(parameters),
      },
    }
  })

  if (converted.length > 0) {
    payload.tools = [
      ...(Array.isArray(payload.tools) ? payload.tools : []),
      ...converted,
    ]
  }
  delete payload.functions
  return true
}

function createInvalidLegacyFunctionError(): LocalHTTPError {
  return createChatValidationError({
    code: "invalid_type",
    message: "Each functions entry must be a valid function definition.",
    param: "functions",
  })
}

function normalizeDeprecatedFunctionCall(
  payload: ChatCompletionsPayload,
): boolean {
  if (!hasOwn(payload, "function_call")) return false

  const functionCall = payload.function_call
  let converted: ChatCompletionsPayload["tool_choice"]
  if (functionCall === null) {
    converted = undefined
  } else if (functionCall === "none" || functionCall === "auto") {
    converted = functionCall
  } else if (
    isRecord(functionCall)
    && typeof functionCall.name === "string"
    && functionCall.name.trim().length > 0
  ) {
    converted = {
      type: "function",
      function: { name: functionCall.name },
    }
  } else {
    throw createChatValidationError({
      code: "invalid_value",
      message: "The function_call field must select a valid function.",
      param: "function_call",
    })
  }

  if (payload.tool_choice === undefined && converted !== undefined) {
    payload.tool_choice = converted
  }
  delete payload.function_call
  return true
}

export interface PreparedChatCompletionsRequest {
  payload: ChatCompletionsPayload
  normalizationClasses: Array<CopilotContractNormalizationClass>
}

export function prepareChatCompletionsRequest(
  payload: ChatCompletionsPayload,
): PreparedChatCompletionsRequest {
  if (!isPlainRecord(payload)) throw createInvalidChatBodyError()

  let normalized: ChatCompletionsPayload
  try {
    normalized = structuredClone(payload)
    JSON.stringify(normalized)
  } catch {
    throw createInvalidChatBodyError()
  }

  if (typeof normalized.model !== "string" || normalized.model.trim() === "") {
    throw createChatValidationError({
      code: "invalid_value",
      message: "The model field must be a non-empty string.",
      param: "model",
    })
  }
  if (!Array.isArray(normalized.messages) || normalized.messages.length === 0) {
    throw createChatValidationError({
      code: "invalid_value",
      message: "The messages field must be a non-empty array.",
      param: "messages",
    })
  }
  validateMessages(normalized.messages)
  validateToolsContainer(normalized.tools)
  if (
    normalized.max_tokens !== undefined
    && normalized.max_tokens !== null
    && normalized.max_completion_tokens !== undefined
    && normalized.max_completion_tokens !== null
  ) {
    throw createChatValidationError({
      code: "invalid_request",
      message: "max_tokens and max_completion_tokens are mutually exclusive.",
      param: "max_tokens",
    })
  }

  const normalizationClasses: Array<CopilotContractNormalizationClass> = []
  if (normalizeModernFunctionTools(normalized)) {
    normalizationClasses.push("function_parameters")
  }
  if (normalizeDeprecatedFunctions(normalized)) {
    normalizationClasses.push("deprecated_functions")
  }
  if (normalizeDeprecatedFunctionCall(normalized)) {
    normalizationClasses.push("deprecated_function_call")
  }
  const functionNames = validateTools(normalized.tools)
  validateToolChoice(normalized.tool_choice, functionNames)
  return { payload: normalized, normalizationClasses }
}

export function normalizeChatCompletionsRequest(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  return prepareChatCompletionsRequest(payload).payload
}
