import { test, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// Save and restore original fetch so integration tests aren't affected
const originalFetch = globalThis.fetch
const queuedResponses: Array<Response> = []

const createDefaultResponse = () =>
  new Response(
    JSON.stringify({
      id: "123",
      object: "chat.completion",
      choices: [],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )

const createSSEStreamResponse = (messages: Array<string>) =>
  new Response(`${messages.join("\n\n")}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

// Mock state
state.copilotToken = "test-token"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    void opts
    return queuedResponses.shift() ?? createDefaultResponse()
  },
)

beforeAll(() => {
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  queuedResponses.length = 0
  setModelSettingsForTest([])
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
    fetchMock.mock.calls.at(-1)?.[1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
  expect(headers["X-Interaction-Type"]).toBe("conversation-agent")
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
    fetchMock.mock.calls.at(-1)?.[1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
  expect(headers["X-Interaction-Type"]).toBe("conversation-user")
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

test("retries streamed chat completions when the first SSE event is an overload error", async () => {
  const overloadEvent = 'data: {"error":{"message":"Overloaded"}}'
  const successChunk = JSON.stringify({
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        delta: { content: "hello" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })

  queuedResponses.push(
    createSSEStreamResponse([overloadEvent]),
    createSSEStreamResponse([`data: ${successChunk}`, "data: [DONE]"]),
  )

  const startCallCount = fetchMock.mock.calls.length
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }

  const response = await createChatCompletions(payload)
  const receivedEvents: Array<string> = []

  for await (const chunk of response as AsyncIterable<{ data?: string }>) {
    if (chunk.data) {
      receivedEvents.push(chunk.data)
    }
  }

  expect(fetchMock.mock.calls.length - startCallCount).toBe(2)
  expect(receivedEvents).toEqual([successChunk, "[DONE]"])
})

test("defaults stream_options.include_usage for direct streaming chat completions", async () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }

  queuedResponses.push(createSSEStreamResponse(["data: [DONE]"]))

  await createChatCompletions(payload)

  const lastCall = fetchMock.mock.calls.at(-1)?.[1] as unknown as {
    body: string
  }
  const sentBody = JSON.parse(lastCall.body) as ChatCompletionsPayload

  expect(sentBody.stream_options).toEqual({ include_usage: true })
})

test("rewrites final assistant messages for models without assistant prefill", async () => {
  setModelSettingsForTest([
    {
      model: "claude-no-prefill",
      supportsAssistantPrefill: false,
    },
  ])

  const payload: ChatCompletionsPayload = {
    model: "claude-no-prefill",
    stream: true,
    messages: [
      { role: "user", content: "Help me investigate an error." },
      {
        role: "assistant",
        content: "I have enough context to continue.",
        reasoning_text: "Private assistant reasoning",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{}",
            },
          },
        ],
      },
    ],
  }

  queuedResponses.push(createSSEStreamResponse(["data: [DONE]"]))

  await createChatCompletions(payload)

  const lastCall = fetchMock.mock.calls.at(-1)?.[1] as unknown as {
    body: string
  }
  const sentBody = JSON.parse(lastCall.body) as ChatCompletionsPayload

  expect(sentBody.messages).toEqual([
    { role: "user", content: "Help me investigate an error." },
    { role: "user", content: "I have enough context to continue." },
  ])
})

test("preserves final assistant messages when assistant prefill is unset", async () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    messages: [
      { role: "user", content: "Help me investigate an error." },
      { role: "assistant", content: "I have enough context to continue." },
    ],
  }

  await createChatCompletions(payload)

  const lastCall = fetchMock.mock.calls.at(-1)?.[1] as unknown as {
    body: string
  }
  const sentBody = JSON.parse(lastCall.body) as ChatCompletionsPayload

  expect(sentBody.messages[0]).toEqual({
    role: "user",
    content: "Help me investigate an error.",
  })
  expect(sentBody.messages[1]?.role).toBe("assistant")
  expect(sentBody.messages[1]?.content).toBe(
    "I have enough context to continue.",
  )
})

test("rewrites upstream chat completions 404 responses to 502", async () => {
  queuedResponses.push(
    new Response("model not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    }),
  )

  try {
    await createChatCompletions({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
    })
    throw new Error("Expected createChatCompletions to reject")
  } catch (error) {
    expect(error).toHaveProperty("response.status", 502)
  }
})
