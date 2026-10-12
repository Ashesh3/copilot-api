import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { getHistoryRuntime } from "~/lib/telemetry-writer"
import { enableDatabaseUsageForTest } from "~/lib/usage-tracker"
import { responsesWebSocket } from "~/routes/responses/websocket"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  manualApprove: state.manualApprove,
  models: state.models,
}
const upstream: Array<Response> = []
const requests: Array<Record<string, unknown>> = []

beforeEach(() => {
  upstream.length = 0
  requests.length = 0
  enableDatabaseUsageForTest()
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest({
    enabled: false,
    notifyClient: false,
    nativeClientNotice: false,
    rules: [],
  })
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      "usage-native",
      "usage-fallback",
      "usage-chat",
      "usage-messages",
    ].map((id) => ({
      id,
      name: id,
      object: "model",
      preview: false,
      vendor: id === "usage-messages" ? "anthropic" : "openai",
      version: "test",
      model_picker_enabled: true,
      supported_endpoints: [
        (
          {
            "usage-chat": "/chat/completions",
            "usage-messages": "/v1/messages",
          } as Record<string, string>
        )[id] ?? "/responses",
      ],
      capabilities: {
        family: "gpt",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    })),
  } satisfies ModelsResponse
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected an inference request")
    requests.push(JSON.parse(init.body) as Record<string, unknown>)
    const response = upstream.shift()
    if (!response) throw new Error("Unexpected upstream request")
    return Promise.resolve(response)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

function result(
  options: {
    input?: number
    output?: number
    status?: string
    usage?: boolean
  } = {},
) {
  return {
    id: "resp_usage",
    object: "response",
    created_at: 1,
    model: "usage-native",
    status: options.status ?? "completed",
    output: [],
    output_text: "",
    usage:
      options.usage === false ?
        null
      : {
          input_tokens: options.input ?? 17,
          output_tokens: options.output ?? 4,
          total_tokens: (options.input ?? 17) + (options.output ?? 4),
        },
    error: null,
    incomplete_details: null,
  }
}

function eventStream(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function nativeStream(options: Parameters<typeof result>[0] = {}): Response {
  return eventStream([
    {
      type: "response.created",
      response: result({ status: "in_progress", usage: false }),
    },
    {
      type:
        options.status === "incomplete" ?
          "response.incomplete"
        : "response.completed",
      response: result(options),
    },
  ])
}

async function postResponses(payload: Record<string, unknown>) {
  await seedProtocolDatabase()
  return await server.request("/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "usage-native", input: "hello", ...payload }),
  })
}

function socket() {
  const sent: Array<Record<string, unknown>> = []
  const data: ResponsesWebSocketData = {
    activeTurns: new Map(),
    closed: false,
    nextTurnSequence: 0,
    type: "responses",
    requestId: "usage-websocket",
    nativeMessagesOptions: {},
    effectiveNativeMessagesOptions: {},
    responseSnapshots: new Map(),
  }
  return {
    data,
    sent,
    send: (frame: string) => {
      sent.push(JSON.parse(frame) as Record<string, unknown>)
    },
    close() {},
  }
}

async function sendTurn(
  ws: ReturnType<typeof socket>,
  payload: Record<string, unknown> = {},
) {
  await seedProtocolDatabase()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model: "usage-native",
      input: "hello",
      ...payload,
    }),
  )
}

async function usageHistory() {
  const runtime = getHistoryRuntime()
  return await runtime.writer.read((pending) =>
    runtime.repository.readUsage(0, pending),
  )
}

test.each([false, true])(
  "native HTTP counts reported usage once for stream=%s",
  async (stream) => {
    upstream.push(stream ? nativeStream() : Response.json(result()))
    const response = await postResponses({ stream })
    await response.text()
    expect(response.status).toBe(200)
    expect((await usageHistory()).lifetime).toMatchObject({
      inputTokens: 17,
      outputTokens: 4,
      requestCount: 1,
    })
  },
)

