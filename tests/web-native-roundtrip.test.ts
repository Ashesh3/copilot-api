import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"

import { isGithubOrigin } from "./helpers/github-origin"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()
const originalFetch = globalThis.fetch
const originalState = { ...state }
const model = "gpt-native-web-fixture"
const requests: Array<Record<string, unknown>> = []
const hosted = {
  type: "web_search_call",
  id: "ws_search",
  status: "completed",
  action: { type: "open_page", url: "https://example.com/" },
}
const reasoning = {
  type: "reasoning",
  id: "rs_search",
  summary: [],
  encrypted_content: "opaque-signed-reasoning",
}
// Copilot-issued reasoning state is replayed on the next turn so the model keeps
// its reasoning. The web layer preserves the original output unchanged.
const replayedReasoning = reasoning
const clientCall = {
  type: "function_call",
  id: "fc_weather",
  call_id: "call_weather",
  name: "get_weather",
  arguments: '{"city":"Kolkata"}',
  status: "completed",
}
const answer = {
  type: "message",
  id: "msg_answer",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "Example source.",
      annotations: [
        {
          type: "url_citation",
          start_index: 0,
          end_index: 14,
          url: "https://example.com/",
          title: "Example",
        },
      ],
    },
  ],
}
const tools = [
  {
    type: "function",
    name: "get_weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
]
const start = {
  model,
  input: [
    {
      type: "message",
      role: "user",
      content: "Open https://example.com/ and ask for weather.",
    },
  ],
  tools,
}
const clientOutput = {
  type: "function_call_output",
  call_id: "call_weather",
  output: "25 C",
}

function envelope(index: number) {
  return {
    id: `resp_${index}`,
    object: "response",
    model,
    created_at: 1,
    status: "completed",
    output: index === 1 ? [reasoning, hosted, clientCall] : [answer],
    usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
  }
}

function sse(index: number): Response {
  const response = envelope(index)
  const frames: Array<Record<string, unknown>> = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
  ]
  for (const [outputIndex, item] of response.output.entries()) {
    frames.push({
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    })
    if (item.type === "web_search_call")
      frames.push(
        {
          type: "response.web_search_call.in_progress",
          item_id: item.id,
          output_index: outputIndex,
        },
        {
          type: "response.web_search_call.completed",
          item_id: item.id,
          output_index: outputIndex,
        },
      )
    frames.push({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    })
  }
  frames.push({ type: "response.completed", response })
  return new Response(
    frames
      .map(
        (f, i) =>
          `event: ${String(f.type)}\ndata: ${JSON.stringify({ ...f, sequence_number: i })}\n\n`,
      )
      .join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}

beforeEach(async () => {
  requests.length = 0
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  state.apiKeyAuth = PROTOCOL_GATEWAY_KEY
  state.copilotToken = "fixture-copilot-token"
  state.githubToken = "fixture-github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: model,
        name: model,
        object: "model",
        version: "1",
        vendor: "openai",
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt",
          object: "model_capabilities",
          supports: { tool_calls: true, web_search: true },
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  await seedProtocolDatabase()
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : String(url))
    expect(isGithubOrigin(target)).toBe(true)
    expect(target.pathname).toBe("/responses")
    if (typeof init?.body !== "string") throw new Error("Expected JSON body")
    const body = JSON.parse(init.body) as Record<string, unknown>
    requests.push(body)
    expect(body.tools).toEqual([...tools, { type: "web_search" }])
    expect(JSON.stringify(body)).not.toContain("_copilot_web_search")
    expect(JSON.stringify(body)).not.toContain("web_result_")
    return Promise.resolve(
      body.stream ?
        sse(requests.length)
      : Response.json(envelope(requests.length)),
    )
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

async function http(payload: Record<string, unknown>) {
  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  const body = await response.text()
  expect(response.status).toBe(200)
  if (!payload.stream)
    return { frames: [], result: JSON.parse(body) as Record<string, unknown> }
  const frames = body
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>)
  const result = frames.find((f) => f.type === "response.completed")
    ?.response as Record<string, unknown>
  return { frames, result }
}

for (const stream of [false, true])
  test(`native HTTP ${stream ? "SSE" : "JSON"} preserves hosted search plus client call and accepts their next-turn echo`, async () => {
    const first = await http({ ...start, stream })
    expect(first.result.output).toEqual([reasoning, hosted, clientCall])
    if (stream)
      expect(
        first.frames.filter(
          (f) => f.type === "response.web_search_call.completed",
        ),
      ).toEqual([
        {
          type: "response.web_search_call.completed",
          item_id: "ws_search",
          output_index: 1,
          sequence_number: 5,
        },
      ])
    const followup = await http({
      ...start,
      stream,
      input: [...start.input, reasoning, hosted, clientCall, clientOutput],
    })
    expect(followup.result.output).toEqual([answer])
    expect(requests).toHaveLength(2)
    expect(requests[1].input).toEqual([
      ...start.input,
      replayedReasoning,
      hosted,
      clientCall,
      clientOutput,
    ])
    expect(JSON.stringify(first)).not.toContain("[Web tool")
  })

test("native WebSocket snapshots replay hosted search and pending client results without synthetic messages", async () => {
  let data: ResponsesWebSocketData | undefined
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/responses", {
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "session-id": "web-roundtrip-fixture",
      },
    }),
    {
      upgrade(_req, options) {
        data = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    },
  )
  if (!data) throw new Error("Expected authenticated upgrade")
  const sent: Array<Record<string, unknown>> = []
  const ws = {
    data,
    send(frame: string) {
      sent.push(JSON.parse(frame) as Record<string, unknown>)
    },
    close() {},
  }
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...start }),
  )
  expect(sent.filter((f) => f.type === "error")).toEqual([])
  expect(sent.find((f) => f.type === "response.completed")).toMatchObject({
    response: { output: [reasoning, hosted, clientCall] },
  })
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model,
      previous_response_id: "resp_1",
      input: [clientOutput],
    }),
  )
  expect(sent.filter((f) => f.type === "error")).toEqual([])
  expect(requests).toHaveLength(2)
  expect(requests[1].input).toEqual([
    ...start.input,
    replayedReasoning,
    hosted,
    clientCall,
    clientOutput,
  ])
  expect(sent.findLast((f) => f.type === "response.completed")).toMatchObject({
    response: { output: [answer] },
  })
  expect(JSON.stringify(sent)).not.toContain("web_result_")
  expect(JSON.stringify(sent)).not.toContain("[Web tool")
})
