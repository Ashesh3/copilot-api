import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import {
  enableDatabaseUsageForTest,
  getUsageResponse,
  resetUsageForTest,
} from "~/lib/usage-tracker"
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
const responses: Array<Response> = []
let logs: ReturnType<typeof spyOn<typeof console, "log">>

beforeEach(() => {
  resetUsageForTest()
  responses.length = 0
  logs = spyOn(console, "log").mockImplementation(() => {})
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
      {
        id: "usage-native-messages",
        name: "Usage Native Messages",
        object: "model",
        vendor: "anthropic",
        version: "test",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  } satisfies ModelsResponse
  globalThis.fetch = ((url: string | URL | Request) => {
    const requestUrl =
      typeof url === "string" || url instanceof URL ? url : url.url
    expect(new URL(requestUrl).pathname).toBe("/v1/messages")
    const response = responses.shift()
    if (!response) throw new Error("Unexpected upstream request")
    return Promise.resolve(response)
  }) as typeof fetch
})

afterEach(() => {
  logs.mockRestore()
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  enableDatabaseUsageForTest()
})

function event(type: string, fields: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

function startEvent(usage?: Record<string, unknown>): string {
  return event("message_start", {
    message: {
      id: "msg_usage",
      type: "message",
      role: "assistant",
      model: "usage-native-messages",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      ...(usage ? { usage } : {}),
    },
  })
}

async function openRequest(
  path: string,
  upstream: Response,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  responses.push(upstream)
  await seedProtocolDatabase()
  const response = await server.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      /:(?:streamGenerateContent|generateContent)/.test(path) ?
        {
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          ...overrides,
        }
      : {
          model: "usage-native-messages",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 16,
          stream: true,
          ...overrides,
        },
    ),
  })
  expect(response.status).toBe(200)
  return response
}

async function runRequest(path: string, stream: string): Promise<string> {
  const response = await openRequest(
    path,
    new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  )
  return response.text()
}

async function expectUsage(input: number, output: number, requests: number) {
  expect((await getUsageResponse()).lifetime).toMatchObject({
    total_input_tokens: input,
    total_output_tokens: output,
    total_requests: requests,
  })
}

for (const path of ["/v1/messages", "/v1/chat/completions"]) {
  test.each(["eof", "error", "stop"])(
    `${path} does not invent zero usage at %s without upstream counts`,
    async (terminal) => {
      let ending = ""
      if (terminal === "error") {
        ending = event("error", {
          error: { type: "api_error", message: "fixture failure" },
        })
      } else if (terminal === "stop") {
        ending = event("message_stop")
      }
      const body = await runRequest(path, startEvent() + ending)
      await expectUsage(0, 0, 0)
      if (terminal === "stop" && path === "/v1/chat/completions") {
        expect(body).toContain('"finish_reason":"stop"')
        expect(body).not.toContain('"usage":')
      }
    },
  )

  test(`${path} does not invent usage from an empty usage object`, async () => {
    await runRequest(path, startEvent({}) + event("message_stop"))
    await expectUsage(0, 0, 0)
  })

  test(`${path} counts explicitly reported zero usage once`, async () => {
    await runRequest(
      path,
      startEvent({ input_tokens: 0, output_tokens: 0 }) + event("message_stop"),
    )
    await expectUsage(0, 0, 1)
  })

  test(`${path} records cumulative final input and cache usage once`, async () => {
    await runRequest(
      path,
      startEvent({
        input_tokens: 5,
        output_tokens: 0,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      })
        + event("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
        })
        + event("message_stop"),
    )
    await expectUsage(13, 3, 1)
  })
}

