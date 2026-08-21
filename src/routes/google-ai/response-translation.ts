/**
 * Translate OpenAI ChatCompletions responses → Google Generative AI format.
 * Handles both non-streaming and streaming chunk translation.
 */

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import type {
  IncompleteDetails,
  ResponseOutputText,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseUsage,
} from "~/services/copilot/create-responses"

import type {
  GoogleAIResponse,
  GoogleCandidate,
  GoogleContent,
  GooglePart,
  GoogleStreamFailure,
  GoogleUsageMetadata,
} from "./google-ai-types"

// ─── Finish Reason Mapping ───

type OpenAIFinishReason = string | null

function mapFinishReason(
  reason: OpenAIFinishReason,
): GoogleCandidate["finishReason"] {
  switch (reason) {
    case "stop": {
      return "STOP"
    }
    case "length": {
      return "MAX_TOKENS"
    }
    case "content_filter": {
      return "SAFETY"
    }
    case "tool_calls": {
      return "STOP"
    }
    default: {
      return reason === null ? null : "OTHER"
    }
  }
}

function getPromptFeedback(
  finishReason: GoogleCandidate["finishReason"],
): Record<string, unknown> | undefined {
  return finishReason === "SAFETY" ? { blockReason: "SAFETY" } : undefined
}

// ─── Usage Translation ───

function translateUsage(
  usage:
    | {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
        prompt_tokens_details?: { cached_tokens: number }
      }
    | undefined,
): GoogleUsageMetadata | undefined {
  if (!usage) return undefined

  return {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
    cachedContentTokenCount:
      usage.prompt_tokens_details?.cached_tokens ?? undefined,
  }
}

// ─── Non-Streaming Response Translation ───

/**
 * Parse tool call arguments from JSON string, with fallback to raw string.
 */
function parseToolCallArgs(argsString: string): Record<string, unknown> {
  try {
    return JSON.parse(argsString) as Record<string, unknown>
  } catch {
    return { raw: argsString }
  }
}

/**
 * Convert OpenAI ChatCompletion response → Google Generative AI response.
 */
export function translateOpenAIToGoogle(
  response: ChatCompletionResponse,
): GoogleAIResponse {
  const candidates: Array<GoogleCandidate> = response.choices.map((choice) => {
    const parts: Array<GooglePart> = []

    // Text content
    if (choice.message.content) {
      parts.push({ text: choice.message.content })
    }

    // Tool calls → functionCall parts
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args: parseToolCallArgs(toolCall.function.arguments),
          },
        })
      }
    }

    // Ensure at least one part exists
    if (parts.length === 0) {
      parts.push({ text: "" })
    }

    const content: GoogleContent = {
      role: "model",
      parts,
    }

    return {
      content,
      finishReason: mapFinishReason(choice.finish_reason),
      index: choice.index,
    }
  })

  const promptFeedback =
    (
      response.choices.some(
        (choice) => choice.finish_reason === "content_filter",
      )
    ) ?
      { blockReason: "SAFETY" }
    : undefined

  return {
    candidates,
    usageMetadata: translateUsage(response.usage),
    modelVersion: response.model,
    promptFeedback,
  }
}

// ─── Streaming Translation ───

/**
 * State machine for translating OpenAI streaming chunks to Google streaming format.
 */
export interface GoogleStreamState {
  /** Accumulated tool calls by index, since OpenAI streams them incrementally */
  toolCalls: Map<
    number,
    {
      name: string
      arguments: string
    }
  >
  /** Whether we've emitted any content yet */
  hasContent: boolean
}

export function createGoogleStreamState(): GoogleStreamState {
  return {
    toolCalls: new Map(),
    hasContent: false,
  }
}

/**
 * Accumulate incremental tool call deltas into the stream state.
 */
function accumulateToolCallDeltas(
  toolCallDeltas: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>,
  streamState: GoogleStreamState,
): void {
  for (const tc of toolCallDeltas) {
    const existing = streamState.toolCalls.get(tc.index)
    if (existing) {
      if (tc.function?.name) {
        existing.name += tc.function.name
      }
      if (tc.function?.arguments) {
        existing.arguments += tc.function.arguments
      }
    } else {
      streamState.toolCalls.set(tc.index, {
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      })
    }
  }
}

/**
 * Emit accumulated tool calls as Google functionCall parts and clear state.
 */
