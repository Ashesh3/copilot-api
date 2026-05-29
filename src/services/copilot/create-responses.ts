import consola from "consola"
import { events } from "fetch-event-stream"

import { routedFetch } from "~/lib/account-router"
import { getReasoningEffortForModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { getUnsupportedRequestParameters } from "~/lib/model-settings"
import { usesImplicitReasoningDefault } from "~/lib/model-suffix"

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem>
  prompt?: string | Record<string, unknown> | null
  conversation_id?: string | null
  tools?: Array<Tool> | null
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  metadata?: Metadata | null
  stream?: boolean | null
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  parallel_tool_calls?: boolean | null
  store?: boolean | null
  text?: {
    format?: { type: string; [key: string]: unknown } | null
  } | null
  generate?: boolean | null
  task_budget?: {
    type: "tokens"
    total: number
    remaining?: number
  } | null
  previous_response_id?: string | null
  reasoning?: Reasoning | null
  include?: Array<ResponseIncludable>
  service_tier?: string | null // NOTE: Unsupported by GitHub Copilot
  [key: string]: unknown
}

export type ToolChoiceOptions = "none" | "auto" | "required"

export interface ToolChoiceFunction {
  name: string
  type: "function"
}

export type Tool = FunctionTool | Record<string, unknown>

export interface FunctionTool {
  name: string
  parameters: { [key: string]: unknown } | null
  strict: boolean | null
  type: "function"
  description?: string | null
}

export type ResponseIncludable =
  | "file_search_call.results"
  | "message.input_image.image_url"
  | "computer_call_output.output.image_url"
  | "reasoning.encrypted_content"
  | "code_interpreter_call.outputs"

export interface Reasoning {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
  summary?: "auto" | "concise" | "detailed" | null
}

export interface ResponseInputMessage {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content?: string | Array<ResponseInputContent>
  status?: string
  phase?: "commentary" | "final_answer"
}

export interface ResponseFunctionToolCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string | Array<ResponseInputContent>
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseInputReasoning {
  id?: string
  type: "reasoning"
  summary: Array<{
    type: "summary_text"
    text: string
  }>
  encrypted_content: string
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseInputReasoning
  | Record<string, unknown>

export type ResponseInputContent =
  | ResponseInputText
  | ResponseInputImage
  | Record<string, unknown>

export interface ResponseInputText {
  type: "input_text" | "output_text"
  text: string
}

export interface ResponseInputImage {
  type: "input_image"
  image_url?: string | null
  file_id?: string | null
  detail: "low" | "high" | "auto"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

function isInputImage(value: unknown): value is ResponseInputImage {
  return isRecord(value) && value.type === "input_image"
}

function hasArrayContent(
  item: ResponseInputItem,
): item is ResponseInputMessage & { content: Array<ResponseInputContent> } {
  return isRecord(item) && Array.isArray(item.content)
}

function removeInputImages(payload: ResponsesPayload): boolean {
  if (!Array.isArray(payload.input)) {
    return false
  }

  let removedImages = false
  const filteredInput: Array<ResponseInputItem> = []
  for (const item of payload.input) {
    if (isInputImage(item)) {
      removedImages = true
      continue
    }

    if (hasArrayContent(item)) {
      const filteredContent: Array<ResponseInputContent> = []
      for (const part of item.content) {
        if (isInputImage(part)) {
          removedImages = true
          continue
        }
        filteredContent.push(part)
      }
      if (filteredContent.length === 0) {
        continue
      }
      filteredInput.push({ ...item, content: filteredContent })
      continue
    }

    filteredInput.push(item)
  }
  payload.input = filteredInput

  return removedImages && payload.input.length > 0
}

export interface ResponsesResult {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponseOutputItem>
  output_text: string
  status: string
  usage?: ResponseUsage | null
  error: ResponseError | null
  incomplete_details: IncompleteDetails | null
  instructions: string | null
  metadata: Metadata | null
  parallel_tool_calls: boolean
  temperature: number | null
  tool_choice: unknown
  tools: Array<Tool>
  top_p: number | null
}

export type Metadata = { [key: string]: string }

export interface IncompleteDetails {
  reason?: "max_output_tokens" | "content_filter"
}

export interface ResponseError {
  message: string
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputReasoning
  | ResponseOutputFunctionCall

export interface ResponseOutputMessage {
  id: string
  type: "message"
  role: "assistant"
  status: "completed" | "in_progress" | "incomplete"
  content?: Array<ResponseOutputContentBlock>
}

export interface ResponseOutputReasoning {
  id: string
  type: "reasoning"
  summary?: Array<ResponseReasoningBlock>
  content?: Array<ResponseReasoningBlock>
  encrypted_content?: string
  status?: "completed" | "in_progress" | "incomplete"
}

export interface ResponseReasoningBlock {
  type: string
  text?: string
}

export interface ResponseOutputFunctionCall {
  id?: string
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
}

export type ResponseOutputContentBlock =
  | ResponseOutputText
  | ResponseOutputRefusal
  | Record<string, unknown>

export interface ResponseOutputText {
  type: "output_text"
  text: string
  annotations: Array<unknown>
}

export interface ResponseOutputRefusal {
  type: "refusal"
  refusal: string
}

export interface ResponseUsage {
  input_tokens: number
  output_tokens?: number
  total_tokens: number
  input_tokens_details?: {
    cached_tokens: number
  }
  output_tokens_details?: {
    reasoning_tokens: number
  }
}

export type ResponseStreamEvent =
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseCreatedEvent
  | ResponseErrorEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseFailedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseReasoningTextDeltaEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent

export interface ResponseCompletedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.completed"
}

export interface ResponseIncompleteEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.incomplete"
}

export interface ResponseCreatedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.created"
}

