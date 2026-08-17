import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import { Hono, type Context } from "hono"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { forwardError, LocalHTTPError } from "../src/lib/error"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { handleCompletion } from "../src/routes/chat-completions/handler"
import { server } from "../src/server"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "../src/services/copilot/compaction-payload"
import {
  createChatCompletions,
  createChatCompletionsWithProcessedPayload,
  type Message,
} from "../src/services/copilot/create-chat-completions"

// Save and restore original fetch so integration tests aren't affected
const originalFetch = globalThis.fetch
const originalIsMultiToken = state.isMultiToken
const addedAccountIds = [2101, 2102]
const queuedResponses: Array<Response> = []
let capturedAffinity: RoutingAffinity | undefined
const capturedAuthorization: Array<string | undefined> = []
let lastRequestBody: Record<string, unknown> | undefined

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
  (_url: string, opts: { body?: string; headers: Record<string, string> }) => {
    capturedAffinity = getRoutingAffinity()
    capturedAuthorization.push(opts.headers.Authorization)
    lastRequestBody =
      opts.body ? (JSON.parse(opts.body) as Record<string, unknown>) : undefined
    void opts
    return queuedResponses.shift() ?? createDefaultResponse()
  },
)

beforeAll(() => {
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock
})

afterAll(() => {
  for (const accountId of addedAccountIds)
    tokenPool.removeAccountForTest(accountId)
  state.isMultiToken = originalIsMultiToken
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  queuedResponses.length = 0
  capturedAffinity = undefined
  lastRequestBody = undefined
  capturedAuthorization.length = 0
  state.isMultiToken = originalIsMultiToken
  setModelSettingsForTest([])
  resetRoutingTelemetryForTest()
})

test("returns a safe local Chat error for a null JSON body", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  })
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(400)
  expect(body).toEqual({
    error: {
      code: "invalid_type",
      message: "The request body must be a JSON object.",
      param: "body",
      type: "invalid_request_error",
    },
  })
  expect(JSON.stringify(body)).not.toContain("Cannot read properties")
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects direct BigInt payloads before upstream serialization", async () => {
  let thrown: unknown
  try {
    await createChatCompletions({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      metadata: { count: 1n },
    } as unknown as ChatCompletionsPayload)
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(LocalHTTPError)
  expect(thrown).toHaveProperty("response.status", 400)
  expect(thrown).toHaveProperty("clientBody.error", {
    code: "invalid_type",
    message: "The request body must be a JSON object.",
    param: "body",
    type: "invalid_request_error",
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects direct cyclic payloads before upstream serialization", async () => {
  const payload = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
  } as unknown as ChatCompletionsPayload & { self?: unknown }
  payload.self = payload
  let thrown: unknown

  try {
    await createChatCompletions(payload)
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(LocalHTTPError)
  expect(thrown).toHaveProperty("response.status", 400)
  expect(thrown).toHaveProperty("clientBody.error", {
    code: "invalid_type",
    message: "The request body must be a JSON object.",
    param: "body",
    type: "invalid_request_error",
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("returns the fixed route error for programmatic BigInt and cyclic bodies", async () => {
  const payloads: Array<unknown> = [
    {
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      metadata: { count: 1n },
    },
  ]
  const cyclic = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
  } as Record<string, unknown>
  cyclic.self = cyclic
  payloads.push(cyclic)

  for (const payload of payloads) {
    const app = new Hono()
    app.post("/", async (c) => {
      const context = Object.create(c) as Context
      Object.defineProperty(context, "req", {
        value: { json: () => Promise.resolve(payload) },
      })
      try {
        return await handleCompletion(context)
      } catch (error) {
        return await forwardError(c, error)
      }
    })
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_type",
        message: "The request body must be a JSON object.",
        param: "body",
        type: "invalid_request_error",
      },
    })
  }
  expect(fetchMock).not.toHaveBeenCalled()
})

test("fits explicitly marked ChatCompletions compaction payloads", async () => {
  const oversizedOutput =
    "BEGIN-CHAT-TRANSPORT\n"
    + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
    + "\nEND-CHAT-TRANSPORT"

  await createChatCompletions(
    {
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_chat_transport",
              type: "function",
              function: {
                name: "exec",
                arguments: JSON.stringify({ input: "run chat diagnostic" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_chat_transport",
          content: oversizedOutput,
        },
      ] as Array<Message>,
    },
    { compaction: true },
  )

  const serialized = JSON.stringify(lastRequestBody)
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    COMPACTION_PAYLOAD_MAX_BYTES,
  )
  expect(serialized).toContain("run chat diagnostic")
  expect(serialized).toContain("call_chat_transport")
  expect(serialized).toContain("BEGIN-CHAT-TRANSPORT")
  expect(serialized).toContain("END-CHAT-TRANSPORT")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
})

test("installs Claude metadata affinity before provider dispatch", async () => {
  const model = "claude-metadata-routing-model"
  for (const [id, token] of [
    [2101, "metadata-token-one"],
    [2102, "metadata-token-two"],
  ] as const) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = token
    account.healthy = true
    account.models = new Set([model])
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true
  const request = () =>
    server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32,
        metadata: {
          user_id: JSON.stringify({ session_id: "claude-body-session" }),
        },
      }),
    })

  const first = await request()
  const second = await request()

  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(capturedAffinity).toEqual({
    key: "claude-body-session",
    source: "claude_metadata",
  })
  const expected = tokenPool.getAccountForModelBySession(
    model,
    "claude-body-session",
  )
  expect(capturedAuthorization).toEqual([
    `Bearer ${expected?.copilotToken}`,
    `Bearer ${expected?.copilotToken}`,
  ])
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