function emitAccumulatedToolCalls(
  streamState: GoogleStreamState,
): Array<GooglePart> {
  const parts = [...streamState.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(
      ([, tc]): GooglePart => ({
        functionCall: {
          name: tc.name,
          args: parseToolCallArgs(tc.arguments),
        },
      }),
    )
  streamState.toolCalls.clear()
  return parts
}

/**
 * Build a Google streaming chunk from parts and optional finish/usage info.
 */
function buildStreamChunk(options: {
  parts: Array<GooglePart>
  finishReason: OpenAIFinishReason
  index: number
  usage: ChatCompletionChunk["usage"]
  modelVersion?: string
}): GoogleAIResponse {
  const { parts, finishReason, index, usage, modelVersion } = options
  // Ensure at least empty text for non-tool-call finish
  if (parts.length === 0 && finishReason) {
    parts.push({ text: "" })
  }
  const mappedFinishReason = finishReason ? mapFinishReason(finishReason) : null
  const candidate: GoogleCandidate = {
    content: {
      role: "model",
      parts,
    },
    finishReason: mappedFinishReason,
    index,
  }
  return {
    candidates: [candidate],
    usageMetadata: usage ? translateUsage(usage) : undefined,
    modelVersion,
    promptFeedback: getPromptFeedback(mappedFinishReason),
  }
}

/**
 * Translate a single OpenAI streaming chunk → Google streaming chunk.
 * Returns null if the chunk doesn't produce a Google event.
 */
export function translateChunkToGoogle(
  chunk: ChatCompletionChunk,
  streamState: GoogleStreamState,
): GoogleAIResponse | null {
  // Usage-only chunk (final chunk with no choices)
  if (chunk.choices.length === 0) {
    if (chunk.usage) {
      return {
        candidates: [],
        usageMetadata: translateUsage(chunk.usage),
        modelVersion: chunk.model,
      }
    }
    return null
  }

  const choice = chunk.choices[0]
  const parts: Array<GooglePart> = []

  // Text content delta
  if (choice.delta.content !== null && choice.delta.content !== undefined) {
    parts.push({ text: choice.delta.content })
    streamState.hasContent = true
  }

  // Tool call deltas — accumulate and emit on finish
  if (choice.delta.tool_calls) {
    accumulateToolCallDeltas(choice.delta.tool_calls, streamState)
  }

  // On finish, emit accumulated tool calls
  if (choice.finish_reason !== null) {
    parts.push(...emitAccumulatedToolCalls(streamState))
  }

  // If nothing to emit yet (only partial tool call args), skip
  if (parts.length === 0 && !choice.finish_reason) {
    return null
  }

  return buildStreamChunk({
    parts,
    finishReason: choice.finish_reason,
    index: choice.index,
    usage: chunk.usage,
    modelVersion: chunk.model,
  })
}

// ─── Responses API → Google AI Translation ───

/**
 * Map Responses API status → Google finish reason.
 */
function mapResponsesFinishReason(
  status: string,
  incompleteDetails?: IncompleteDetails | null,
): GoogleCandidate["finishReason"] {
  if (status === "completed") return "STOP"
  if (status === "incomplete") {
    if (incompleteDetails?.reason === "max_output_tokens") return "MAX_TOKENS"
    if (incompleteDetails?.reason === "content_filter") return "SAFETY"
    return "MAX_TOKENS"
  }
  if (status === "failed") return "OTHER"
  return null
}

/**
 * Translate Responses API usage → Google usage metadata.
 */
function translateResponsesUsage(
  usage: ResponseUsage | null | undefined,
): GoogleUsageMetadata | undefined {
  if (!usage) return undefined
  return {
    promptTokenCount: usage.input_tokens,
    candidatesTokenCount: usage.output_tokens,
    totalTokenCount: usage.total_tokens,
    cachedContentTokenCount:
      usage.input_tokens_details?.cached_tokens ?? undefined,
  }
}

/**
 * Type guard for ResponseOutputText blocks.
 */
function isOutputTextBlock(block: unknown): block is ResponseOutputText {
  return (
    typeof block === "object"
    && block !== null
    && "type" in block
    && (block as { type: string }).type === "output_text"
  )
}

/**
 * Convert Responses API result → Google Generative AI response (non-streaming).
 */
export function translateResponsesResultToGoogle(
  result: ResponsesResult,
): GoogleAIResponse {
  const parts: Array<GooglePart> = []

  for (const item of result.output) {
    if (item.type === "message" && item.content) {
      for (const block of item.content) {
        if (isOutputTextBlock(block)) {
          parts.push({ text: block.text })
        }
      }
    } else if (item.type === "function_call") {
      const funcCall = item
      parts.push({
        functionCall: {
          name: funcCall.name,
          args: parseToolCallArgs(funcCall.arguments),
        },
      })
    }
    // Skip "reasoning" items — Google AI format has no thinking equivalent
  }

  // Ensure at least one part
  if (parts.length === 0) {
    parts.push({ text: result.output_text || "" })
  }

  const finishReason = mapResponsesFinishReason(
    result.status,
    result.incomplete_details,
  )

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
        index: 0,
      },
    ],
    usageMetadata: translateResponsesUsage(result.usage),
    modelVersion: result.model,
    promptFeedback: getPromptFeedback(finishReason),
  }
}

