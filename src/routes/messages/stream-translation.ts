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

// eslint-disable-next-line max-lines-per-function, complexity
export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    // Don't include usage in message_start - we don't have accurate data yet
    // Claude Code will fall back to its own estimation
    // The actual usage will be sent in message_delta at the end
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        // Note: Intentionally omitting usage here so Claude Code uses its own estimates
        // until we get actual data in message_delta
      },
    })
    state.messageStartSent = true
  }

  if (delta.content) {
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
      if (toolCall.id && toolCall.function?.name) {
        // New tool call starting.
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
        state.toolCalls[toolCall.index] = {
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
        const toolCallInfo = state.toolCalls[toolCall.index]
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
    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
    }

    // Get final usage from chunk - this is where the actual token counts are
    const inputTokens = chunk.usage?.prompt_tokens ?? 0
    const outputTokens = chunk.usage?.completion_tokens ?? 0
    const cachedTokens = chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0

    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cachedTokens,
        },
      },
      {
        type: "message_stop",
      },
    )
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
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  const choice = response.choices[0]
  if (!choice) {
    return events
  }

  const inputTokens = response.usage?.prompt_tokens ?? 0
  const outputTokens = response.usage?.completion_tokens ?? 0
  const cachedTokens =
    response.usage?.prompt_tokens_details?.cached_tokens ?? 0

  // 1. message_start - with actual token counts from response
  events.push({
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cachedTokens,
      },
    },
  })

  let contentBlockIndex = 0

  // Handle text content
  if (choice.message.content) {
    // 2. content_block_start for text
    events.push({
      type: "content_block_start",
      index: contentBlockIndex,
      content_block: {
        type: "text",
        text: "",
      },
    })

    // 3. content_block_delta with the full text
    events.push({
      type: "content_block_delta",
      index: contentBlockIndex,
      delta: {
        type: "text_delta",
        text: choice.message.content,
      },
    })

    // 4. content_block_stop
    events.push({
      type: "content_block_stop",
      index: contentBlockIndex,
    })

    contentBlockIndex++
  }

  // Handle tool calls
  if (choice.message.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      // content_block_start for tool_use
      events.push({
        type: "content_block_start",
        index: contentBlockIndex,
        content_block: {
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: {},
        },
      })

      // content_block_delta with tool arguments
      events.push({
        type: "content_block_delta",
        index: contentBlockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: toolCall.function.arguments,
        },
      })

      // content_block_stop
      events.push({
        type: "content_block_stop",
        index: contentBlockIndex,
      })

      contentBlockIndex++
    }
  }

  // 5. message_delta with final usage
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
      stop_sequence: null,
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cachedTokens,
    },
  })

  // 6. message_stop
  events.push({
    type: "message_stop",
  })

  return events
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
