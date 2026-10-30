import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

// Factory Droid 1.0 builds its Anthropic SDK client from a custom model's
// baseUrl unchanged. With the ".../v1" base its OpenAI models need, the SDK
// appends "/v1/messages" again; these fixtures mirror that captured request.
const originalFetch = globalThis.fetch
const upstreamPaths: Array<string> = []
const upstreamBodies: Array<Record<string, unknown>> = []

const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-opus-5.5",
      name: "Claude Opus 5.5",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/v1/messages"],
      capabilities: {
        family: "claude-opus-5.5",
        limits: { max_output_tokens: 128_000 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    },
  ],
}

function messagesStream(): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_droid",
        type: "message",
        role: "assistant",
        model: "claude-opus-5.5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "A greeting." },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-droid" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "hi" },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ]
  return events
    .map(
      (event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("")
}

const fetchMock = mock(
  (url: string | URL | Request, init?: RequestInit): Response => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    const path = new URL(rawUrl).pathname
    upstreamPaths.push(path)
    if (path === "/v1/messages/count_tokens") {
      return Response.json({ input_tokens: 42 })
    }
    if (path !== "/v1/messages") {
      return new Response("unexpected upstream path", { status: 500 })
    }
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    upstreamBodies.push(body)
    // The managed web-search loop sends buffered requests.
    if (body.stream !== true) {
      return Response.json({
        id: "msg_droid",
        type: "message",
        role: "assistant",
        model: "claude-opus-5.5",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 5 },
      })
    }
    return new Response(messagesStream(), {
      headers: { "content-type": "text/event-stream" },
    })
  },
)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  upstreamPaths.length = 0
  upstreamBodies.length = 0
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.models = models
  await seedProtocolDatabase()
})

/** The request Droid 1.0 sends for a mission worker on Opus at "max". */
function droidMessagesBody(): Record<string, unknown> {
  return {
    model: "claude-opus-5.5",
    max_tokens: 128_000,
    stream: true,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "max" },
    system: [
      { type: "text", text: "You are Droid." },
      { type: "text", text: "Follow the repository instructions." },
      {
        type: "text",
        text: "Environment details.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: [
      {
        name: "Read",
        description: "Read a file.",
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>Workspace context.</system-reminder>",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Say hi",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  }
}

function droidHeaders(
  authentication: Record<string, string>,
): Record<string, string> {
  return {
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": "factory-cli/1.0.0",
    "x-stainless-package-version": "0.128.0",
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    ...authentication,
  }
}

async function postDroid(
  path: string,
  authentication: Record<string, string> = {
    "x-api-key": PROTOCOL_GATEWAY_KEY,
  },
  body: Record<string, unknown> = droidMessagesBody(),
): Promise<Response> {
  return await server.request(path, {
    method: "POST",
    headers: droidHeaders(authentication),
    body: JSON.stringify(body),
  })
}

test("serves Droid's doubled /v1/v1/messages path as the Messages API", async () => {
  const response = await postDroid("/v1/v1/messages")

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const stream = await response.text()
  expect(stream).toContain('"type":"signature_delta","signature":"sig-droid"')
  expect(stream).toContain('"type":"text_delta","text":"hi"')
  expect(stream).toContain("event: message_stop")
  expect(upstreamPaths).toEqual(["/v1/messages"])
  expect(upstreamBodies[0]).toMatchObject({
    model: "claude-opus-5.5",
    max_tokens: 128_000,
    stream: true,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "max" },
    system: [
      { text: "You are Droid." },
      { text: "Follow the repository instructions." },
      { cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  })
})

test("accepts Droid's bearer auth mode on the doubled path", async () => {
  const response = await postDroid("/v1/v1/messages", {
    authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toContain('"text":"hi"')
  expect(upstreamPaths).toEqual(["/v1/messages"])
})

test("gives the doubled path the managed web tools of /v1/messages", async () => {
  const toolless = droidMessagesBody()
  delete toolless.tools
  const hosted = droidMessagesBody()
  hosted.tools = [{ type: "web_search_20250305", name: "web_search" }]

  for (const body of [toolless, hosted]) {
    for (const path of ["/v1/v1/messages", "/v1/messages"]) {
      const response = await postDroid(path, undefined, body)
      expect(response.status).toBe(200)
      await response.text()
    }
  }

  const toolNames = upstreamBodies.map((body) =>
    (body.tools as Array<{ name: string }>).map((tool) => tool.name),
  )
  expect(toolNames).toEqual([
    ["_copilot_web_search"],
    ["_copilot_web_search"],
    ["web_search"],
    ["web_search"],
  ])
  expect(upstreamBodies[0]).toEqual(upstreamBodies[1])
  expect(upstreamBodies[2]).toEqual(upstreamBodies[3])
})

test("authenticates the doubled path like /v1/messages", async () => {
  const missing = await postDroid("/v1/v1/messages", {})
  const wrong = await postDroid("/v1/v1/messages", {
    "x-api-key": "not-a-gateway-key",
  })

  expect(missing.status).toBe(401)
  expect(wrong.status).toBe(401)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("serves token counting under the doubled prefix", async () => {
  const body = droidMessagesBody()
  delete body.stream
  delete body.max_tokens
  const response = await postDroid(
    "/v1/v1/messages/count_tokens",
    undefined,
    body,
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 42 })
  expect(upstreamPaths).toEqual(["/v1/messages/count_tokens"])
})

test("keeps the doubled prefix limited to the Messages endpoints", async () => {
  const routes: Array<[string, string]> = [
    ["POST", "/v1/v1/chat/completions"],
    ["POST", "/v1/v1/responses"],
    ["GET", "/v1/v1/models"],
    ["POST", "/v1/v1/v1/messages"],
    ["POST", "/v1/v1/messages/batches"],
    // The canonical routes are exact too: /v1/messages/ is not served.
    ["POST", "/v1/v1/messages/"],
  ]
  for (const [method, path] of routes) {
    const response = await server.request(path, {
      method,
      headers: droidHeaders({ "x-api-key": PROTOCOL_GATEWAY_KEY }),
      ...(method === "POST" ?
        { body: JSON.stringify(droidMessagesBody()) }
      : {}),
    })
    expect({ path, status: response.status }).toEqual({ path, status: 404 })
  }
  expect(fetchMock).not.toHaveBeenCalled()
})
