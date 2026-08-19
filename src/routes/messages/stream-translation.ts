import * as Sentry from "@sentry/bun"
import consola from "consola"

import {
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  // Check if the current block index corresponds to any known tool call
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  )
}

function normalizeToolCallIndex(
  index: number,
  state: AnthropicStreamState,
): number {
  if (state.toolCallIndexOffset === undefined) {
    state.toolCallIndexOffset = index === 0 ? 0 : 1
  }

  return Math.max(0, index - state.toolCallIndexOffset)
}

function closeThinkingBlockIfOpen(
  state: AnthropicStreamState,
  events: Array<AnthropicStreamEventData>,
): void {
  if (!state.thinkingBlockOpen) return

  const thinkingIdx = state.thinkingBlockIndex ?? state.contentBlockIndex
  if (state.pendingSignature) {
    events.push({
      type: "content_block_delta",
      index: thinkingIdx,
      delta: {
        type: "signature_delta",
        signature: state.pendingSignature,
      },
    })
    state.pendingSignature = undefined
  }
  events.push({
    type: "content_block_stop",
    index: thinkingIdx,
  })
  state.thinkingBlockOpen = false
  state.thinkingBlockIndex = undefined

  if (state.contentBlockIndex === thinkingIdx) {
    state.contentBlockIndex++
  }
  state.contentBlockOpen = false
}

export function extractCopilotChunkMetadata(chunk: ChatCompletionChunk):
  | {
      annotations?: unknown
      usage?: unknown
    }
  | undefined {
  const metadataChunk = chunk as ChatCompletionChunk & {
    copilot_annotations?: unknown
    copilot_usage?: unknown
  }

  const metadata: {
    annotations?: unknown
    usage?: unknown
  } = {}

  if (metadataChunk.copilot_annotations !== undefined) {
    metadata.annotations = metadataChunk.copilot_annotations
  }
  if (metadataChunk.copilot_usage !== undefined) {
    metadata.usage = metadataChunk.copilot_usage
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined
}

// Helper to create message_delta and message_stop events
function createMessageDeltaEvents(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter",
  usage: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens: number
  },
  copilotUsage?: unknown,
): Array<AnthropicStreamEventData> {
  const stopReason = mapOpenAIStopReasonToAnthropic(finishReason)
  // Anthropic input_tokens = uncached tokens only
  // OpenAI prompt_tokens includes cached, so subtract them
  const inputTokens = usage.prompt_tokens - usage.cached_tokens
  return [
    {
      type: "message_delta",
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        input_tokens: inputTokens,
        output_tokens: usage.completion_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: usage.cached_tokens,
      },
      ...(copilotUsage !== undefined ? { copilot_usage: copilotUsage } : {}),
    },
    {
      type: "message_stop",
    },
  ]
}

// Export for use in handler fallback
export function createFallbackMessageDeltaEvents(
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  // If message_delta was already sent, return empty
  if (state.messageDeltaSent) {
    return []
  }

  const events: Array<AnthropicStreamEventData> = []

  if (isToolBlockOpen(state)) {
    events.push({
      type: "content_block_stop",
      index: state.contentBlockIndex,
    })
    state.contentBlockOpen = false
  }

  const usage = state.pendingUsage ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
  }

  // If we have a pending finish_reason, send message_delta with whatever usage we have
  if (state.pendingFinishReason) {
    events.push(
      ...createMessageDeltaEvents(
        state.pendingFinishReason,
        usage,
        state.pendingCopilotUsage,
      ),
    )
    return events
  }

  if (Object.keys(state.toolCalls).length > 0) {
    events.push(
      ...createMessageDeltaEvents(
        "tool_calls",
        usage,
        state.pendingCopilotUsage,
      ),
    )
    return events
  }

  return events
}