test("dispatches normalized deprecated Chat controls without mutating the caller", async () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
    functions: [{ name: "legacy_lookup", parameters: {} }],
    function_call: { name: "legacy_lookup" },
    stream: true,
  }
  const original = structuredClone(payload)
  queuedResponses.push(createSSEStreamResponse(["data: [DONE]"]))

  await createChatCompletions(payload)

  expect(payload).toEqual(original)
  expect(lastRequestBody).toMatchObject({
    tools: [
      {
        type: "function",
        function: {
          name: "legacy_lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: "legacy_lookup" },
    },
    stream_options: { include_usage: true },
  })
  expect(lastRequestBody).not.toHaveProperty("functions")
  expect(lastRequestBody).not.toHaveProperty("function_call")
})

test("exposes the processed clone without changing the direct response API", async () => {
  setModelSettingsForTest([
    { model: "claude-no-prefill", supportsAssistantPrefill: false },
  ])
  const payload: ChatCompletionsPayload = {
    model: "claude-no-prefill",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "prefill" },
    ],
  }
  const original = structuredClone(payload)
  const { processedPayload, response } =
    await createChatCompletionsWithProcessedPayload(payload)

  expect(response).toHaveProperty("object", "chat.completion")
  expect(payload).toEqual(original)
  expect(processedPayload.messages[1]).toEqual({
    role: "user",
    content: "prefill",
  })
})

test("isolates the processed snapshot from stream retry state", async () => {
  const overloadEvent = 'data: {"error":{"message":"Overloaded"}}'
  queuedResponses.push(
    createSSEStreamResponse([overloadEvent]),
    createSSEStreamResponse(["data: [DONE]"]),
  )
  const payload: ChatCompletionsPayload = {
    model: "gpt-test",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }

  const { processedPayload, response } =
    await createChatCompletionsWithProcessedPayload(payload)
  processedPayload.model = "attacker-model"
  processedPayload.messages[0].content = "attacker-content"
  for await (const _event of response as AsyncIterable<unknown>) {
    // Drain so streamed retry handling completes.
  }

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(lastRequestBody?.model).toBe("gpt-test")
  expect(lastRequestBody?.messages).toEqual([
    { role: "user", content: "hello" },
  ])
})