export interface ResponseErrorEvent {
  code: string | null
  message: string
  param: string | null
  sequence_number: number
  type: "error"
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.delta"
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  arguments: string
  item_id: string
  name: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.done"
}

export interface ResponseFailedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.failed"
}

export interface ResponseOutputItemAddedEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.added"
}

export interface ResponseOutputItemDoneEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.done"
}

export interface ResponseReasoningSummaryTextDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_text.delta"
}

export interface ResponseReasoningTextDeltaEvent {
  content_index: number
  delta: string
  item_id?: string
  output_index?: number
  sequence_number: number
  type: "response.reasoning_text.delta"
}

export interface ResponseReasoningSummaryTextDoneEvent {
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  text: string
  type: "response.reasoning_summary_text.done"
}

export interface ResponseTextDeltaEvent {
  content_index: number
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.output_text.delta"
}

export interface ResponseTextDoneEvent {
  content_index: number
  item_id: string
  output_index: number
  sequence_number: number
  text: string
  type: "response.output_text.done"
}

export type ResponsesStream = ReturnType<typeof events>
export type CreateResponsesReturn = ResponsesResult | ResponsesStream

interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
  signal?: AbortSignal
}

/**
 * Known fields accepted by the Copilot Responses API.
 * Any field not in this set is stripped before forwarding to prevent 400 errors.
 */
const KNOWN_RESPONSES_FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "prompt",
  "conversation_id",
  "generate",
  "client_metadata",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "max_output_tokens",
  "metadata",
  "stream",
  "safety_identifier",
  "prompt_cache_key",
  "parallel_tool_calls",
  "store",
  "text",
  "task_budget",
  "previous_response_id",
  "reasoning",
  "include",
  "copilot_cache_control",
])

function sanitizeResponsesPayload(
  payload: ResponsesPayload,
): Record<string, unknown> {
  normalizeFunctionToolParameters(payload)
  normalizeJsonSchemaResponseFormat(payload)
  removeUnsupportedRequestParameters(payload)

  const result: Record<string, unknown> = {}
  for (const key of KNOWN_RESPONSES_FIELDS) {
    if (key in payload && payload[key] !== undefined) {
      result[key] = payload[key]
    }
  }
  return result
}

function normalizeFunctionToolParameters(payload: ResponsesPayload): void {
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

function normalizeJsonSchemaResponseFormat(payload: ResponsesPayload): void {
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

function removeUnsupportedRequestParameters(payload: ResponsesPayload): void {
  for (const parameter of getUnsupportedRequestParameters(payload.model)) {
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

export const createResponses = async (
  payload: ResponsesPayload,
  { vision, initiator, signal }: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  let headerOpts = { vision, initiator }

  // service_tier is not supported by github copilot
  delete payload.service_tier

  // Zero-data retention enforcement
  payload.store = false

  // Match runtime defaults for direct Responses requests.
  payload.reasoning ??= {}
  if (usesImplicitReasoningDefault(payload.model)) {
    delete payload.reasoning.effort
  } else {
    payload.reasoning.effort ??= getReasoningEffortForModel(payload.model)
  }
  payload.reasoning.summary ??= "auto"

  if (!payload.include) {
    payload.include = []
  }
  if (!payload.include.includes("reasoning.encrypted_content")) {
    payload.include.push("reasoning.encrypted_content")
  }

  // Strip unknown fields — only forward fields the Copilot API recognizes.
  // The [key: string]: unknown index signature on ResponsesPayload allows
  // arbitrary client fields to leak through; sanitize before forwarding.
  let sanitizedPayload = sanitizeResponsesPayload(payload)

  let { response } = await routedFetch(
    "/responses",
    { method: "POST", body: JSON.stringify(sanitizedPayload), signal },
    { modelId: payload.model, headerOptions: headerOpts },
  )

  if (response.status === 413 && vision && removeInputImages(payload)) {
    consola.warn("413 Payload Too Large with images, retrying without images")
    sanitizedPayload = sanitizeResponsesPayload(payload)
    headerOpts = { vision: false, initiator }
    const { response: retryResponse } = await routedFetch(
      "/responses",
      { method: "POST", body: JSON.stringify(sanitizedPayload), signal },
      { modelId: payload.model, headerOptions: headerOpts },
    )
    response = retryResponse
  }

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response, payload)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResult
}
