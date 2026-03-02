import { test, expect, mock, beforeAll, afterAll } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
  StreamNormalizationState,
} from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import {
  createChatCompletions,
  normalizeStreamingChunk,
} from "../src/services/copilot/create-chat-completions"

// Save and restore original fetch so integration tests aren't affected
const originalFetch = globalThis.fetch

// Mock state
state.copilotToken = "test-token"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    const responseHeaders = new Headers()
    return {
      ok: true,
      status: 200,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      text: () =>
        Promise.resolve(
          JSON.stringify({
            id: "123",
            object: "chat.completion",
            choices: [],
          }),
        ),
      clone: () => ({
        text: () => Promise.resolve(""),
      }),
      headers: responseHeaders,
      _requestHeaders: opts.headers,
    }
  },
)

beforeAll(() => {
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("normalizes malformed streaming tool-call chunks", () => {
  const state: StreamNormalizationState = {
    roleSetByChoiceIndex: new Set<number>(),
    toolCallMappingsByChoiceIndex: new Map(),
  }

  const emptyFirstChunk = {
    id: "chunk-0",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [{ index: 0, delta: {}, finish_reason: null, logprobs: null }],
  } as ChatCompletionChunk

  normalizeStreamingChunk(emptyFirstChunk, state)
  expect(emptyFirstChunk.choices[0].delta.role).toBe("assistant")

  const malformedToolCallChunk = {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 1,
              id: "call_1",
              function: { name: "get_weather", arguments: '{"loc' },
            },
          ],
        },
        logprobs: null,
      },
    ],
  } as unknown as ChatCompletionChunk

  normalizeStreamingChunk(malformedToolCallChunk, state)
  expect(malformedToolCallChunk.choices[0].delta.role).toBe("assistant")
  expect(malformedToolCallChunk.choices[0].finish_reason).toBe("tool_calls")
  expect(malformedToolCallChunk.choices[0].delta.tool_calls?.[0]?.index).toBe(0)

  const continuationChunk = {
    id: "chunk-2",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 1,
              function: { arguments: 'ation":"Paris"}' },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  } as ChatCompletionChunk

  normalizeStreamingChunk(continuationChunk, state)
  expect(continuationChunk.choices[0].delta.tool_calls?.[0]?.index).toBe(0)

  const recycledIndexChunk = {
    id: "chunk-3",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 1,
              id: "call_2",
              function: { name: "get_time", arguments: "{}" },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  } as ChatCompletionChunk

  normalizeStreamingChunk(recycledIndexChunk, state)
  expect(recycledIndexChunk.choices[0].delta.tool_calls?.[0]?.index).toBe(1)
})

test("skips non-function tools during payload normalization", async () => {
  const payload = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { type: "web_search" },
      { type: "function", function: { name: "get_weather" } },
    ],
  } as unknown as ChatCompletionsPayload

  await createChatCompletions(payload)

  const lastCall = fetchMock.mock.calls.at(-1)?.[1] as unknown as {
    body: string
  }
  const sentBody = JSON.parse(lastCall.body) as {
    tools: Array<Record<string, unknown>>
  }

  expect(sentBody.tools[0]?.type).toBe("web_search")
  expect(sentBody.tools[1]?.type).toBe("function")
  expect(
    (sentBody.tools[1]?.function as { parameters?: Record<string, unknown> })
      .parameters,
  ).toEqual({ type: "object", properties: {} })
})