test("native buffered SSE counts the accepted terminal usage", async () => {
  upstream.push(nativeStream())
  const response = await postResponses({
    stream: true,
    tools: [
      {
        type: "function",
        name: "web_search",
        description: "Search",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ],
  })
  expect(await response.text()).toContain("event: response.completed")
  expect(requests).toHaveLength(1)
  expect((await usageHistory()).lifetime).toMatchObject({
    inputTokens: 17,
    outputTokens: 4,
    requestCount: 1,
  })
})

test("native SSE counts incomplete usage but excludes failed and provisional usage", async () => {
  upstream.push(
    nativeStream({ status: "incomplete" }),
    eventStream([
      {
        type: "response.created",
        response: result({ status: "in_progress", input: 900, output: 900 }),
      },
      {
        type: "response.failed",
        response: result({ status: "failed", input: 900, output: 900 }),
      },
    ]),
  )
  expect(await (await postResponses({ stream: true })).text()).toContain(
    "event: response.incomplete",
  )
  expect(await (await postResponses({ stream: true })).text()).toContain(
    "event: response.failed",
  )
  expect((await usageHistory()).lifetime).toMatchObject({
    inputTokens: 17,
    outputTokens: 4,
    requestCount: 1,
  })
})

test.each([false, true])(
  "native HTTP preserves an explicitly reported zero usage for stream=%s",
  async (stream) => {
    const options = { input: 0, output: 0 }
    upstream.push(
      stream ? nativeStream(options) : Response.json(result(options)),
    )
    await (await postResponses({ stream })).text()
    expect((await usageHistory()).lifetime).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 1,
    })
  },
)

test.each([false, true])(
  "native HTTP does not invent absent usage for stream=%s",
  async (stream) => {
    upstream.push(
      stream ?
        nativeStream({ usage: false })
      : Response.json(result({ usage: false })),
    )
    await (await postResponses({ stream })).text()
    expect((await usageHistory()).lifetime.requestCount).toBe(0)
  },
)

test.each(["completed", "incomplete"])(
  "WebSocket accounts actual %s usage exactly once",
  async (status) => {
    upstream.push(
      eventStream([
        { type: `response.${status}`, response: result({ status }) },
        {
          type: "response.completed",
          response: result({ input: 900, output: 900 }),
        },
      ]),
    )
    const ws = socket()
    await sendTurn(ws)
    responsesWebSocket.close(ws)
    expect(
      ws.sent.filter((frame) => frame.type === `response.${status}`),
    ).toHaveLength(1)
    expect((await usageHistory()).lifetime).toMatchObject({
      inputTokens: 17,
      outputTokens: 4,
      requestCount: 1,
    })
  },
)

test("WebSocket counts actual zero usage but leaves absent usage unrecorded", async () => {
  upstream.push(
    nativeStream({ input: 0, output: 0 }),
    nativeStream({ usage: false }),
  )
  const ws = socket()
  await sendTurn(ws)
  await sendTurn(ws)
  expect((await usageHistory()).lifetime).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 1,
  })
})

test("WebSocket does not record an empty terminal usage object", async () => {
  upstream.push(
    eventStream([
      { type: "response.completed", response: { ...result(), usage: {} } },
    ]),
  )
  await sendTurn(socket())
  expect((await usageHistory()).lifetime.requestCount).toBe(0)
})

test("WebSocket preserves a reported output count when input is omitted", async () => {
  upstream.push(
    eventStream([
      {
        type: "response.completed",
        response: { ...result(), usage: { output_tokens: 4 } },
      },
    ]),
  )
  await sendTurn(socket())
  expect((await usageHistory()).lifetime).toMatchObject({
    inputTokens: 0,
    outputTokens: 4,
    requestCount: 1,
  })
  const runtime = getHistoryRuntime()
  const collection = await runtime.writer.read((pending) =>
    runtime.repository.collectionStatus(undefined, pending),
  )
  expect(collection.unknownGaps).toBe(0)
})

