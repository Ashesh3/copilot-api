import { expect, test } from "bun:test"

import type { AnthropicResponse } from "~/routes/messages/anthropic-types"

import { readAnthropicUsage } from "~/lib/anthropic-usage"
import {
  anthropicResponseToChat,
  streamAnthropicAsChatCompletions,
} from "~/routes/chat-completions/anthropic-bridge"
import { anthropicResponseToResponsesResult } from "~/routes/responses/messages-bridge"

function response(usage: AnthropicResponse["usage"]): AnthropicResponse {
  return {
    id: "msg_usage_boundary",
    type: "message",
    role: "assistant",
    model: "usage-model",
    content: [{ type: "text", text: "done" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  }
}

test.each([1, 2, 20])(
  "Anthropic input plus %p cache tokens remains unknown at the reserved or unsafe boundary",
  (cached) => {
    const usage = readAnthropicUsage({
      input_tokens: Number.MAX_SAFE_INTEGER - 1,
      cache_read_input_tokens: cached,
      output_tokens: 7,
    })
    expect(usage?.inputTokens).toBeNaN()
    expect(usage?.outputTokens).toBe(7)
    expect(usage?.cachedTokens).toBe(cached)
  },
)

test("representable Anthropic cache sums keep their exact value", () => {
  expect(
    readAnthropicUsage({
      input_tokens: Number.MAX_SAFE_INTEGER - 4,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 2,
      output_tokens: 0,
    }),
  ).toEqual({
    inputTokens: Number.MAX_SAFE_INTEGER - 1,
    cachedTokens: 1,
    cacheCreationTokens: 2,
    outputTokens: 0,
  })
})

test.each(["input", "total"])(
  "buffered Chat and Responses serialize an overflowing %s as null and preserve output",
  async (field) => {
    const fixture = response({
      input_tokens: Number.MAX_SAFE_INTEGER - 1,
      cache_read_input_tokens: field === "input" ? 20 : 0,
      output_tokens: 7,
    })
    const chat = (await Response.json(
      anthropicResponseToChat(fixture, "usage-model"),
    ).json()) as {
      usage: {
        prompt_tokens: number | null
        completion_tokens: number
        total_tokens: number | null
      }
    }
    const responses = (await Response.json(
      anthropicResponseToResponsesResult(fixture, "usage-model"),
    ).json()) as {
      usage: {
        input_tokens: number | null
        output_tokens: number
        total_tokens: number | null
      }
    }
    const expectedInput = field === "input" ? null : Number.MAX_SAFE_INTEGER - 1
    expect(chat.usage).toMatchObject({
      prompt_tokens: expectedInput,
      completion_tokens: 7,
      total_tokens: null,
    })
    expect(responses.usage).toMatchObject({
      input_tokens: expectedInput,
      output_tokens: 7,
      total_tokens: null,
    })
  },
)

test.each(["input", "total"])(
  "streamed bridge validates %s before publishing usage and serializing its final chunk",
  async (field) => {
    const frames: Array<string> = []
    const observed: Array<{ inputTokens: number; outputTokens: number }> = []
    const fixture = response({
      input_tokens: Number.MAX_SAFE_INTEGER - 1,
      cache_creation_input_tokens: field === "input" ? 20 : 0,
      output_tokens: 7,
    })
    async function* events() {
      yield await Promise.resolve({
        event: "message_start",
        data: JSON.stringify({ type: "message_start", message: fixture }),
      })
      yield await Promise.resolve({
        event: "message_stop",
        data: '{"type":"message_stop"}',
      })
    }
    const result = await streamAnthropicAsChatCompletions(
      {
        writeSSE: ({ data }) => {
          frames.push(data)
          return Promise.resolve()
        },
      },
      events(),
      "usage-model",
      (usage) => observed.push(usage),
    )
    const final = JSON.parse(frames.at(-1) ?? "{}") as {
      usage: {
        prompt_tokens: number | null
        completion_tokens: number
        total_tokens: number | null
      }
    }
    expect(final.usage).toMatchObject({
      prompt_tokens: field === "input" ? null : Number.MAX_SAFE_INTEGER - 1,
      completion_tokens: 7,
      total_tokens: null,
    })
    expect(result.outputTokens).toBe(7)
    expect(observed.at(-1)?.outputTokens).toBe(7)
    if (field === "input") {
      expect(result.inputTokens).toBeNaN()
      expect(observed.at(-1)?.inputTokens).toBeNaN()
    } else {
      expect(result.inputTokens).toBe(Number.MAX_SAFE_INTEGER - 1)
    }
  },
)
