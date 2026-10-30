import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { getUsageResponse, resetUsageForTest } from "~/lib/usage-tracker"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

type JsonRecord = Record<string, unknown>
type Transport = "json" | "sse" | "websocket"

const CLAUDE = "claude-usage-fixture"
const CHAT = "chat-usage-fixture"
const QUESTION = [{ type: "message", role: "user", content: "What changed?" }]
const TRANSPORTS: ReadonlyArray<Transport> = ["json", "sse", "websocket"]
// The gateway adds its own search to a turn without tools; a turn that offers
// only hosted search has the gateway run that search.
const TURNS: ReadonlyArray<[string, JsonRecord]> = [
  ["tool-less", {}],
  [
    "hosted-search-only",
    { tools: [{ type: "web_search", external_web_access: true }] },
  ],
]

// Round 2's prompt holds round 1, so its input is the conversation's size.
const MESSAGES_USAGE = [
  {
    input_tokens: 2_000,
    cache_read_input_tokens: 90_000,
    cache_creation_input_tokens: 8_000,
    output_tokens: 300,
  },
  {
    input_tokens: 1_000,
    cache_read_input_tokens: 98_000,
    cache_creation_input_tokens: 5_000,
    output_tokens: 50,
  },
]
const CHAT_USAGE = [
  {
    prompt_tokens: 100_000,
    prompt_tokens_details: { cached_tokens: 90_000 },
    completion_tokens: 300,
    total_tokens: 100_300,
  },
  {
    prompt_tokens: 104_000,
    prompt_tokens_details: { cached_tokens: 100_000 },
    completion_tokens: 50,
    total_tokens: 104_050,
  },
]
// Every round's tokens, as request accounting must record them.
const ALL_ROUNDS = {
  total_input_tokens: 204_000,
  total_output_tokens: 350,
  total_requests: 1,
}

const originalFetch = globalThis.fetch
const originalState = { ...state }
const upstream: Array<JsonRecord> = []

/** The search tool the request declares: the gateway's or hosted search's. */
function searchToolName(body: JsonRecord): string {
  const tools =
    Array.isArray(body.tools) ? (body.tools as Array<JsonRecord>) : []
  const names = tools.map((tool) =>
    String(((tool.function ?? tool) as JsonRecord).name),
  )
  const name = names.find(
    (candidate) =>
      candidate === "web_search" || candidate.startsWith("_copilot_web_"),
  )
  if (!name) throw new Error(`No search tool among ${names.join(", ")}`)
  return name
}

function messagesReply(body: JsonRecord, round: number): Response {
  const search = round === 0
  return Response.json({
    id: `msg_usage_${round}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content:
      search ?
        [
          {
            type: "tool_use",
            id: "toolu_usage",
            name: searchToolName(body),
            input: { query: "release notes" },
          },
        ]
      : [{ type: "text", text: "Version 2 shipped." }],
    stop_reason: search ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: MESSAGES_USAGE[round],
  })
}

function chatReply(body: JsonRecord, round: number): Response {
  const search = round === 0
  const call = {
    id: "call_usage",
    type: "function",
    function: {
      name: searchToolName(body),
      arguments: '{"query":"release notes"}',
    },
  }
  const chunk = (fields: JsonRecord) => ({
    id: `chat_usage_${round}`,
    object: "chat.completion.chunk",
    created: 1,
    model: body.model,
    ...fields,
  })
  const finish = search ? "tool_calls" : "stop"
  if (body.stream !== true)
    return Response.json({
      ...chunk({ object: "chat.completion" }),
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: finish,
          message:
            search ?
              { role: "assistant", content: null, tool_calls: [call] }
            : { role: "assistant", content: "Version 2 shipped." },
        },
      ],
      usage: CHAT_USAGE[round],
    })
  const delta =
    search ?
      { role: "assistant", tool_calls: [{ index: 0, ...call }] }
    : { role: "assistant", content: "Version 2 shipped." }
  const chunks = [
    chunk({ choices: [{ index: 0, delta, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }),
    chunk({ choices: [], usage: CHAT_USAGE[round] }),
  ]
  return new Response(
    `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function reply(path: string, body: JsonRecord): Response {
  if (path === "/mcp/readonly") {
    if (body.method === "initialize")
      return Response.json(
        { jsonrpc: "2.0", id: body.id, result: {} },
        { headers: { "Mcp-Session-Id": "usage-search" } },
      )
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: [{ type: "text", text: "Release notes" }] },
    })
  }
  const round = upstream.push(body) - 1
  if (round > 1) throw new Error("Unexpected upstream round")
  return path === "/v1/messages" ?
      messagesReply(body, round)
    : chatReply(body, round)
}

