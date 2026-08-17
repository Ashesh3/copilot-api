import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { LocalHTTPError } from "~/lib/error"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

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
  const normalized = structuredClone(payload)

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
  return normalized
}
