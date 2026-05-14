import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessageDeltaEvent,
  type AnthropicStreamState,
} from "~/routes/messages/anthropic-types"
import { translateToAnthropic } from "~/routes/messages/non-stream-translation"
import * as streamTranslation from "~/routes/messages/stream-translation"
import { translateChunkToAnthropicEvents } from "~/routes/messages/stream-translation"

const anthropicUsageSchema = z.object({
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
})

const anthropicContentBlockTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
})

const anthropicContentBlockToolUseSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.any()),
})

const anthropicMessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.union([
      anthropicContentBlockTextSchema,
      anthropicContentBlockToolUseSchema,
    ]),
  ),
  model: z.string(),
  stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]),
  stop_sequence: z.string().nullable(),
  usage: anthropicUsageSchema,
})

/**
 * Validates if a response payload conforms to the Anthropic Message shape.
 * @param payload The response payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidAnthropicResponse(payload: unknown): boolean {
  return anthropicMessageResponseSchema.safeParse(payload).success
}

const anthropicStreamEventSchema = z.looseObject({
  type: z.enum([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]),
})

function isValidAnthropicStreamEvent(payload: unknown): boolean {
  return anthropicStreamEventSchema.safeParse(payload).success
}

describe("OpenAI to Anthropic Non-Streaming Response Translation", () => {
  test("should translate a simple text response correctly", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello! How can I help you today?",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 12,
        total_tokens: 21,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.id).toBe("chatcmpl-123")
    expect(anthropicResponse.stop_reason).toBe("end_turn")
    expect(anthropicResponse.usage.input_tokens).toBe(9)
    expect(anthropicResponse.content[0].type).toBe("text")
    if (anthropicResponse.content[0].type === "text") {
      expect(anthropicResponse.content[0].text).toBe(
        "Hello! How can I help you today?",
      )
    } else {
      throw new Error("Expected text block")
    }
  })

  test("should translate a response with tool calls", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-456",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_current_weather",
                  arguments: '{"location": "Boston, MA"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content[0].type).toBe("tool_use")
    if (anthropicResponse.content[0].type === "tool_use") {
      expect(anthropicResponse.content[0].id).toBe("call_abc")
      expect(anthropicResponse.content[0].name).toBe("get_current_weather")
      expect(anthropicResponse.content[0].input).toEqual({
        location: "Boston, MA",
      })
    } else {
      throw new Error("Expected tool_use block")
    }
  })

  test("should translate a response stopped due to length", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-789",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "This is a very long response that was cut off...",
          },
          finish_reason: "length",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2048,
        total_tokens: 2058,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)
    expect(anthropicResponse.stop_reason).toBe("max_tokens")
  })
})

// eslint-disable-next-line max-lines-per-function
describe("OpenAI to Anthropic Streaming Response Translation", () => {
  test("extracts Copilot-specific chunk metadata for telemetry", () => {
    const chunk = {
      id: "cmpl-meta",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [],
      copilot_annotations: [{ type: "citation", title: "doc" }],
      copilot_usage: { completion_tokens: 12 },
    } as ChatCompletionChunk & {
      copilot_annotations: Array<{ type: string; title: string }>
      copilot_usage: { completion_tokens: number }
    }

    expect(streamTranslation.extractCopilotChunkMetadata(chunk)).toEqual({
      annotations: [{ type: "citation", title: "doc" }],
      usage: { completion_tokens: 12 },
    })
  })

  test("should translate a simple text stream correctly", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: " there" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })

  test("should translate a stream with tool calls", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_xyz",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'ation": "Paris"}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    // Streaming translation requires state
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    // These tests will fail until the stub is implemented
    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })

  test("preserves reasoning signature when a tool call follows thinking", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-reasoning-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-3-pro-preview",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              reasoning_text: "I should fetch repository details first.",
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-reasoning-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-3-pro-preview",
        choices: [
          {
            index: 0,
            delta: {
              reasoning_opaque: "opaque-thinking-state",
              tool_calls: [
                {
                  index: 0,
                  id: "call_repo",
                  type: "function",
                  function: {
                    name: "get_repo",
                    arguments: '{"repo":"github/github"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 8,
          total_tokens: 28,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    const signatureIndex = translatedStream.findIndex(
      (event) =>
        event.type === "content_block_delta"
        && event.delta.type === "signature_delta"
        && event.delta.signature === "opaque-thinking-state",
    )
    const toolStartIndex = translatedStream.findIndex(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "tool_use",
    )

    expect(signatureIndex).toBeGreaterThan(-1)
    expect(toolStartIndex).toBeGreaterThan(-1)
    expect(signatureIndex).toBeLessThan(toolStartIndex)
  })

  test("normalizes missing finish_reason to tool_use when a tool-call stream ends", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-tool-null-finish",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-null-finish",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_weather",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"location":"Paris"}',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    translatedStream.push(
      ...streamTranslation.createFallbackMessageDeltaEvents(streamState),
    )

    const messageDelta = translatedStream.find(
      (event): event is AnthropicMessageDeltaEvent =>
        event.type === "message_delta",
    )

    expect(messageDelta).toBeDefined()
    expect(messageDelta?.delta.stop_reason).toBe("tool_use")
  })

  test("closes an open tool block before fallback terminal events", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: true,
      contentBlockIndex: 0,
      contentBlockOpen: true,
      toolCalls: {
        0: {
          id: "call_weather",
          name: "get_weather",
          anthropicBlockIndex: 0,
        },
      },
      pendingUsage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        cached_tokens: 0,
      },
    }

    const fallbackEvents =
      streamTranslation.createFallbackMessageDeltaEvents(streamState)

    expect(fallbackEvents.map((event) => event.type)).toEqual([
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(fallbackEvents[0]).toEqual({
      type: "content_block_stop",
      index: 0,
    })
  })

  test("normalizes 1-based tool call indices to 0-based stream state entries", () => {
    const chunk: ChatCompletionChunk = {
      id: "cmpl-gcp",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "call_gcp",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "",
                },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    translateChunkToAnthropicEvents(chunk, streamState)

    expect(streamState.toolCalls[0]).toEqual({
      id: "call_gcp",
      name: "get_weather",
      anthropicBlockIndex: 0,
    })
    expect(streamState.toolCalls[1]).toBeUndefined()
  })
})
