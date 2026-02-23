/**
 * Translate OpenAI ChatCompletions responses → Google Generative AI format.
 * Handles both non-streaming and streaming chunk translation.
 */

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import type {
  GoogleAIResponse,
  GoogleCandidate,
  GoogleContent,
  GooglePart,
  GoogleStreamChunk,
  GoogleUsageMetadata,
} from "./google-ai-types"

// ─── Finish Reason Mapping ───

type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | null

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
      return null
    }
  }
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

  return {
    candidates,
    usageMetadata: translateUsage(response.usage),
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
  const parts: Array<GooglePart> = []
  for (const [, tc] of streamState.toolCalls) {
    parts.push({
      functionCall: {
        name: tc.name,
        args: parseToolCallArgs(tc.arguments),
      },
    })
  }
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
}): GoogleStreamChunk {
  const { parts, finishReason, index, usage } = options
  // Ensure at least empty text for non-tool-call finish
  if (parts.length === 0 && finishReason) {
    parts.push({ text: "" })
  }
  const candidate: GoogleCandidate = {
    content: {
      role: "model",
      parts,
    },
    finishReason: finishReason ? mapFinishReason(finishReason) : null,
    index,
  }
  return {
    candidates: [candidate],
    usageMetadata: usage ? translateUsage(usage) : undefined,
  }
}

/**
 * Translate a single OpenAI streaming chunk → Google streaming chunk.
 * Returns null if the chunk doesn't produce a Google event.
 */
export function translateChunkToGoogle(
  chunk: ChatCompletionChunk,
  streamState: GoogleStreamState,
): GoogleStreamChunk | null {
  // Usage-only chunk (final chunk with no choices)
  if (chunk.choices.length === 0) {
    if (chunk.usage) {
      return {
        candidates: [],
        usageMetadata: translateUsage(chunk.usage),
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
  if (choice.finish_reason === "tool_calls") {
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
  })
}
