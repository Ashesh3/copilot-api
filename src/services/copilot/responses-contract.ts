import { LocalHTTPError } from "~/lib/error"
import { getUnsupportedRequestParameters } from "~/lib/model-settings"

import type { ResponseInputMessage, ResponsesPayload } from "./create-responses"

export type ResponsesWireBody = ResponsesPayload & Record<string, unknown>

export interface PreparedResponsesRequest {
  body: ResponsesWireBody
  normalizationClasses: Array<string>
}

export function applyResponsesReasoningDefaults(options: {
  body: ResponsesWireBody
  defaultEffort: string | undefined
  implicitDefault: boolean
}): void {
  const { body, defaultEffort, implicitDefault } = options
  const reasoning = body.reasoning ?? {}
  body.reasoning = reasoning

  if (implicitDefault && typeof reasoning.effort !== "number") {
    delete reasoning.effort
  } else {
    reasoning.effort ??= defaultEffort
  }

  if (reasoning.effort === "none") {
    delete reasoning.summary
    if (body.include) {
      body.include = body.include.filter(
        (item) => item !== "reasoning.encrypted_content",
      )
    }
    return
  }

  reasoning.summary ??= "auto"
  const include = body.include ? [...body.include] : []
  if (!include.includes("reasoning.encrypted_content")) {
    include.push("reasoning.encrypted_content")
  }
  body.include = include
}

const RESPONSES_TOP_LEVEL_FIELDS = [
  "model",
  "input",
  "instructions",
  "max_output_tokens",
  "metadata",
  "user",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "temperature",
  "top_p",
  "include",
  "context_management",
  "truncation",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "safety_identifier",
  "snippy",
  "multi_agent",
  "store",
  "background",
  "previous_response_id",
  "service_tier",
  "stream",
  "prompt",
  "conversation_id",
  "generate",
  "client_metadata",
  "task_budget",
  "copilot_cache_control",
] as const

const OMIT_FIELD = Symbol("omit Responses field")
const JSON_OBJECT_INPUT_INSTRUCTION = "Respond with JSON."
const COPILOT_RESPONSES_MIN_OUTPUT_TOKENS = 16

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export function createResponsesValidationError(options: {
  code: string
  message: string
  param?: string
  status?: 400
}): LocalHTTPError {
  const clientBody = {
    error: {
      code: options.code,
      message: options.message,
      ...(options.param ? { param: options.param } : {}),
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    options.message,
    Response.json(clientBody, { status: options.status ?? 400 }),
    clientBody,
  )
}

export function prepareResponsesRequest(
  payload: ResponsesPayload,
): PreparedResponsesRequest {
  validateStatefulControls(payload)
  validateResponsesContextManagement(payload.context_management)

  const body = {} as ResponsesWireBody
  for (const field of RESPONSES_TOP_LEVEL_FIELDS) {
    const value = normalizeStatefulField(field, payload[field])
    if (value === OMIT_FIELD || value === undefined) continue
    ;(body as Record<string, unknown>)[field] = structuredClone(value)
  }

  ensureJsonObjectInputMentionsJson(body)
  normalizeFunctionToolParameters(body)
  normalizeEmptyToolControls(body)
  normalizeJsonSchemaResponseFormat(body)
  clampMaxOutputTokens(body)

  return { body, normalizationClasses: [] }
}

export function validateResponsesContextManagement(value: unknown): void {
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: "The context_management field must be an array.",
      param: "context_management",
    })
  }

  for (const item of value) {
    if (!isRecord(item) || Array.isArray(item)) {
      throw createResponsesValidationError({
        code: "invalid_type",
        message: "Each context_management item must be an object.",
        param: "context_management",
      })
    }
    if (item.type !== "compaction" && item.type !== "truncate") {
      throw createResponsesValidationError({
        code: "unsupported_value",
        message: "The context_management type must be compaction or truncate.",
        param: "context_management",
      })
    }
  }
}

