/* eslint-disable max-lines */
import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import type { ResponsesResult } from "~/services/copilot/create-responses"

import {
  type AnthropicContentBlockDeltaEvent,
  type AnthropicMessageDeltaEvent,
  type AnthropicMessageStartEvent,
  type AnthropicResponse,
  type AnthropicStreamState,
} from "~/routes/messages/anthropic-types"
import { translateToAnthropic } from "~/routes/messages/non-stream-translation"
import { translateResponsesResultToAnthropic } from "~/routes/messages/responses-translation"
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

test("types and preserves unknown fields in native Messages deltas", () => {
  const contentBlockDeltas: Array<AnthropicContentBlockDeltaEvent> = [
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "hello",
        future_native_field: true,
      },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: '{"answer":',
        future_native_field: true,
      },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: {
        type: "thinking_delta",
        thinking: "considering the answer",
        future_native_field: true,
      },
    },
    {
      type: "content_block_delta",
      index: 3,
      delta: {
        type: "signature_delta",
        signature: "signature",
        future_native_field: true,
      },
    },
  ]

  for (const contentBlockDelta of contentBlockDeltas) {
    expect(contentBlockDelta.delta.future_native_field).toBe(true)
  }
})

test("types forward-compatible message delta and error records", () => {
  const delta: AnthropicMessageDeltaEvent = {
    type: "message_delta",
    delta: { stop_reason: "end_turn", future_delta: true },
  }
  const error = {
    type: "error" as const,
    error: {
      type: "invalid_request_error",
      message: "safe",
      code: "invalid_value",
      future_error: true,
    },
  } satisfies import("~/routes/messages/anthropic-types").AnthropicErrorEvent

  expect(delta).toMatchObject({
    type: "message_delta",
    delta: { stop_reason: "end_turn", future_delta: true },
  })
  expect(error).toMatchObject({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "invalid_value",
      future_error: true,
    },
  })
})

