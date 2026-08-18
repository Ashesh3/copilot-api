import consola from "consola"
import { events, type ServerSentEventMessage } from "fetch-event-stream"

import { routedFetch } from "~/lib/account-router"
import { getReasoningEffortForModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import {
  getModelReasoningConfig,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import { PRE_HEADER_MAX_DELAY_SECONDS } from "~/services/copilot/transport-retry"

import {
  fitResponsesCompactionPayload,
  isResponsesCompactionRequest,
} from "./compaction-payload"
import { normalizeResponsesAttachments } from "./responses-attachments"
import {
  finalizeResponsesRequest,
  type ResponsesWireBody,
} from "./responses-contract"
import {
  hasResponsesAttachment,
  recoverResponsesPayload,
  type ResponsesPayloadRecoveryResult,
} from "./responses-payload-recovery"

export { normalizeResponsesAttachments } from "./responses-attachments"

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem>
  prompt?: string | Record<string, unknown> | null
  conversation_id?: string | null
  tools?: Array<Tool> | null
  tool_choice?: ToolChoiceOptions | Record<string, unknown>
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  metadata?: Metadata | null
  user?: string | null
  stream?: boolean | null
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  prompt_cache_options?: Record<string, unknown> | null
  prompt_cache_retention?: string | null
  parallel_tool_calls?: boolean | null
  store?: boolean | null
  background?: boolean | null
  context_management?: Array<Record<string, unknown>> | null
  multi_agent?: Record<string, unknown> | null
  snippy?: Record<string, unknown> | null
  truncation?: string | Record<string, unknown> | null
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

export type ToolChoiceOptions = "none" | "auto" | "required" | "validated"

export interface ToolChoiceFunction extends Record<string, unknown> {
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
  effort?: string | number | null
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
  encrypted_content?: string
}

export interface ResponseInputReasoningSummary {
  type: "reasoning_summary"
  summary: Array<{
    type: "summary_text"
    text: string
  }>
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseInputReasoning
  | ResponseInputReasoningSummary
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
  max_output_tokens?: number | null
  metadata: Metadata | null
  parallel_tool_calls: boolean
  reasoning?: Reasoning | null
  temperature: number | null
  text?: ResponsesPayload["text"]
  tool_choice: unknown
  tools: Array<Tool>
  top_p: number | null
}

export type Metadata = { [key: string]: string }

export interface IncompleteDetails {
  reason?: "max_output_tokens" | "content_filter"
}

export interface ResponseError {
  code?: string
  message: string
  param?: string | null
  status?: number
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

export const SAFE_RESPONSES_STREAM_ERROR_MESSAGE =
  "Upstream Responses stream failed."

const SAFE_RESPONSES_ERROR_CODES = new Set([
  "content_filter",
  "internal_error",
  "invalid_request_body",
  "invalid_request_error",
  "model_error",
  "overloaded_error",
  "rate_limit_exceeded",
  "rate_limited",
  "server_error",
  "service_unavailable",
  "timeout",
  "upstream_error",
])
const SAFE_RESPONSES_ERROR_PARAMS = new Set([
  "background",
  "body",
  "input",
  "max_output_tokens",
  "model",
  "previous_response_id",
  "reasoning",
  "service_tier",
  "store",
  "temperature",
  "tool_choice",
  "tools",
  "top_p",
])
const RESPONSES_TERMINAL_EVENT_TYPES = new Set([
  "error",
  "response.completed",
  "response.failed",
  "response.incomplete",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeResponsesErrorCode(value: unknown): string {
  return typeof value === "string" && SAFE_RESPONSES_ERROR_CODES.has(value) ?
      value
    : "server_error"
}

function sanitizeResponsesErrorParam(value: unknown): string | null {
  if (value === null) return null
  return typeof value === "string" && SAFE_RESPONSES_ERROR_PARAMS.has(value) ?
      value
    : null
}

function sanitizeResponsesErrorStatus(value: unknown): number {
  return (
      typeof value === "number"
        && Number.isInteger(value)
        && value >= 400
        && value <= 599
    ) ?
      value
    : 502
}

function sanitizeResponsesError(value: unknown): Record<string, unknown> {
  const error = isRecord(value) ? value : {}
  return {
    code: sanitizeResponsesErrorCode(error.code),
    message: SAFE_RESPONSES_STREAM_ERROR_MESSAGE,
    param: sanitizeResponsesErrorParam(error.param),
    status: sanitizeResponsesErrorStatus(error.status),
  }
}

function sanitizeTerminalResponsesEvent(
  parsed: Record<string, unknown>,
  eventType: string,
): Record<string, unknown> {
  const sequenceNumber =
    typeof parsed.sequence_number === "number" ? parsed.sequence_number : 0

  if (eventType === "error") {
    return {
      type: "error",
      sequence_number: sequenceNumber,
      ...sanitizeResponsesError(parsed),
    }
  }

  const response = isRecord(parsed.response) ? parsed.response : {}
  return {
    type: eventType,
    sequence_number: sequenceNumber,
    response: {
      ...response,
      error: sanitizeResponsesError(response.error),
    },
  }
}

/**
 * Native Responses streams are ordinarily client-visible. Keep the raw wire in
 * administrator-only LLM Debug, but canonicalize terminal text before any
 * route, WebSocket lifecycle, consola reporter, or Sentry integration sees it.
 */
export function sanitizeResponsesStreamEvent(
  event: ServerSentEventMessage,
): ServerSentEventMessage {
  if (!event.data) return event

  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(event.data) as unknown
    if (!isRecord(value)) return event
    parsed = value
  } catch {
    if (!event.event || !RESPONSES_TERMINAL_EVENT_TYPES.has(event.event)) {
      return event
    }
    return {
      ...event,
      data: JSON.stringify(sanitizeTerminalResponsesEvent({}, event.event)),
    }
  }

  const eventType = typeof parsed.type === "string" ? parsed.type : event.event
  if (!eventType || !RESPONSES_TERMINAL_EVENT_TYPES.has(eventType)) return event

  if (eventType === "response.completed") {
    const response = isRecord(parsed.response) ? parsed.response : undefined
    if (response?.status !== "failed" && response?.status !== "incomplete") {
      return event
    }
  }

  return {
    ...event,
    data: JSON.stringify(sanitizeTerminalResponsesEvent(parsed, eventType)),
  }
}

async function* sanitizeResponsesStream(response: Response): ResponsesStream {
  for await (const event of events(response)) {
    yield sanitizeResponsesStreamEvent(event)
  }
}

interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
  signal?: AbortSignal
  compaction?: boolean
  prepared?: boolean
}

const logOrdinaryRecovery = (
  recovered: ResponsesPayloadRecoveryResult<Record<string, unknown>>,
): void => {
  if (!recovered.reduced) return

  consola.warn("Recovered oversized ordinary Responses payload", {
    originalBytes: recovered.originalBytes,
    finalBytes: recovered.finalBytes,
    downscaledImages: recovered.downscaledImages,
    removedHistoricalBinaries: recovered.removedHistoricalBinaries,
    removedCurrentBinaries: recovered.removedCurrentBinaries,
  })
}

async function prepareResponsesPayload(
  payload: ResponsesWireBody,
  options: { fitCompactionPayload: boolean; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  if (!options.fitCompactionPayload) {
    const recovered = await recoverResponsesPayload(payload, {
      signal: options.signal,
    })
    logOrdinaryRecovery(recovered)
    return recovered.payload
  }

  const fitted = fitResponsesCompactionPayload(payload)
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

export const createResponses = async (
  payload: ResponsesPayload,
  options: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  const { initiator, signal } = options
  signal?.throwIfAborted()
  const prepared =
    options.prepared ?
      { body: structuredClone(payload) }
    : finalizeResponsesRequest(payload, {
        defaultEffort:
          getModelReasoningConfig(payload.model)?.defaultEffort
          ?? getReasoningEffortForModel(payload.model),
        implicitDefault: usesImplicitReasoningDefault(payload.model),
      })
  const body = prepared.body

  // Zero-data retention enforcement
  body.store = false

  // Inline external attachment URLs / normalize file_data to data URIs
  await normalizeResponsesAttachments(body, signal)
  signal?.throwIfAborted()

  const shouldFitCompactionPayload = shouldFitResponsesCompactionPayload(
    body,
    options.compaction,
  )
  const preparedPayload = await prepareResponsesPayload(body, {
    fitCompactionPayload: shouldFitCompactionPayload,
    signal,
  })
  const headerOpts = {
    vision: hasResponsesAttachment(preparedPayload),
    initiator,
  }

  const { response } = await routedFetch(
    "/responses",
    { method: "POST", body: JSON.stringify(preparedPayload), signal },
    {
      modelId: body.model,
      headerOptions: headerOpts,
      maxHttpRetryDelaySeconds:
        body.stream ? PRE_HEADER_MAX_DELAY_SECONDS : undefined,
    },
  )

  if (!response.ok) {
    consola.error("Failed to create responses")
    throw new HTTPError("Failed to create responses", response, preparedPayload)
  }

  if (body.stream) {
    return sanitizeResponsesStream(response)
  }

  return (await response.json()) as ResponsesResult
}