test("WebSocket warmups and failed responses never count as successful usage", async () => {
  const ws = socket()
  await sendTurn(ws, { generate: false })
  expect(requests).toHaveLength(0)
  upstream.push(
    eventStream([
      { type: "response.failed", response: result({ status: "failed" }) },
    ]),
  )
  await sendTurn(ws)
  expect(ws.sent.some((frame) => frame.type === "response.failed")).toBe(true)
  expect((await usageHistory()).lifetime.requestCount).toBe(0)
})

test("WebSocket synthetic permission reviews do not create zero-usage requests", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  const ws = socket()
  await sendTurn(ws, { model: "codex-auto-review" })
  expect(ws.sent.some((frame) => frame.type === "response.completed")).toBe(
    true,
  )
  expect(requests).toHaveLength(0)
  expect((await usageHistory()).lifetime.requestCount).toBe(0)
})

test("WebSocket cancellation discards provisional and unaccepted terminal usage", async () => {
  upstream.push(
    eventStream([
      {
        type: "response.created",
        response: result({ status: "in_progress", input: 900, output: 900 }),
      },
      { type: "response.completed", response: result() },
    ]),
  )
  const ws = socket()
  const send = ws.send
  ws.send = (frame) => {
    send(frame)
    responsesWebSocket.close(ws)
  }
  await sendTurn(ws)
  expect(ws.sent.map((frame) => frame.type)).toEqual(["response.created"])
  expect((await usageHistory()).lifetime.requestCount).toBe(0)
})

test("WebSocket native Messages translation counts reported usage including cache tokens", async () => {
  upstream.push(
    Response.json({
      id: "msg_usage",
      type: "message",
      role: "assistant",
      model: "usage-messages",
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
    }),
  )
  const ws = socket()
  await sendTurn(ws, { model: "usage-messages" })
  expect(ws.sent.some((frame) => frame.type === "response.completed")).toBe(
    true,
  )
  const usage = await usageHistory()
  expect(usage.lifetime).toMatchObject({
    inputTokens: 17,
    outputTokens: 4,
    requestCount: 1,
  })
  expect(usage.buckets[0]?.model).toBe("usage-messages")
})

test("WebSocket records only the accepted fallback model's usage", async () => {
  setModelFallbackConfigForTest({
    enabled: true,
    notifyClient: false,
    nativeClientNotice: false,
    rules: [
      {
        id: "usage-fallback",
        sourceModel: "usage-native",
        targetModel: "usage-fallback",
        enabled: true,
      },
    ],
  })
  upstream.push(new Response("unprocessable", { status: 422 }), nativeStream())
  const ws = socket()
  await sendTurn(ws)
  expect(requests.map((request) => request.model)).toEqual([
    "usage-native",
    "usage-fallback",
  ])
  const usage = await usageHistory()
  expect(usage.lifetime.requestCount).toBe(1)
  expect(usage.buckets).toHaveLength(1)
  expect(usage.buckets[0]).toMatchObject({
    inputTokens: 17,
    outputTokens: 4,
    requestCount: 1,
    model: "usage-fallback",
  })
})

test.each([false, true])(
  "translated Chat WebSocket preserves whether usage was reported: %s",
  async (reported) => {
    upstream.push(
      new Response(
        [
          {
            choices: [
              { index: 0, delta: { content: "answer" }, finish_reason: "stop" },
            ],
          },
          ...(reported ?
            [
              {
                choices: [],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0,
                },
              },
            ]
          : []),
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    const ws = socket()
    await sendTurn(ws, { model: "usage-chat" })
    const terminal = ws.sent.find(
      (frame) => frame.type === "response.completed",
    )
    expect(terminal).toBeDefined()
    expect(terminal?.response).toMatchObject({
      usage: reported ? { input_tokens: 0, output_tokens: 0 } : null,
    })
    expect((await usageHistory()).lifetime.requestCount).toBe(reported ? 1 : 0)
  },
)