// eslint-disable-next-line max-lines-per-function
describe("OpenAI to Anthropic Non-Streaming Response Translation", () => {
  test("preserves optional Chat response metadata in the Anthropic result", () => {
    const response = {
      id: "chatcmpl-meta",
      object: "chat.completion",
      created: 1,
      model: "gpt-current",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
      recommended_auto_tier: "eco",
      copilot_usage: { total_nano_aiu: 123 },
    } as ChatCompletionResponse & {
      recommended_auto_tier: "eco"
      copilot_usage: { total_nano_aiu: number }
    }

    expect(translateToAnthropic(response)).toMatchObject({
      recommended_auto_tier: "eco",
      copilot_usage: { total_nano_aiu: 123 },
    })
  })

  test("preserves optional Responses metadata in the Anthropic result", () => {
    const response = {
      id: "resp-meta",
      object: "response",
      created_at: 1,
      model: "gpt-current",
      output: [],
      output_text: "hello",
      status: "completed",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      recommended_auto_tier: "balanced",
      copilot_usage: { total_nano_aiu: 456 },
    } as ResponsesResult & {
      recommended_auto_tier: "balanced"
      copilot_usage: { total_nano_aiu: number }
    }

    expect(translateResponsesResultToAnthropic(response)).toMatchObject({
      recommended_auto_tier: "balanced",
      copilot_usage: { total_nano_aiu: 456 },
    })
  })

  test("types and preserves current native Messages response extensions", () => {
    const response: AnthropicResponse = {
      id: "msg-current",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
      ],
      model: "claude-current",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_creation: {
          ephemeral_5m_input_tokens: 4,
          ephemeral_1h_input_tokens: 2,
        },
        future_usage_field: true,
      },
      copilot_usage: { completion_tokens: 8 },
      recommended_auto_tier: "balanced",
      stop_details: { reason: "native" },
      future_native_field: { enabled: true },
    }
    const messageStart: AnthropicMessageStartEvent = {
      type: "message_start",
      message: {
        ...response,
        content: [],
        stop_reason: null,
        stop_sequence: null,
      },
    }
    const messageDelta: AnthropicMessageDeltaEvent = {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 8 },
      copilot_usage: { completion_tokens: 8 },
      future_native_field: { enabled: true },
    }
    expect(response).toMatchObject({
      id: "msg-current",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "hello",
          cache_control: { type: "ephemeral" },
        },
      ],
      model: "claude-current",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_creation: {
          ephemeral_5m_input_tokens: 4,
          ephemeral_1h_input_tokens: 2,
        },
        future_usage_field: true,
      },
      copilot_usage: { completion_tokens: 8 },
      recommended_auto_tier: "balanced",
      stop_details: { reason: "native" },
      future_native_field: { enabled: true },
    })
    expect(messageStart).toMatchObject({
      type: "message_start",
      message: {
        content: [],
        stop_reason: null,
        stop_sequence: null,
        recommended_auto_tier: "balanced",
      },
    })
    expect(messageDelta).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 8 },
      copilot_usage: { completion_tokens: 8 },
      future_native_field: { enabled: true },
    })
  })

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

  test("carries Chat recommendation and Copilot usage into Anthropic events", () => {
    const state: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const startChunk = {
      id: "cmpl-meta-stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-current",
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
          logprobs: null,
        },
      ],
      recommended_auto_tier: "eco",
    } as ChatCompletionChunk & { recommended_auto_tier: "eco" }
    const finalChunk = {
      id: "cmpl-meta-stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-current",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
      copilot_usage: { total_nano_aiu: 123 },
    } as ChatCompletionChunk & {
      copilot_usage: { total_nano_aiu: number }
    }

    const events = [startChunk, finalChunk].flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, state),
    )
    const terminalEvents =
      streamTranslation.createFallbackMessageDeltaEvents(state)

    expect(
      events.find((event) => event.type === "message_start"),
    ).toMatchObject({ message: { recommended_auto_tier: "eco" } })
    expect(
      events.find((event) => event.type === "message_delta"),
    ).toBeUndefined()
    expect(terminalEvents[0]).toMatchObject({
      copilot_usage: { total_nano_aiu: 123 },
    })
  })

  test("carries Chat metadata through simulated Anthropic streams", () => {
    const response = {
      id: "chatcmpl-simulated-meta",
      object: "chat.completion",
      created: 1,
      model: "gpt-current",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
      recommended_auto_tier: "balanced",
      copilot_usage: { total_nano_aiu: 456 },
    } as ChatCompletionResponse & {
      recommended_auto_tier: "balanced"
      copilot_usage: { total_nano_aiu: number }
    }

    const events =
      streamTranslation.translateResponseToAnthropicEvents(response)

    expect(
      events.find((event) => event.type === "message_start"),
    ).toMatchObject({ message: { recommended_auto_tier: "balanced" } })
    expect(
      events.find((event) => event.type === "message_delta"),
    ).toMatchObject({ copilot_usage: { total_nano_aiu: 456 } })
  })

  test("attaches Copilot usage when it arrives after the finish reason", () => {
    const state: AnthropicStreamState = {
      messageStartSent: true,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const finishChunk: ChatCompletionChunk = {
      id: "cmpl-late-meta",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-current",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }
    const usageChunk = {
      id: "cmpl-late-meta",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-current",
      choices: [],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
      copilot_usage: { total_nano_aiu: 123 },
    } as ChatCompletionChunk & {
      copilot_usage: { total_nano_aiu: number }
    }

    const finishEvents = translateChunkToAnthropicEvents(finishChunk, state)
    const usageEvents = translateChunkToAnthropicEvents(usageChunk, state)

    expect(finishEvents).toEqual([])
    expect(usageEvents).toEqual([])
    expect(streamTranslation.createFallbackMessageDeltaEvents(state)).toEqual([
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        copilot_usage: { total_nano_aiu: 123 },
      },
      { type: "message_stop" },
    ])
    expect(streamTranslation.createFallbackMessageDeltaEvents(state)).toEqual(
      [],
    )
  })

  test("retains usage and Copilot metadata that arrive before the finish reason", () => {
    const state: AnthropicStreamState = {
      messageStartSent: true,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const usageChunk = {
      id: "cmpl-early-meta",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-current",
      choices: [],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 4,
        total_tokens: 11,
      },
      copilot_usage: { total_nano_aiu: 456 },
    } as ChatCompletionChunk & {
      copilot_usage: { total_nano_aiu: number }
    }
    const finishChunk: ChatCompletionChunk = {
      id: "cmpl-early-meta",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-current",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }

    expect(translateChunkToAnthropicEvents(usageChunk, state)).toEqual([])
    expect(translateChunkToAnthropicEvents(finishChunk, state)).toEqual([])
    expect(
      streamTranslation.createFallbackMessageDeltaEvents(state),
    ).toMatchObject([
      {
        type: "message_delta",
        usage: { input_tokens: 7, output_tokens: 4 },
        copilot_usage: { total_nano_aiu: 456 },
      },
      { type: "message_stop" },
    ])
  })

  test("closes a finish-only stream without inventing Copilot metadata", () => {
    const state: AnthropicStreamState = {
      messageStartSent: true,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const finishChunk: ChatCompletionChunk = {
      id: "cmpl-no-usage",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-current",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }

    expect(translateChunkToAnthropicEvents(finishChunk, state)).toEqual([])
    expect(streamTranslation.createFallbackMessageDeltaEvents(state)).toEqual([
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      { type: "message_stop" },
    ])
  })

  test.each([
    {
      name: "finish then usage",
      chunks: [{ finish: true }, { usage: { prompt: 5, completion: 3 } }],
      expectedUsage: { input_tokens: 5, output_tokens: 3 },
    },
    {
      name: "usage then finish",
      chunks: [{ usage: { prompt: 7, completion: 4 } }, { finish: true }],
      expectedUsage: { input_tokens: 7, output_tokens: 4 },
    },
    {
      name: "usage with finish then late Copilot metadata",
      chunks: [
        { finish: true, usage: { prompt: 9, completion: 6 } },
        { copilotUsage: { total_nano_aiu: 901 } },
      ],
      expectedUsage: { input_tokens: 9, output_tokens: 6 },
      expectedCopilotUsage: { total_nano_aiu: 901 },
    },
    {
      name: "Copilot metadata then finish",
      chunks: [{ copilotUsage: { total_nano_aiu: 345 } }, { finish: true }],
      expectedUsage: { input_tokens: 0, output_tokens: 0 },
      expectedCopilotUsage: { total_nano_aiu: 345 },
    },
    {
      name: "finish only",
      chunks: [{ finish: true }],
      expectedUsage: { input_tokens: 0, output_tokens: 0 },
    },
  ])(
    "finalizes exactly once after stream exhaustion for $name",
    ({ chunks, expectedCopilotUsage, expectedUsage }) => {
      const orderingChunks = chunks as ReadonlyArray<{
        copilotUsage?: { total_nano_aiu: number }
        finish?: boolean
        usage?: { completion: number; prompt: number }
      }>
      const state: AnthropicStreamState = {
        messageStartSent: true,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        toolCalls: {},
      }
      const streamedEvents = orderingChunks.flatMap((item, index) => {
        const chunk = {
          id: "cmpl-ordering",
          object: "chat.completion.chunk",
          created: index,
          model: "gpt-current",
          choices:
            item.finish ?
              [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                  logprobs: null,
                },
              ]
            : [],
          ...(item.usage ?
            {
              usage: {
                prompt_tokens: item.usage.prompt,
                completion_tokens: item.usage.completion,
                total_tokens: item.usage.prompt + item.usage.completion,
              },
            }
          : {}),
          ...(item.copilotUsage ? { copilot_usage: item.copilotUsage } : {}),
        } as ChatCompletionChunk & { copilot_usage?: unknown }
        return translateChunkToAnthropicEvents(chunk, state)
      })

      expect(
        streamedEvents.filter(
          (event) =>
            event.type === "message_delta" || event.type === "message_stop",
        ),
      ).toEqual([])

      const terminalEvents =
        streamTranslation.createFallbackMessageDeltaEvents(state)
      expect(terminalEvents).toHaveLength(2)
      expect(terminalEvents[0]).toMatchObject({
        type: "message_delta",
        usage: expectedUsage,
        ...(expectedCopilotUsage ?
          { copilot_usage: expectedCopilotUsage }
        : {}),
      })
      if (!expectedCopilotUsage) {
        expect(terminalEvents[0]).not.toHaveProperty("copilot_usage")
      }
      expect(terminalEvents[1]).toEqual({ type: "message_stop" })
      expect(streamTranslation.createFallbackMessageDeltaEvents(state)).toEqual(
        [],
      )
    },
  )

  test("emits content deltas before terminal finalization", () => {
    const state: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const contentChunk: ChatCompletionChunk = {
      id: "cmpl-content-immediate",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-current",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "hello" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    expect(translateChunkToAnthropicEvents(contentChunk, state)).toMatchObject([
      { type: "message_start" },
      { type: "content_block_start" },
      { type: "content_block_delta", delta: { text: "hello" } },
    ])
    expect(streamTranslation.createFallbackMessageDeltaEvents(state)).toEqual(
      [],
    )
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

describe("Mid-stream error reporting", () => {
  test("emits a well-formed Anthropic error event instead of closing silently", async () => {
    const writes: Array<{ event: string; data: string }> = []
    const stream = {
      writeSSE: (data: { event: string; data: string }) => {
        writes.push(data)
        return Promise.resolve()
      },
    }

    await streamTranslation.emitAnthropicStreamError(
      stream,
      new Error("upstream exploded"),
    )

    expect(writes).toHaveLength(1)
    expect(writes[0]?.event).toBe("error")

    const parsed = JSON.parse(writes[0]?.data ?? "{}") as {
      type: string
      error: { type: string; message: string }
    }
    expect(parsed.type).toBe("error")
    expect(parsed.error.type).toBe("api_error")
    expect(typeof parsed.error.message).toBe("string")

    // The upstream message must not leak to the client; it goes to Sentry only.
    expect(writes[0]?.data).not.toContain("upstream exploded")
  })

  test("swallows write failures when the client has already disconnected", async () => {
    const stream = {
      writeSSE: () => Promise.reject(new Error("socket closed")),
    }

    // Must not throw: there is nobody left to inform.
    await streamTranslation.emitAnthropicStreamError(stream, new Error("boom"))
  })
})