export function removeUnsupportedResponsesRequestParameters(
  payload: ResponsesWireBody,
): void {
  const unsupported = new Set(getUnsupportedRequestParameters(payload.model))
  if (
    payload.model.startsWith("gpt-5.6-")
    && payload.reasoning?.effort !== "none"
  ) {
    unsupported.add("temperature")
    unsupported.add("top_p")
  }

  for (const parameter of unsupported) {
    switch (parameter) {
      case "temperature": {
        delete payload.temperature
        break
      }
      case "top_p": {
        delete payload.top_p
        break
      }
      default: {
        break
      }
    }
  }
}

function validateStatefulControls(payload: ResponsesPayload): void {
  validateBooleanStatefulControl({
    param: "store",
    value: payload.store,
    invalidTypeMessage: "The store field must be a boolean.",
    unsupportedMessage:
      "The Copilot Responses endpoint does not support stored responses.",
  })
  validateBooleanStatefulControl({
    param: "background",
    value: payload.background,
    invalidTypeMessage: "The background field must be a boolean.",
    unsupportedMessage:
      "The Copilot Responses endpoint does not support background requests.",
  })
  validateStringStatefulControl({
    param: "previous_response_id",
    value: payload.previous_response_id,
    invalidTypeMessage: "The previous_response_id field must be a string.",
    unsupportedMessage:
      "The Copilot Responses endpoint does not support previous-response continuation.",
  })
  validateStringStatefulControl({
    param: "service_tier",
    value: payload.service_tier,
    invalidTypeMessage: "The service_tier field must be a string.",
    unsupportedMessage:
      "The Copilot Responses endpoint does not support service tiers.",
  })
}

function validateBooleanStatefulControl(options: {
  param: "background" | "store"
  value: unknown
  invalidTypeMessage: string
  unsupportedMessage: string
}): void {
  if (
    options.value === undefined
    || options.value === null
    || options.value === false
  ) {
    return
  }
  if (typeof options.value !== "boolean") {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: options.invalidTypeMessage,
      param: options.param,
    })
  }
  throw createResponsesValidationError({
    code: "unsupported_value",
    message: options.unsupportedMessage,
    param: options.param,
  })
}

function validateStringStatefulControl(options: {
  param: "previous_response_id" | "service_tier"
  value: unknown
  invalidTypeMessage: string
  unsupportedMessage: string
}): void {
  if (options.value === undefined || options.value === null) return
  if (typeof options.value !== "string") {
    throw createResponsesValidationError({
      code: "invalid_type",
      message: options.invalidTypeMessage,
      param: options.param,
    })
  }
  throw createResponsesValidationError({
    code: "unsupported_value",
    message: options.unsupportedMessage,
    param: options.param,
  })
}

function normalizeStatefulField(
  field: (typeof RESPONSES_TOP_LEVEL_FIELDS)[number],
  value: unknown,
): unknown {
  if (field === "store") return value === false ? false : OMIT_FIELD
  if (field === "context_management" && value === null) return OMIT_FIELD
  if (
    field === "background"
    || field === "previous_response_id"
    || field === "service_tier"
  ) {
    return OMIT_FIELD
  }
  return value
}

function normalizeEmptyToolControls(payload: ResponsesWireBody): void {
  if (Array.isArray(payload.tools) && payload.tools.length > 0) return

  delete payload.tools
  delete payload.tool_choice
  delete payload.parallel_tool_calls
}

function clampMaxOutputTokens(payload: ResponsesWireBody): void {
  if (
    typeof payload.max_output_tokens === "number"
    && payload.max_output_tokens < COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  ) {
    payload.max_output_tokens = COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  }
}

function ensureJsonObjectInputMentionsJson(payload: ResponsesWireBody): void {
  if (payload.text?.format?.type !== "json_object") return
  if (inputMentionsJson(payload.input)) return

  const instruction: ResponseInputMessage = {
    type: "message",
    role: "developer",
    content: JSON_OBJECT_INPUT_INSTRUCTION,
  }

  if (Array.isArray(payload.input)) {
    payload.input = [instruction, ...payload.input]
    return
  }

  if (typeof payload.input === "string") {
    payload.input = [
      instruction,
      { type: "message", role: "user", content: payload.input },
    ]
    return
  }

  payload.input = [instruction]
}