// eslint-disable-next-line max-lines-per-function, complexity
export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
  originalModel?: string,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []
  const copilotMetadata = extractCopilotChunkMetadata(chunk)

  if (copilotMetadata) {
    consola.debug("Copilot chunk metadata received")
  }
  const metadataChunk = chunk as ChatCompletionChunk & {
    copilot_usage?: unknown
    recommended_auto_tier?: "eco" | "balanced"
  }
  if (metadataChunk.copilot_usage !== undefined) {
    state.pendingCopilotUsage = metadataChunk.copilot_usage
  }
  if (metadataChunk.recommended_auto_tier !== undefined) {
    state.pendingRecommendedAutoTier = metadataChunk.recommended_auto_tier
  }

  // Capture usage from any chunk that has it (may come before, with, or after finish_reason)
  if (chunk.usage) {
    state.pendingUsage = {
      prompt_tokens: chunk.usage.prompt_tokens,
      completion_tokens: chunk.usage.completion_tokens,
      cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
    }

    // If we already saw finish_reason but deferred message_delta, send it now
    if (state.pendingFinishReason && !state.messageDeltaSent) {
      events.push(
        ...createMessageDeltaEvents(
          state.pendingFinishReason,
          state.pendingUsage,
        ),
      )
      state.messageDeltaSent = true
    }
  }

  if (chunk.choices.length === 0) {
    // Empty choices chunk - usage already captured above
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    // Include usage in message_start for context window display
    // Use pending usage if available (captured from earlier chunks)
    const usage = state.pendingUsage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
    }
    // Anthropic input_tokens = uncached tokens only
    const inputTokens = usage.prompt_tokens - usage.cached_tokens
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        // Use original requested model for cost calculation in Claude Code
        model: originalModel ?? chunk.model,
        stop_reason: null,
        stop_sequence: null,
        // Include usage for context window display
        // Note: output_tokens should be 0 at message_start (final count comes in message_delta)
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: usage.cached_tokens,
        },
        ...(state.pendingRecommendedAutoTier !== undefined ?
          { recommended_auto_tier: state.pendingRecommendedAutoTier }
        : {}),
      },
    })
    state.messageStartSent = true
  }

  // Handle reasoning_text (Claude thinking via CAPI)
  if (delta.reasoning_text) {
    if (!state.thinkingBlockOpen) {
      // Open a new thinking content block
      state.thinkingBlockIndex = state.contentBlockIndex
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "thinking",
          thinking: "",
        },
      })
      state.thinkingBlockOpen = true
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex ?? state.contentBlockIndex,
      delta: {
        type: "thinking_delta",
        thinking: delta.reasoning_text,
      },
    })
  }

  // Capture reasoning_opaque (encrypted signature for thinking round-trip)
  if (delta.reasoning_opaque) {
    state.pendingSignature = delta.reasoning_opaque
  }

  if (delta.content) {
    // Close thinking block if it was open before starting text
    closeThinkingBlockIfOpen(state, events)

    if (isToolBlockOpen(state)) {
      // A tool block was open, so close it before starting a text block.
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
    }

    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.content,
      },
    })
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      const normalizedToolIndex = normalizeToolCallIndex(toolCall.index, state)

      if (toolCall.id && toolCall.function?.name) {
        // New tool call starting.
        closeThinkingBlockIfOpen(state, events)

        if (state.contentBlockOpen) {
          // Close any previously open block.
          events.push({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          })
          state.contentBlockIndex++
          state.contentBlockOpen = false
        }

        const anthropicBlockIndex = state.contentBlockIndex
        state.toolCalls[normalizedToolIndex] = {
          id: toolCall.id,
          name: toolCall.function.name,
          anthropicBlockIndex,
        }

        events.push({
          type: "content_block_start",
          index: anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: {},
          },
        })
        state.contentBlockOpen = true
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[normalizedToolIndex]
        // Tool call can still be empty
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (toolCallInfo) {
          events.push({
            type: "content_block_delta",
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    // Close thinking block if still open
    closeThinkingBlockIfOpen(state, events)

    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
    }

    // Check if we have usage data (from this chunk or previously captured)
    const hasUsage = chunk.usage || state.pendingUsage

    if (hasUsage) {
      // We have usage - send message_delta immediately
      const usage = {
        prompt_tokens:
          chunk.usage?.prompt_tokens ?? state.pendingUsage?.prompt_tokens ?? 0,
        completion_tokens:
          chunk.usage?.completion_tokens
          ?? state.pendingUsage?.completion_tokens
          ?? 0,
        cached_tokens:
          chunk.usage?.prompt_tokens_details?.cached_tokens
          ?? state.pendingUsage?.cached_tokens
          ?? 0,
      }

      events.push(
        ...createMessageDeltaEvents(
          choice.finish_reason,
          usage,
          state.pendingCopilotUsage,
        ),
      )
      state.messageDeltaSent = true
    } else {
      // No usage yet - defer message_delta until we receive usage in a later chunk
      state.pendingFinishReason = choice.finish_reason
    }
  }

  return events
}

/**
 * Convert a complete OpenAI ChatCompletionResponse to Anthropic streaming events.
 * This is used when we fetch non-streaming from upstream but need to simulate
 * streaming to the client with accurate token counts.
 */
export function translateResponseToAnthropicEvents(
  response: ChatCompletionResponse,
  originalModel?: string,
): Array<AnthropicStreamEventData> {
  const choice = response.choices[0]
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive check for empty choices array
  if (!choice) {
    return []
  }

  const promptTokens = response.usage?.prompt_tokens ?? 0
  const outputTokens = response.usage?.completion_tokens ?? 0
  const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
  // Anthropic input_tokens = uncached tokens only
  const inputTokens = promptTokens - cachedTokens

  const events: Array<AnthropicStreamEventData> = [
    createMessageStartEvent(response, {
      originalModel,
      inputTokens,
      cachedTokens,
    }),
  ]

  let contentBlockIndex = 0
  contentBlockIndex = addThinkingContentEvents(
    events,
    choice,
    contentBlockIndex,
  )
  contentBlockIndex = addTextContentEvents(events, choice, contentBlockIndex)
  addToolCallEvents(events, choice, contentBlockIndex)
  addMessageDeltaAndStopEvents(events, {
    choice,
    copilotUsage: getChatCopilotUsage(response),
    usage: { inputTokens, outputTokens, cachedTokens },
  })

  return events
}