beforeEach(async () => {
  upstream.length = 0
  resetUsageForTest()
  resetWebSearchSessionsForTest()
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  state.accountType = "individual"
  state.apiKeyAuth = PROTOCOL_GATEWAY_KEY
  state.copilotToken = "fixture-copilot"
  state.githubToken = "fixture-github"
  state.isMultiToken = false
  state.manualApprove = false
  const capabilities = {
    object: "model_capabilities",
    supports: { tool_calls: true },
    limits: { max_output_tokens: 4096 },
    tokenizer: "o200k_base",
    type: "chat",
  }
  state.models = {
    object: "list",
    data: [
      {
        id: CLAUDE,
        name: "Claude usage fixture",
        object: "model",
        version: "1",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: { ...capabilities, family: "claude" },
      },
      {
        id: CHAT,
        name: "Chat usage fixture",
        object: "model",
        version: "1",
        vendor: "test",
        supported_endpoints: ["/chat/completions"],
        capabilities: { ...capabilities, family: "test" },
      },
    ],
  }
  await seedProtocolDatabase()
  globalThis.fetch = Object.assign(
    (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(url instanceof Request ? url.url : String(url))
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as JsonRecord
      return Promise.resolve(reply(target.pathname, body))
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

function terminalUsage(frames: Array<JsonRecord>): JsonRecord | undefined {
  expect(frames.filter((frame) => frame.type === "error")).toEqual([])
  const completed = frames.find((frame) => frame.type === "response.completed")
  return (completed?.response as { usage?: JsonRecord } | undefined)?.usage
}

async function webSocketUsage(
  body: JsonRecord,
): Promise<JsonRecord | undefined> {
  let data: ResponsesWebSocketData | undefined
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/responses", {
      headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
    }),
    {
      upgrade(_request, options) {
        data = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    },
  )
  if (!data) throw new Error("Expected upgrade")
  const frames: Array<JsonRecord> = []
  await responsesWebSocket.message(
    {
      data,
      send(frame: string) {
        frames.push(JSON.parse(frame) as JsonRecord)
      },
      close() {},
    },
    JSON.stringify({ type: "response.create", ...body }),
  )
  return terminalUsage(frames)
}

/** The usage a Responses client such as Codex reads from the turn. */
async function clientUsage(
  transport: Transport,
  body: JsonRecord,
): Promise<JsonRecord | undefined> {
  if (transport === "websocket") return await webSocketUsage(body)
  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, stream: transport === "sse" }),
  })
  const text = await response.text()
  expect(response.status).toBe(200)
  if (transport === "json")
    return (JSON.parse(text) as { usage?: JsonRecord }).usage
  return terminalUsage(
    text
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)) as JsonRecord),
  )
}

async function recordedTotals(): Promise<JsonRecord> {
  return (await getUsageResponse()).lifetime as JsonRecord
}

describe("Codex with a Claude model, over the Messages bridge", () => {
  for (const [turn, tools] of TURNS)
    for (const transport of TRANSPORTS)
      test(`a ${turn} turn reports the last round's input, ${transport}`, async () => {
        const usage = await clientUsage(transport, {
          model: CLAUDE,
          input: QUESTION,
          ...tools,
        })

        expect(upstream).toHaveLength(2)
        expect(usage).toEqual({
          input_tokens: 104_000,
          input_tokens_details: { cached_tokens: 98_000 },
          output_tokens: 350,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 104_350,
        })
        expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
      })
})

describe("Codex with a Chat-only model, over the Chat adapter", () => {
  for (const [turn, tools] of TURNS)
    for (const transport of TRANSPORTS)
      test(`a ${turn} turn reports the last round's input, ${transport}`, async () => {
        const usage = await clientUsage(transport, {
          model: CHAT,
          input: QUESTION,
          ...tools,
        })

        expect(upstream).toHaveLength(2)
        expect(usage).toEqual({
          input_tokens: 104_000,
          input_tokens_details: { cached_tokens: 100_000 },
          output_tokens: 350,
          total_tokens: 104_350,
        })
        expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
      })
})

test("a Google client keeps the final round's usage, and every round is counted", async () => {
  const response = await server.request(
    `/v1beta/models/${CHAT}:generateContent`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "What changed?" }] }],
        tools: [{ googleSearch: {} }],
      }),
    },
  )
  const body = (await response.json()) as { usageMetadata?: JsonRecord }

  expect(response.status).toBe(200)
  expect(upstream).toHaveLength(2)
  expect(body.usageMetadata).toEqual({
    promptTokenCount: 104_000,
    candidatesTokenCount: 50,
    totalTokenCount: 104_050,
    cachedContentTokenCount: 100_000,
  })
  expect(await recordedTotals()).toMatchObject(ALL_ROUNDS)
})
