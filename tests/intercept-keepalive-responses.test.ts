import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { interceptEngine } from "~/lib/intercept/engine"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { SSE_HEARTBEAT_COMMENT } from "~/lib/sse-lifecycle"
import { state } from "~/lib/state"
import { fetchServer } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const routeModel = "gpt-responses-keepalive"
const originalFetch = globalThis.fetch
const originalState = { ...state }
const upstreamPaths: Array<string> = []

beforeEach(() => {
  upstreamPaths.length = 0
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
  Object.assign(state, {
    accountType: "individual",
    apiKeyAuth: PROTOCOL_GATEWAY_KEY,
    copilotToken: "keepalive-copilot-token",
    githubToken: "keepalive-github-token",
    isMultiToken: false,
    manualApprove: false,
  })
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    upstreamPaths.push(url.pathname)
    if (url.pathname === "/responses") return Promise.resolve(responsesSse())
    if (url.pathname === "/chat/completions") return Promise.resolve(chatSse())
    throw new Error(`Unexpected upstream request ${url.pathname}`)
  }) as typeof fetch
})

afterEach(() => {
  interceptEngine.resetForTest()
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
})

test.each([
  { endpoint: "/responses" as const, name: "native Responses" },
  { endpoint: "/chat/completions" as const, name: "Chat fallback" },
])(
  "a held $name stream gets a keepalive before forward",
  async ({ endpoint }) => {
    state.models = { object: "list", data: [model(endpoint)] }
    interceptEngine.updateConfig({ enabled: true, direction: "request" })
    await seedProtocolDatabase()
    const response = await fetchServer(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: routeModel,
          input: "hello",
          stream: true,
        }),
      }),
    )
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain(SSE_HEARTBEAT_COMMENT)

    // The request is still held: nothing reached the upstream yet.
    expect(upstreamPaths).toEqual([])
    expect(interceptEngine.getSnapshot().pending).toHaveLength(1)
    expect(interceptEngine.forwardAllPending()).toBe(1)

    let text = ""
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    expect(upstreamPaths).toEqual([endpoint])
    expect(text).toContain("keepalive answer")
    expect(text).toContain("event: response.completed")
  },
)

test("a held Google streamGenerateContent SSE gets a keepalive before forward", async () => {
  state.models = { object: "list", data: [model("/chat/completions")] }
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  await seedProtocolDatabase()
  const response = await fetchServer(
    new Request(
      `http://localhost/v1beta/models/${routeModel}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        }),
      },
    ),
  )
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const first = await reader.read()
  expect(decoder.decode(first.value)).toContain(SSE_HEARTBEAT_COMMENT)

  expect(upstreamPaths).toEqual([])
  expect(interceptEngine.getSnapshot().pending).toHaveLength(1)
  expect(interceptEngine.forwardAllPending()).toBe(1)

  let text = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  expect(upstreamPaths).toEqual(["/chat/completions"])
  expect(text).toContain("keepalive answer")
  expect(text).toContain('"finishReason":"STOP"')
})
function model(endpoint: "/responses" | "/chat/completions"): Model {
  return {
    id: routeModel,
    name: routeModel,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: [endpoint],
    capabilities: {
      family: "gpt",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: { streaming: true },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function sse(events: Array<{ event?: string; data: unknown }>): Response {
  const body = events
    .map(({ event, data }) => {
      const eventLine = event ? `event: ${event}\n` : ""
      const payload = typeof data === "string" ? data : JSON.stringify(data)
      return `${eventLine}data: ${payload}\n\n`
    })
    .join("")
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

function responsesSse(): Response {
  const response = {
    id: "resp_keepalive",
    object: "response",
    created_at: 1,
    model: routeModel,
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_keepalive",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "keepalive answer", annotations: [] },
        ],
      },
    ],
    output_text: "keepalive answer",
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
  return sse([
    {
      event: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_keepalive",
        output_index: 0,
        content_index: 0,
        delta: "keepalive answer",
      },
    },
    {
      event: "response.completed",
      data: { type: "response.completed", sequence_number: 2, response },
    },
  ])
}

function chatSse(): Response {
  const base = {
    id: "chatcmpl-keepalive",
    object: "chat.completion.chunk",
    created: 1,
    model: routeModel,
  }
  return sse([
    {
      data: {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "keepalive answer" },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    },
    { data: "[DONE]" },
  ])
}
