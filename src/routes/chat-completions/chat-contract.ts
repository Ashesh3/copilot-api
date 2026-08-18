import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { LocalHTTPError } from "~/lib/error"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

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
  for (const message of messages as Array<unknown>) {
    if (!isRecord(message)) throw createInvalidMessagesError()
    if (!hasOwn(message, "content")) continue
    const content = message.content
    if (typeof content === "string" || content === null) continue
    if (!Array.isArray(content)) throw createInvalidMessagesError()
    for (const part of content) {
      if (part === null) continue
      if (!isRecord(part)) throw createInvalidMessagesError()
      if (!hasOwn(part, "type") || typeof part.type !== "string") {
        throw createInvalidMessagesError()
      }
      validateKnownContentPart(part)
    }
  }
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

function normalizeModernFunctionTools(payload: ChatCompletionsPayload): void {
  if (!Array.isArray(payload.tools)) return

  for (const tool of payload.tools as Array<unknown>) {
    if (!isRecord(tool) || tool.type !== "function") continue
    if (!isRecord(tool.function)) continue
    tool.function.parameters = normalizeFunctionParameters(
      tool.function.parameters,
    )
  }
}

function normalizeDeprecatedFunctions(payload: ChatCompletionsPayload): void {
  const legacyFunctions = payload.functions
  if (legacyFunctions === undefined || legacyFunctions === null) {
    delete payload.functions
    return
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
): void {
  if (!hasOwn(payload, "function_call")) return

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
}

export function normalizeChatCompletionsRequest(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
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

  normalizeModernFunctionTools(normalized)
  normalizeDeprecatedFunctions(normalized)
  normalizeDeprecatedFunctionCall(normalized)
  const functionNames = validateTools(normalized.tools)
  validateToolChoice(normalized.tool_choice, functionNames)
  return normalized
}