/**
 * Translate a single Responses API stream event → Google streaming chunk.
 * Returns null if the event doesn't produce a Google event.
 */
export type GoogleResponsesStreamResult =
  | { kind: "partial"; chunk: GoogleAIResponse }
  | { kind: "success"; chunk: GoogleAIResponse }
  | { kind: "received_failure"; failure: GoogleStreamFailure }
  | { kind: "ignore" }

const LOCAL_STREAM_FAILURE_MESSAGE =
  "Upstream stream ended before a terminal response"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readBodyBytes(
  record: Record<string, unknown>,
): Array<number> | undefined {
  const value = record.body_bytes
  if (
    !Array.isArray(value)
    || !value.every((item) => typeof item === "number")
  ) {
    return undefined
  }
  return [...value]
}

function createReceivedResponsesFailure(value: unknown): GoogleStreamFailure {
  const record = isRecord(value) ? value : {}
  const upstreamStatus =
    readNumber(record, "upstream_status") ?? readNumber(record, "status")
  const message =
    typeof record.message === "string" ?
      record.message
    : LOCAL_STREAM_FAILURE_MESSAGE
  const bodyBytes = readBodyBytes(record)
  const contentType =
    typeof record.content_type === "string" ? record.content_type : undefined

  return {
    error: {
      code: upstreamStatus ?? 500,
      message,
      status: "INTERNAL",
      ...(bodyBytes ? { body_bytes: bodyBytes } : {}),
      ...(contentType ? { content_type: contentType } : {}),
      ...(upstreamStatus === undefined ?
        {}
      : { upstream_status: upstreamStatus }),
    },
  }
}

export function translateResponsesStreamEventToGoogle(
  event: ResponseStreamEvent,
  _streamState: GoogleStreamState,
): GoogleResponsesStreamResult {
  switch (event.type) {
    case "response.output_text.delta": {
      return {
        kind: "partial",
        chunk: {
          candidates: [
            {
              content: { role: "model", parts: [{ text: event.delta }] },
              finishReason: null,
              index: 0,
            },
          ],
        },
      }
    }

    case "response.function_call_arguments.done": {
      return {
        kind: "partial",
        chunk: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: event.name,
                      args: parseToolCallArgs(event.arguments),
                    },
                  },
                ],
              },
              finishReason: null,
              index: 0,
            },
          ],
        },
      }
    }

    case "response.completed":
    case "response.incomplete": {
      const finishReason = mapResponsesFinishReason(
        event.response.status,
        event.response.incomplete_details,
      )
      return {
        kind: "success",
        chunk: {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "" }] },
              finishReason,
              index: 0,
            },
          ],
          usageMetadata: translateResponsesUsage(event.response.usage),
          modelVersion: event.response.model,
          promptFeedback: getPromptFeedback(finishReason),
        },
      }
    }

    case "response.failed": {
      return {
        kind: "received_failure",
        failure: createReceivedResponsesFailure(
          (event.response as unknown as Record<string, unknown>).error,
        ),
      }
    }

    case "error": {
      const eventRecord = event as unknown as Record<string, unknown>
      const nestedError =
        isRecord(eventRecord.error) ? eventRecord.error : eventRecord
      const nestedRecord = { ...nestedError }
      if (
        readNumber(nestedRecord, "upstream_status") === undefined
        && readNumber(nestedRecord, "status") === undefined
      ) {
        const topLevelStatus =
          readNumber(eventRecord, "upstream_status")
          ?? readNumber(eventRecord, "status")
        if (topLevelStatus !== undefined) nestedRecord.status = topLevelStatus
      }
      return {
        kind: "received_failure",
        failure: createReceivedResponsesFailure(nestedRecord),
      }
    }

    default: {
      return { kind: "ignore" }
    }
  }
}