test.each([
  { path: "/v1/messages", observedAt: "message_start" },
  { path: "/v1/messages", observedAt: "message_delta" },
  { path: "/v1/chat/completions", observedAt: "message_start" },
  { path: "/v1/chat/completions", observedAt: "message_delta" },
  {
    path: "/v1/models/usage-native-messages:streamGenerateContent?alt=sse",
    observedAt: "message_start",
  },
  {
    path: "/v1/models/usage-native-messages:streamGenerateContent?alt=sse",
    observedAt: "message_delta",
  },
])(
  "$path cancellation retains usage observed at $observedAt exactly once",
  async ({ path, observedAt }) => {
    const upstream = new TransformStream<Uint8Array, Uint8Array>()
    const upstreamWriter = upstream.writable.getWriter()
    const response = await openRequest(
      path,
      new Response(upstream.readable, {
        headers: { "content-type": "text/event-stream" },
      }),
    )
    if (!response.body) throw new Error("Missing Messages response stream")
    const reader =
      response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const frames = [
      startEvent({
        input_tokens: 5,
        output_tokens: 0,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      }),
      ...(observedAt === "message_delta" ?
        [
          event("message_delta", {
            delta: { stop_reason: null },
            usage: {
              input_tokens: 7,
              output_tokens: 3,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 2,
            },
          }),
        ]
      : []),
      event("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "usage-observed" },
      }),
    ].join("")
    const writing = upstreamWriter.write(new TextEncoder().encode(frames))
    const marker = "usage-observed"
    let downstream = ""
    try {
      while (!downstream.includes(marker)) {
        const chunk = await reader.read()
        expect(chunk.done).toBe(false)
        downstream += new TextDecoder().decode(chunk.value)
      }
      await writing
      await expectUsage(0, 0, 0)
      await reader.cancel("client disconnected")
      await expectUsage(
        observedAt === "message_delta" ? 13 : 8,
        observedAt === "message_delta" ? 3 : 0,
        1,
      )
      await reader.cancel()
      await expectUsage(
        observedAt === "message_delta" ? 13 : 8,
        observedAt === "message_delta" ? 3 : 0,
        1,
      )
    } finally {
      await reader.cancel().catch(() => {})
      await upstreamWriter.close().catch(() => {})
    }
  },
)

test.each([false, true])(
  "Chat-to-Messages web-search final usage is recorded for stream=%s",
  async (stream) => {
    const response = await openRequest(
      "/v1/chat/completions",
      Response.json({
        id: "msg_search_final",
        type: "message",
        role: "assistant",
        model: "usage-native-messages",
        content: [{ type: "text", text: "Search complete" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 17,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 1,
        },
      }),
      {
        stream,
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          },
        ],
      },
    )
    const body = await response.text()
    expect(body).toContain("Search complete")
    await expectUsage(21, 2, 1)
  },
)

const upstreamUsageCases = [
  {
    name: "missing",
    usage: undefined,
    input: 0,
    output: 0,
    requests: 0,
    gaps: 0,
  },
  { name: "empty", usage: {}, input: 0, output: 0, requests: 0, gaps: 0 },
  {
    name: "output-only",
    usage: { output_tokens: 7 },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 0,
  },
  {
    name: "null-input",
    usage: { input_tokens: null, output_tokens: 7 },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 1,
  },
  {
    name: "null-output",
    usage: { input_tokens: 13, output_tokens: null },
    input: 13,
    output: 0,
    requests: 1,
    gaps: 1,
  },
  {
    name: "null-cache-read",
    usage: {
      input_tokens: 13,
      output_tokens: 7,
      cache_read_input_tokens: null,
    },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 1,
  },
  {
    name: "null-cache-create",
    usage: {
      input_tokens: 13,
      output_tokens: 7,
      cache_creation_input_tokens: null,
    },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 1,
  },
  {
    name: "string-input",
    usage: { input_tokens: "12", output_tokens: 7 },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 1,
  },
  {
    name: "negative-cache",
    usage: { input_tokens: 13, output_tokens: 7, cache_read_input_tokens: -1 },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 1,
  },
]

for (const path of [
  "/v1/messages",
  "/v1/chat/completions",
  "/v1/models/usage-native-messages",
]) {
  for (const mode of ["buffered", "start", "delta"]) {
    test.each(upstreamUsageCases)(
      `${path} ${mode} preserves $name usage accounting`,
      async ({ usage, input, output, requests, gaps }) => {
        enableDatabaseUsageForTest()
        const streaming = mode !== "buffered"
        const endpoint =
          path.includes("/models/") ?
            `${path}:${streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`
          : path
        const upstream =
          streaming ?
            new Response(
              [
                startEvent(mode === "start" ? usage : undefined),
                ...(mode === "delta" ?
                  [
                    event("message_delta", {
                      delta: { stop_reason: "end_turn" },
                      ...(usage ? { usage } : {}),
                    }),
                  ]
                : []),
                event("message_stop"),
              ].join(""),
              { headers: { "content-type": "text/event-stream" } },
            )
          : Response.json({
              id: "msg_usage_partial",
              type: "message",
              role: "assistant",
              model: "usage-native-messages",
              content: [{ type: "text", text: "done" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              ...(usage ? { usage } : {}),
            })
        const response = await openRequest(endpoint, upstream, {
          stream: streaming,
        })
        const body = await response.text()
        await expectUsage(input, output, requests)
        expect((await getUsageResponse()).collection).toMatchObject({
          unknownGaps: gaps,
        })
        if (path === "/v1/messages" && usage)
          expect(body).toContain(JSON.stringify(usage))
        if (path === "/v1/chat/completions" && !requests)
          expect(body).not.toContain('"usage":')
      },
    )
  }
}