function inputMentionsJson(input: ResponsesPayload["input"]): boolean {
  if (typeof input === "string") return containsJson(input)
  if (!Array.isArray(input)) return false

  return input.some((item) => {
    if (!isRecord(item)) return false
    if (!("content" in item)) return false
    return contentMentionsJson(item.content)
  })
}

function contentMentionsJson(content: unknown): boolean {
  if (typeof content === "string") return containsJson(content)
  if (!Array.isArray(content)) return false

  return content.some((part) => {
    if (typeof part === "string") return containsJson(part)
    return isRecord(part) && containsJson(part.text)
  })
}

function containsJson(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().includes("json")
}

function normalizeFunctionToolParameters(payload: ResponsesWireBody): void {
  if (!Array.isArray(payload.tools)) return

  for (const tool of payload.tools) {
    if (!isRecord(tool) || tool.type !== "function") continue

    if (!isRecord(tool.parameters) || Array.isArray(tool.parameters)) {
      tool.parameters = { type: "object", properties: {} }
      continue
    }

    tool.parameters.type ??= "object"
    if (!isRecord(tool.parameters.properties)) {
      tool.parameters.properties = {}
    }
  }
}

function normalizeJsonSchemaResponseFormat(payload: ResponsesWireBody): void {
  const format = payload.text?.format
  if (!isRecord(format) || format.type !== "json_schema") return

  normalizeJsonSchemaObject(format.schema)
}

function normalizeJsonSchemaObject(
  schema: unknown,
  seen = new Set<object>(),
): void {
  if (!isRecord(schema)) return
  if (seen.has(schema)) return
  seen.add(schema)

  if (schema.type === "object" || isRecord(schema.properties)) {
    if (schema.additionalProperties === undefined) {
      schema.additionalProperties = false
    }
    normalizeJsonSchemaRequired(schema)
  }

  normalizeSchemaMap(schema.properties, seen)
  normalizeSchemaMap(schema.patternProperties, seen)
  normalizeSchemaMap(schema.$defs, seen)
  normalizeSchemaMap(schema.definitions, seen)
  normalizeSchemaValue(schema.items, seen)
  normalizeSchemaValue(schema.additionalItems, seen)
  normalizeSchemaValue(schema.contains, seen)
  normalizeSchemaValue(schema.propertyNames, seen)
  normalizeSchemaValue(schema.not, seen)
  normalizeSchemaValue(schema.if, seen)
  normalizeSchemaValue(schema.then, seen)
  normalizeSchemaValue(schema.else, seen)
  normalizeSchemaArray(schema.anyOf, seen)
  normalizeSchemaArray(schema.oneOf, seen)
  normalizeSchemaArray(schema.allOf, seen)
}

function normalizeJsonSchemaRequired(schema: Record<string, unknown>): void {
  if (!isRecord(schema.properties)) return

  const propertyKeys = Object.keys(schema.properties)
  if (propertyKeys.length === 0) return

  const existingRequired =
    Array.isArray(schema.required) ?
      schema.required.filter((key): key is string => typeof key === "string")
    : []
  const required = new Set(existingRequired)

  for (const key of propertyKeys) {
    required.add(key)
  }

  schema.required = [...required]
}

function normalizeSchemaMap(value: unknown, seen: Set<object>): void {
  if (!isRecord(value)) return

  for (const schema of Object.values(value)) {
    normalizeJsonSchemaObject(schema, seen)
  }
}

function normalizeSchemaArray(value: unknown, seen: Set<object>): void {
  if (!Array.isArray(value)) return

  for (const schema of value) {
    normalizeJsonSchemaObject(schema, seen)
  }
}

function normalizeSchemaValue(value: unknown, seen: Set<object>): void {
  if (Array.isArray(value)) {
    normalizeSchemaArray(value, seen)
    return
  }

  normalizeJsonSchemaObject(value, seen)
}