test("ignores removed processed-payload hooks without changing responses", async () => {
  const response = await createChatCompletions(
    {
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
    },
    {
      onProcessedPayload: () => {
        throw new Error("hook failure")
      },
    } as unknown as Parameters<typeof createChatCompletions>[1],
  )

  expect(response).toHaveProperty("object", "chat.completion")
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("isolates processed snapshots from non-streaming response state", async () => {
  queuedResponses.push(
    new Response(
      JSON.stringify({
        id: "json-response",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: '```json\n{"ok":true}\n```',
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    ),
  )
  const { processedPayload, response } =
    await createChatCompletionsWithProcessedPayload({
      model: "gpt-test",
      messages: [{ role: "user", content: "return JSON" }],
      response_format: { type: "json_object" },
    })
  processedPayload.response_format = null

  expect(response).toHaveProperty("choices.0.message.content", '{"ok":true}')
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
  const usage = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(usage.totals).toMatchObject({
    retries: 1,
    upstreamCalls: 2,
  })
  expect(
    usage.selectionModes.sticky
      + usage.selectionModes.default
      + usage.selectionModes.single,
  ).toBe(1)
})

test("stream overload retry keeps the image-stripped compaction body", async () => {
  const overloadEvent = 'data: {"error":{"message":"Overloaded"}}'
  const successChunk = JSON.stringify({
    id: "chunk-image-retry",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        delta: { content: "ok" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  })
  const requestBodies: Array<string> = []
  const originalMock = globalThis.fetch
  let call = 0
  const chainedFetch = mock((_url: string, init?: RequestInit) => {
    requestBodies.push(typeof init?.body === "string" ? init.body : "")
    call += 1
    if (call === 1) return new Response("too large", { status: 413 })
    if (call === 2) return createSSEStreamResponse([overloadEvent])
    return createSSEStreamResponse([`data: ${successChunk}`, "data: [DONE]"])
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    chainedFetch as unknown as typeof fetch

  try {
    const response = await createChatCompletions(
      {
        model: "gpt-test",
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${"a".repeat(4096)}`,
                },
              },
            ],
          },
        ],
      },
      { compaction: true },
    )
    for await (const _event of response as AsyncIterable<unknown>) {
      // Drain the stream so the overload retry executes.
    }
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalMock
  }

  expect(requestBodies).toHaveLength(3)
  expect(requestBodies[0]).toContain("data:image/png;base64")
  expect(requestBodies[1]).not.toContain("data:image/png;base64")
  expect(requestBodies[2]).toBe(requestBodies[1] ?? "")
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

test("rewrites final assistant messages for built-in no-prefill models", async () => {
  const payload: ChatCompletionsPayload = {
    model: "claude-opus-4.8",
    stream: true,
    messages: [
      { role: "user", content: "Help me investigate an error." },
      {
        role: "assistant",
        content: "I have enough context to continue.",
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

test("does not log malformed upstream ChatCompletions bodies", async () => {
  const privateMarker = "chat-invalid-json-private-marker"
  queuedResponses.push(
    new Response(privateMarker, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )
  const errorSpy = spyOn(consola, "error")

  try {
    let thrown: unknown
    try {
      await createChatCompletions({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toHaveProperty("response.status", 502)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateMarker)
  } finally {
    errorSpy.mockRestore()
  }
})

test("does not log upstream ChatCompletions status text", async () => {
  const privateMarker = "chat-private-status-marker"
  queuedResponses.push(
    Response.json(
      { error: { code: "invalid_request_body", message: "invalid" } },
      { status: 400, statusText: privateMarker },
    ),
  )
  const errorSpy = spyOn(consola, "error")

  try {
    let thrown: unknown
    try {
      await createChatCompletions({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toHaveProperty("response.status", 400)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateMarker)
  } finally {
    errorSpy.mockRestore()
  }
})
