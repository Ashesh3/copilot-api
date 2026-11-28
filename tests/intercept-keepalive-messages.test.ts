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

const claudeModel = "claude-opus-5.5"
const claudeFallback = "claude-opus-5"
const responsesModel = "gpt-keepalive"
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
    models: {
      object: "list",
      data: [
        model(claudeModel, "anthropic", "/v1/messages"),
        model(claudeFallback, "anthropic", "/v1/messages"),
        model(responsesModel, "openai", "/responses"),
      ],
    },
  })
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    upstreamPaths.push(url.pathname)
    if (url.pathname === "/v1/messages") return Promise.resolve(messagesSse())
    if (url.pathname === "/responses") return Promise.resolve(responsesSse())
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

test("a held Copilot Responses-API Messages stream gets a keepalive before forward", async () => {
  await expectKeepaliveBeforeForward(responsesModel, "/responses")
})

test("a held native Claude stream with a fallback chain gets a keepalive before forward", async () => {
  setModelFallbackConfigForTest({
    enabled: true,
    notifyClient: false,
    nativeClientNotice: false,
    rules: [
      {
        id: "chain",
        sourceModel: claudeModel,
        targetModel: claudeFallback,
        enabled: true,
      },
    ],
  })
  await expectKeepaliveBeforeForward(claudeModel, "/v1/messages")
})

test("a held stream the operator drops ends with an Anthropic error event", async () => {
  const reader = await openHeldStream(claudeModel)
  expect(interceptEngine.dropAllPending("Not this one")).toBe(1)

  const body = await readRest(reader)
  expect(upstreamPaths).toEqual([])
  expect(body).toContain("event: error")
  expect(body).toContain('"type":"permission_error"')
})

test("the early response carries the CORS grant and request ID", async () => {
  process.env.COPILOT_INFERENCE_CORS_ORIGINS = "https://app.example"
  try {
    interceptEngine.updateConfig({ enabled: true, direction: "request" })
    await seedProtocolDatabase()
    const response = await fetchServer(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
          origin: "https://app.example",
          "x-request-id": "req-keepalive-1",
        },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    )
    expect(response.headers.get("x-request-id")).toBe("req-keepalive-1")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(interceptEngine.forwardAllPending()).toBe(1)
    expect(await response.text()).toContain("message_stop")
  } finally {
    delete process.env.COPILOT_INFERENCE_CORS_ORIGINS
  }
})

async function expectKeepaliveBeforeForward(
  modelId: string,
  upstreamPath: string,
): Promise<void> {
  const reader = await openHeldStream(modelId)
  // The request is still held: nothing reached the upstream yet.
  expect(upstreamPaths).toEqual([])
  expect(interceptEngine.getSnapshot().pending).toHaveLength(1)
  expect(interceptEngine.forwardAllPending()).toBe(1)

  const body = await readRest(reader)
  expect(upstreamPaths).toEqual([upstreamPath])
  expect(body).toContain("keepalive answer")
  expect(body).toContain("message_stop")
}

/** Send a streaming request that Intercept holds; its first bytes are a keepalive. */
async function openHeldStream(modelId: string) {
  interceptEngine.updateConfig({ enabled: true, direction: "request" })
  await seedProtocolDatabase()
  const response = await fetchServer(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain(SSE_HEARTBEAT_COMMENT)
  return reader
}

async function readRest(
  reader: Awaited<ReturnType<typeof openHeldStream>>,
): Promise<string> {
  const decoder = new TextDecoder()
  let body = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return body
    body += decoder.decode(chunk.value, { stream: true })
  }
}

function model(id: string, vendor: string, endpoint: string): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor,
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: [endpoint],
    capabilities: {
      family: vendor === "anthropic" ? "claude" : "gpt",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: { streaming: true },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events
    .map(
      (event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("")
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

function messagesSse(): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_keepalive",
        type: "message",
        role: "assistant",
        model: claudeModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "keepalive answer" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ])
}

function responsesSse(): Response {
  const message = {
    type: "message",
    id: "msg_resp_keepalive",
    role: "assistant",
    status: "completed",
    content: [
      { type: "output_text", text: "keepalive answer", annotations: [] },
    ],
  }
  const base = {
    id: "resp_keepalive",
    object: "response",
    model: responsesModel,
    created_at: 0,
  }
  return sse([
    {
      type: "response.created",
      sequence_number: 0,
      response: { ...base, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      delta: "keepalive answer",
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      text: "keepalive answer",
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: message,
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: {
        ...base,
        status: "completed",
        output: [message],
        output_text: "keepalive answer",
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      },
    },
  ])
}