interface MessageStartEventOptions {
  originalModel: string | undefined
  inputTokens: number
  cachedTokens: number
}

function createMessageStartEvent(
  response: ChatCompletionResponse,
  options: MessageStartEventOptions,
): AnthropicStreamEventData {
  const { originalModel, inputTokens, cachedTokens } = options
  const metadata = response as ChatCompletionResponse & {
    recommended_auto_tier?: "eco" | "balanced"
  }
  return {
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: originalModel ?? response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cachedTokens,
      },
      ...(metadata.recommended_auto_tier !== undefined ?
        { recommended_auto_tier: metadata.recommended_auto_tier }
      : {}),
    },
  }
}

function addThinkingContentEvents(
  events: Array<AnthropicStreamEventData>,
  choice: ChatCompletionResponse["choices"][0],
  contentBlockIndex: number,
): number {
  if (choice.message.reasoning_text) {
    events.push(
      {
        type: "content_block_start",
        index: contentBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: contentBlockIndex,
        delta: {
          type: "thinking_delta",
          thinking: choice.message.reasoning_text,
        },
      },
    )
    if (choice.message.reasoning_opaque) {
      events.push({
        type: "content_block_delta",
        index: contentBlockIndex,
        delta: {
          type: "signature_delta",
          signature: choice.message.reasoning_opaque,
        },
      })
    }
    events.push({ type: "content_block_stop", index: contentBlockIndex })
    return contentBlockIndex + 1
  }
  return contentBlockIndex
}

function addTextContentEvents(
  events: Array<AnthropicStreamEventData>,
  choice: ChatCompletionResponse["choices"][0],
  contentBlockIndex: number,
): number {
  if (choice.message.content) {
    events.push(
      {
        type: "content_block_start",
        index: contentBlockIndex,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: contentBlockIndex,
        delta: { type: "text_delta", text: choice.message.content },
      },
      { type: "content_block_stop", index: contentBlockIndex },
    )
    return contentBlockIndex + 1
  }
  return contentBlockIndex
}

function addToolCallEvents(
  events: Array<AnthropicStreamEventData>,
  choice: ChatCompletionResponse["choices"][0],
  startIndex: number,
): void {
  if (!choice.message.tool_calls) return

  let idx = startIndex
  for (const toolCall of choice.message.tool_calls) {
    events.push(
      {
        type: "content_block_start",
        index: idx,
        content_block: {
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: idx,
        delta: {
          type: "input_json_delta",
          partial_json: toolCall.function.arguments,
        },
      },
      { type: "content_block_stop", index: idx },
    )
    idx++
  }
}

interface UsageTokens {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

interface MessageDeltaOptions {
  choice: ChatCompletionResponse["choices"][0]
  copilotUsage?: unknown
  usage: UsageTokens
}

function addMessageDeltaAndStopEvents(
  events: Array<AnthropicStreamEventData>,
  options: MessageDeltaOptions,
): void {
  const { choice, copilotUsage, usage } = options
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
        stop_sequence: null,
      },
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: usage.cachedTokens,
      },
      ...(copilotUsage !== undefined ? { copilot_usage: copilotUsage } : {}),
    },
    { type: "message_stop" },
  )
}

function getChatCopilotUsage(response: ChatCompletionResponse): unknown {
  return (response as ChatCompletionResponse & { copilot_usage?: unknown })
    .copilot_usage
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}

/**
 * Report a mid-stream failure to the client as an Anthropic `error` event.
 *
 * Once `streamSSE` has committed its `200` the HTTP status can no longer
 * change, so a late failure has to travel in-band. Rethrowing instead is not a
 * safe default: Hono's `run()` only writes an `error` frame when a third
 * `onError` argument was supplied — otherwise it logs to the console and closes
 * the stream cleanly. A clean close that never sent `message_start` makes the
 * Anthropic client fall back to a *non-streaming retry*, silently duplicating
 * the whole generation. One explicit frame avoids that.
 *
 * We emit the frame here rather than via Hono's `onError` hook because that
 * hook appends its own `event: error` carrying the raw `Error.message`, which
 * would both duplicate the frame and leak upstream internals to the client.
 * The real error still reaches Sentry.
 */
export async function emitAnthropicStreamError(
  stream: {
    writeSSE: (data: { event: string; data: string }) => Promise<void>
  },
  _error: unknown,
): Promise<void> {
  Sentry.captureException(new Error("Anthropic stream failed after headers"))
  consola.error("Anthropic stream failed after headers were sent")

  const event = translateErrorToAnthropicErrorEvent()
  try {
    await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
  } catch {
    // The client is already gone; there is nobody left to inform.
  }
}
