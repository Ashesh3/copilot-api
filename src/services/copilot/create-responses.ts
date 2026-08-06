import consola from "consola"
import { events } from "fetch-event-stream"

import { routedFetch } from "~/lib/account-router"
import {
  attachmentOmittedNote,
  fetchUrlAsDataUri,
  isDataUri,
  isHttpUrl,
  isLikelyBase64,
  mediaTypeFromFilename,
  toDataUri,
} from "~/lib/attachments"
import { getReasoningEffortForModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { getUnsupportedRequestParameters } from "~/lib/model-settings"
import { usesImplicitReasoningDefault } from "~/lib/model-suffix"
import { PRE_HEADER_MAX_DELAY_SECONDS } from "~/services/copilot/transport-retry"

import {
  fitResponsesCompactionPayload,
  isResponsesCompactionRequest,
} from "./compaction-payload"

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
  effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | null
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
  | ResponseInputFile
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

/**
 * Responses API file content part (PDF attachments). Copilot requires
 * file_data to be a base64 data URI; raw base64 and external file_url
 * values are rejected upstream (verified 2026-07-03).
 */
export interface ResponseInputFile {
  type: "input_file"
  filename?: string | null
  /** base64 data URI ("data:application/pdf;base64,...") */
  file_data?: string | null
  file_id?: string | null
  file_url?: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const JSON_OBJECT_INPUT_INSTRUCTION = "Respond with JSON."
const COPILOT_RESPONSES_MIN_OUTPUT_TOKENS = 16

function isInputImage(value: unknown): value is ResponseInputImage {
  return isRecord(value) && value.type === "input_image"
}

function isInputFile(value: unknown): value is ResponseInputFile {
  return isRecord(value) && value.type === "input_file"
}

function isAttachmentPart(value: unknown): boolean {
  return isInputImage(value) || isInputFile(value)
}

/**
 * Normalize attachment parts to the shapes Copilot's /responses endpoint
 * accepts (verified 2026-07-03):
 *   - input_image.image_url must be a data URI (external URLs rejected)
 *   - input_file.file_data must be a data URI (raw base64 and file_url
 *     values rejected)
 * External URLs are fetched and inlined by the proxy; failures downgrade to
 * an explanatory input_text part.
 */
export async function normalizeResponsesAttachments(
  payload: ResponsesPayload,
  signal?: AbortSignal,
): Promise<void> {
  if (!Array.isArray(payload.input)) return

  const normalizedInput: Array<ResponseInputItem> = []
  for (const item of payload.input) {
    if (isAttachmentPart(item)) {
      normalizedInput.push(
        (await normalizeResponsesContentPart(
          item as ResponseInputContent,
          signal,
        )) as ResponseInputItem,
      )
      continue
    }

    if (isRecord(item) && Array.isArray(item.content)) {
      const content: Array<ResponseInputContent> = []
      for (const part of item.content as Array<ResponseInputContent>) {
        content.push(await normalizeResponsesContentPart(part, signal))
      }
      normalizedInput.push({ ...item, content })
      continue
    }

    // function_call_output items carry content in `output`
    if (isRecord(item) && Array.isArray(item.output)) {
      const output: Array<ResponseInputContent> = []
      for (const part of item.output as Array<ResponseInputContent>) {
        output.push(await normalizeResponsesContentPart(part, signal))
      }
      normalizedInput.push({ ...item, output })
      continue
    }

    normalizedInput.push(item)
  }
  payload.input = normalizedInput
}

async function normalizeResponsesContentPart(
  part: ResponseInputContent,
  signal?: AbortSignal,
): Promise<ResponseInputContent> {
  if (isInputImage(part) && part.image_url && isHttpUrl(part.image_url)) {
    const inlined = await fetchUrlAsDataUri(part.image_url, { signal })
    if (inlined) {
      return { ...part, image_url: toDataUri(inlined.mediaType, inlined.data) }
    }
    return {
      type: "input_text",
      text: attachmentOmittedNote({
        kind: "image",
        name: part.image_url,
        reason: "the URL could not be fetched by the proxy",
      }),
    }
  }

  if (isInputFile(part)) {
    return await normalizeInputFile(part, signal)
  }

  return part
}

async function normalizeInputFile(
  part: ResponseInputFile,
  signal?: AbortSignal,
): Promise<ResponseInputContent> {
  const { file_url: fileUrl, file_data: fileData } = part

  if (fileData) {
    if (isDataUri(fileData)) return stripFileUrl(part)
    if (isLikelyBase64(fileData)) {
      const mediaType =
        mediaTypeFromFilename(part.filename) ?? "application/pdf"
      return stripFileUrl({
        ...part,
        file_data: toDataUri(mediaType, fileData),
      })
    }
    return stripFileUrl(part)
  }

  if (fileUrl && isHttpUrl(fileUrl)) {
    const inlined = await fetchUrlAsDataUri(fileUrl, {
      expectPdf: true,
      signal,
    })
    if (inlined) {
      const { file_url: _fileUrl, ...rest } = part
      return {
        ...rest,
        filename:
          part.filename ?? new URL(fileUrl).pathname.split("/").pop() ?? null,
        file_data: toDataUri(inlined.mediaType, inlined.data),
      }
    }
    return {
      type: "input_text",
      text: attachmentOmittedNote({
        kind: "file",
        name: part.filename ?? fileUrl,
        reason: "the URL could not be fetched by the proxy",
      }),
    }
  }

  return part
}

function stripFileUrl(part: ResponseInputFile): ResponseInputFile {
  if (part.file_url === undefined || part.file_url === null) return part
  const { file_url: _fileUrl, ...rest } = part
  return rest
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
    if (isAttachmentPart(item)) {
      removedImages = true
      continue
    }

    if (hasArrayContent(item)) {
      const filteredContent: Array<ResponseInputContent> = []
      for (const part of item.content) {
        if (isAttachmentPart(part)) {
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
  | ResponseOutputWebSearchCall

export interface ResponseOutputWebSearchCall {
  id: string
  type: "web_search_call"
  status: "in_progress" | "searching" | "completed" | "failed"
  action?: Record<string, unknown>
}

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
  compaction?: boolean
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
  ensureJsonObjectInputMentionsJson(payload)
  normalizeFunctionToolParameters(payload)
  normalizeJsonSchemaResponseFormat(payload)
  clampMaxOutputTokens(payload)
  removeUnsupportedRequestParameters(payload)

  const result: Record<string, unknown> = {}
  for (const key of KNOWN_RESPONSES_FIELDS) {
    if (key in payload && payload[key] !== undefined) {
      result[key] = payload[key]
    }
  }
  return result
}

function prepareResponsesPayload(
  payload: ResponsesPayload,
  fitCompactionPayload: boolean,
): Record<string, unknown> {
  const sanitized = sanitizeResponsesPayload(payload)
  if (!fitCompactionPayload) return sanitized

  const fitted = fitResponsesCompactionPayload(sanitized)
  if (fitted.reduced) {
    consola.warn("Reduced oversized Responses compaction payload", {
      originalBytes: fitted.originalBytes,
      finalBytes: fitted.finalBytes,
      omittedBinaryBlocks: fitted.omittedBinaryBlocks,
      truncatedToolOutputBytes: fitted.truncatedToolOutputBytes,
    })
  }
  return fitted.payload
}

function shouldFitResponsesCompactionPayload(
  payload: ResponsesPayload,
  explicitlyRequested: boolean | undefined,
): boolean {
  return explicitlyRequested === true || isResponsesCompactionRequest(payload)
}

function clampMaxOutputTokens(payload: ResponsesPayload): void {
  if (
    typeof payload.max_output_tokens === "number"
    && payload.max_output_tokens < COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  ) {
    payload.max_output_tokens = COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  }
}

function ensureJsonObjectInputMentionsJson(payload: ResponsesPayload): void {
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
  options: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  const { vision, initiator, signal } = options
  signal?.throwIfAborted()
  let headerOpts = { vision, initiator }

  // service_tier is not supported by github copilot
  delete payload.service_tier

  // Zero-data retention enforcement
  payload.store = false

  // Inline external attachment URLs / normalize file_data to data URIs
  await normalizeResponsesAttachments(payload, signal)
  signal?.throwIfAborted()

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
  const shouldFitCompactionPayload = shouldFitResponsesCompactionPayload(
    payload,
    options.compaction,
  )
  let sanitizedPayload = prepareResponsesPayload(
    payload,
    shouldFitCompactionPayload,
  )

  let { response } = await routedFetch(
    "/responses",
    { method: "POST", body: JSON.stringify(sanitizedPayload), signal },
    {
      modelId: payload.model,
      headerOptions: headerOpts,
      maxHttpRetryDelaySeconds:
        payload.stream ? PRE_HEADER_MAX_DELAY_SECONDS : undefined,
    },
  )

  if (response.status === 413 && vision && removeInputImages(payload)) {
    consola.warn("413 Payload Too Large with images, retrying without images")
    sanitizedPayload = prepareResponsesPayload(
      payload,
      shouldFitCompactionPayload,
    )
    headerOpts = { vision: false, initiator }
    const { response: retryResponse } = await routedFetch(
      "/responses",
      { method: "POST", body: JSON.stringify(sanitizedPayload), signal },
      {
        modelId: payload.model,
        headerOptions: headerOpts,
        reason: "http_retry",
        recordSelection: false,
        maxHttpRetryDelaySeconds:
          payload.stream ? PRE_HEADER_MAX_DELAY_SECONDS : undefined,
      },
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
