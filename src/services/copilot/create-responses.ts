import consola from "consola"
import { events } from "fetch-event-stream"

import type { RoutedAccountPin } from "~/lib/account-router"
import type { RetryBudget } from "~/services/copilot/transport-retry"

import { routedFetch } from "~/lib/account-router"
import { getReasoningEffortForModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import {
  getModelReasoningConfig,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import { omitConfiguredReasoningEffort } from "~/lib/reasoning-effort-omission"
import { stripUnsupportedResponsesInputMetadata } from "~/services/copilot/responses-metadata"
import { omitOutputTokenReplay } from "~/services/copilot/responses-output-replay"
import {
  classifyReasoningStateRejection,
  hasReasoningState,
  omitRejectedReasoningState,
  rememberRejectedReasoningState,
  stripReasoningState,
} from "~/services/copilot/responses-reasoning-state"
import {
  claimCompatibilityRetry,
  consumeExtraSend,
  createRetryBudget,
  PRE_HEADER_MAX_DELAY_SECONDS,
} from "~/services/copilot/transport-retry"
import { runManagedWebRequest } from "~/services/web/tool-loop"

import {
  fitResponsesCompactionPayload,
  isResponsesCompactionRequest,
} from "./compaction-payload"
import { classifyCompatibilityRetry } from "./compatibility-retry"
import { normalizeResponsesAttachments } from "./responses-attachments"
import {
  prepareResponsesCollaboration,
  restoreResponsesCollaboration,
  restoreResponsesCollaborationEvent,
  type ResponsesCollaboration,
} from "./responses-collaboration"
import {
  finalizeResponsesRequest,
  type ResponsesWireBody,
} from "./responses-contract"
import {
  hasResponsesAttachment,
  recoverResponsesPayload,
  type ResponsesPayloadRecoveryResult,
} from "./responses-payload-recovery"
import { sanitizeResponsesStreamEvent } from "./responses-terminal-sanitizer"

export { normalizeResponsesAttachments } from "./responses-attachments"
export {
  SAFE_RESPONSES_STREAM_ERROR_MESSAGE,
  sanitizeResponsesStreamEvent,
} from "./responses-terminal-sanitizer"

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
    verbosity?: "low" | "medium" | "high"
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
  namespace?: string
  encrypted_function_args?: Array<string>
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
  | ResponseOutputCustomToolCall
  | ResponseOutputToolSearchCall
  | ResponseOutputWebSearchCall
  | ResponseOutputCompaction

/** Replacement history returned for a Codex compaction request. */
export interface ResponseOutputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

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
  phase?: "commentary" | "final_answer"
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
  namespace?: string
  encrypted_function_args?: Array<string>
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputCustomToolCall {
  id?: string
  type: "custom_tool_call"
  call_id: string
  name: string
  namespace?: string
  input: string
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputToolSearchCall {
  id?: string
  type: "tool_search_call"
  call_id: string
  execution: "client"
  arguments: Record<string, unknown>
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

async function* sanitizeResponsesStream(
  response: Response,
  collaboration: ResponsesCollaboration | undefined,
): ResponsesStream {
  for await (const event of events(response)) {
    yield restoreResponsesCollaborationEvent(
      sanitizeResponsesStreamEvent(event),
      collaboration,
    )
  }
}

interface ResponsesRequestOptions {
  allowCompatibilityRetry?: boolean
  vision: boolean
  initiator: "agent" | "user"
  copilotSessionToken?: string
  signal?: AbortSignal
  compaction?: boolean
  prepared?: boolean
  nativeResponses?: boolean
  routedAccountPin?: RoutedAccountPin
  retryBudget?: RetryBudget
}

interface ResponsesCoreResult {
  response: CreateResponsesReturn
  processedPayload: Record<string, unknown>
}

interface ResponsesOperationState {
  collaboration?: ResponsesCollaboration
}

const logOrdinaryRecovery = (
  recovered: ResponsesPayloadRecoveryResult<Record<string, unknown>>,
): void => {
  if (!recovered.reduced) return

  consola.warn("Recovered oversized ordinary Responses payload", {
    originalBytes: recovered.originalBytes,
    finalBytes: recovered.finalBytes,
    omittedReasoningStates: recovered.omittedReasoningStates,
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
      omittedReasoningStates: fitted.omittedReasoningStates,
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

// Compatibility preparation adds one guarded branch to the existing request pipeline.

export const createResponses = async (
  payload: ResponsesPayload,
  options: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  const pinnedOptions = {
    ...options,
    routedAccountPin: options.routedAccountPin ?? {},
  }
  const operation: ResponsesOperationState = {}
  return (await runManagedWebRequest({
    protocol: "responses",
    nativeResponses: options.nativeResponses,
    payload,
    disabled: options.compaction || isResponsesCompactionRequest(payload),
    accountId: pinnedOptions.routedAccountPin.accountId,
    signal: options.signal,
    send: async (body, _managed, reportProcessedPayload) => {
      const result = await createResponsesCore(
        body as ResponsesPayload,
        pinnedOptions,
        operation,
      )
      reportProcessedPayload(result.processedPayload)
      return result.response as
        | Record<string, unknown>
        | AsyncIterable<import("~/services/web/tool-loop").WebEvent>
    },
  })) as CreateResponsesReturn
}

// eslint-disable-next-line complexity -- Provider request preparation and compatibility retries remain together.
const createResponsesCore = async (
  payload: ResponsesPayload,
  options: ResponsesRequestOptions,
  operation: ResponsesOperationState,
): Promise<ResponsesCoreResult> => {
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
  stripUnsupportedResponsesInputMetadata(body)
  omitOutputTokenReplay(body)
  const omittedRejectedState = omitRejectedReasoningState(body)
  if (omittedRejectedState > 0) {
    consola.debug("Omitted reasoning state Copilot already refused", {
      reasoningItems: omittedRejectedState,
    })
  }
  omitConfiguredReasoningEffort("responses", body)

  // Zero-data retention enforcement
  body.store = false
  delete body.service_tier
  // Managed continuations reuse the wire body, whose namespace is already
  // adapted. Retain its restoration context for responses from later rounds.
  const collaboration =
    prepareResponsesCollaboration(body) ?? operation.collaboration
  operation.collaboration = collaboration

  // Completed evaluated candidates have already performed semantic attachment
  // adaptation; unprepared sources still need the transport normalizer here.
  if (!options.prepared) await normalizeResponsesAttachments(body, signal)
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
    copilotSessionToken: options.copilotSessionToken,
    vision: hasResponsesAttachment(preparedPayload),
    initiator,
  }
  const retryBudget = options.retryBudget ?? createRetryBudget()
  const send = createResponsesSender({
    headerOptions: headerOpts,
    model: body.model,
    retryBudget,
    routedAccountPin: options.routedAccountPin ?? {},
    signal,
    stream: Boolean(body.stream),
  })

  let activePayload = preparedPayload
  let response = await send(preparedPayload, false)
  // The gateway replays reasoning state, so it owns this recovery whether or
  // not the caller allows compatibility retries.
  ;({ payload: activePayload, response } =
    await resendWithoutRejectedReasoningState({
      payload: activePayload,
      response,
      retryBudget,
      send: async (payload) => await send(payload, true),
    }))

  const compatibilityDecision =
    options.allowCompatibilityRetry === false ?
      { kind: "none" as const }
    : await classifyCompatibilityRetry({
        body: activePayload,
        endpoint: "/responses",
        response,
      })
  if (compatibilityDecision.kind !== "none") {
    const retryPayload = structuredClone(activePayload)
    if (
      compatibilityDecision.normalize(retryPayload)
      && claimCompatibilityRetry(retryBudget)
    ) {
      activePayload = retryPayload
      response = await send(retryPayload, true)
    }
  }

  if (!response.ok) {
    consola.error("Failed to create responses")
    throw new HTTPError("Failed to create responses", response, activePayload)
  }

  if (body.stream) {
    return {
      response: sanitizeResponsesStream(response, collaboration),
      processedPayload: activePayload,
    }
  }

  const result = (await response.json()) as ResponsesResult
  restoreResponsesCollaboration(result, collaboration)
  return { response: result, processedPayload: activePayload }
}

/** One routed send per call; resends reuse the pinned account and budget. */
function createResponsesSender(options: {
  headerOptions: Parameters<typeof routedFetch>[2]["headerOptions"]
  model: string
  retryBudget: RetryBudget
  routedAccountPin: RoutedAccountPin
  signal?: AbortSignal
  stream: boolean
}): (payload: Record<string, unknown>, retry: boolean) => Promise<Response> {
  return async (payload, retry) =>
    (
      await routedFetch(
        "/responses",
        {
          method: "POST",
          body: JSON.stringify(payload),
          signal: options.signal,
        },
        {
          modelId: options.model,
          headerOptions: options.headerOptions,
          maxHttpRetryDelaySeconds:
            options.stream ? PRE_HEADER_MAX_DELAY_SECONDS : undefined,
          ...(retry ?
            { reason: "compatibility_retry" as const, recordSelection: false }
          : {}),
          routedAccountPin: options.routedAccountPin,
          retryBudget: options.retryBudget,
        },
      )
    ).response
}

/**
 * Copilot binds replayed reasoning state to the account that produced it, and
 * expires it. When Copilot cannot use that state, resend once without it: the
 * turn keeps its history and loses only the reasoning that was refused. State
 * refused as foreign is remembered so later turns omit it up front.
 */
async function resendWithoutRejectedReasoningState(options: {
  payload: Record<string, unknown>
  response: Response
  retryBudget: RetryBudget
  send: (payload: Record<string, unknown>) => Promise<Response>
}): Promise<{ payload: Record<string, unknown>; response: Response }> {
  const rejection =
    hasReasoningState(options.payload) ?
      await classifyReasoningStateRejection(options.response)
    : undefined
  if (!rejection || !consumeExtraSend(options.retryBudget)) {
    return { payload: options.payload, response: options.response }
  }
  const payload = structuredClone(options.payload)
  const removed = stripReasoningState(payload)
  consola.warn(
    "Copilot could not use replayed reasoning state; resending without it",
    { reasoningItems: removed.length, rejection },
  )
  const response = await options.send(payload)
  if (
    rejection === "foreign"
    && (await classifyReasoningStateRejection(response)) !== "foreign"
  ) {
    rememberRejectedReasoningState(removed)
  }
  return { payload, response }
}
