import { afterEach, beforeEach, expect, test } from "bun:test"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { getUsageResponse, resetUsageForTest } from "~/lib/usage-tracker"
import { server } from "~/server"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

type JsonRecord = Record<string, unknown>
interface Round {
  output: Array<JsonRecord>
  usage: JsonRecord
}

const originalFetch = globalThis.fetch
const originalState = { ...state }
let script: Array<Round> = []
let upstreamCalls = 0

const searchSchema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
}
const lsSchema = { type: "object", properties: {} }

// Round 2's prompt holds round 1, so its input is the conversation's size.
const responsesRounds = (): Array<Round> => [
  {
    output: [
      {
        type: "reasoning",
        id: "rs_u1",
        summary: [],
        encrypted_content: "enc_u1",
      },
      {
        type: "function_call",
        id: "fc_u1",
        status: "completed",
        call_id: "call_ws",
        name: "WebSearch",
        arguments: '{"query":"bun 1.4"}',
      },
    ],
    usage: {
      input_tokens: 100_000,
      input_tokens_details: { cached_tokens: 90_000 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 200 },
      total_tokens: 100_300,
    },
  },
  {
    output: [
      {
        type: "message",
        id: "msg_u2",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Faster.", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 104_000,
      input_tokens_details: { cached_tokens: 100_000 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 104_050,
    },
  },
]

const messagesRounds = (): Array<Round> => [
  {
    output: [
      {
        type: "tool_use",
        id: "toolu_ws",
        name: "WebSearch",
        input: { query: "bun 1.4" },
      },
    ],
    usage: {
      input_tokens: 2_000,
      cache_read_input_tokens: 90_000,
      cache_creation_input_tokens: 8_000,
      output_tokens: 300,
    },
  },
  {
    output: [{ type: "text", text: "Faster." }],
    usage: {
      input_tokens: 1_000,
      cache_read_input_tokens: 98_000,
      cache_creation_input_tokens: 5_000,
      output_tokens: 50,
    },
  },
]

function responsesBody(round: Round): JsonRecord {
  return {
    id: `resp_u${upstreamCalls}`,
    object: "response",
    status: "completed",
    model: "gpt-droid",
    output: round.output,
    usage: round.usage,
  }
}

function responsesStream(round: Round): Array<JsonRecord> {
  const response = responsesBody(round)
  return [
    {
      type: "response.created",
      response: { id: response.id, status: "in_progress" },
    },
    ...round.output.flatMap((item, index) => [
      { type: "response.output_item.added", output_index: index, item },
      { type: "response.output_item.done", output_index: index, item },
    ]),
    { type: "response.completed", response },
  ]
}

function messagesBody(round: Round): JsonRecord {
  const tool = round.output.some((block) => block.type === "tool_use")
  return {
    id: `msg_u${upstreamCalls}`,
    type: "message",
    role: "assistant",
    model: "claude-droid",
    content: round.output,
    stop_reason: tool ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: round.usage,
  }
}

function messagesStream(round: Round): Array<JsonRecord> {
  const message = messagesBody(round)
  const { output_tokens: output, ...input } = round.usage
  return [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...input, output_tokens: 1 },
      },
    },
    ...round.output.flatMap(
      (block, index): Array<JsonRecord> => [
        {
          type: "content_block_start",
          index,
          content_block:
            block.type === "tool_use" ?
              { ...block, input: {} }
            : { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta:
            block.type === "tool_use" ?
              {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              }
            : { type: "text_delta", text: block.text },
        },
        { type: "content_block_stop", index },
      ],
    ),
    {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: output },
    },
    { type: "message_stop" },
  ]
}

function sse(values: Array<JsonRecord>): Response {
  const body = values
    .map(
      (value, index) =>
        `event: ${String(value.type)}\ndata: ${JSON.stringify(
          String(value.type).startsWith("response.") ?
            { ...value, sequence_number: index }
          : value,
        )}\n\n`,
    )
    .join("")
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

function upstream(path: string, body: JsonRecord): Response {
  if (path === "/mcp/readonly") {
    if (body.method === "initialize")
      return Response.json(
        { jsonrpc: "2.0", id: body.id, result: {} },
        { headers: { "Mcp-Session-Id": "usage-session" } },
      )
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: [{ type: "text", text: "Bun 1.4 notes" }] },
    })
  }
  upstreamCalls++
  const round = script.shift()
  if (!round) throw new Error("Unexpected upstream call")
  const messages = path === "/v1/messages"
  if (body.stream !== true)
    return Response.json(messages ? messagesBody(round) : responsesBody(round))
  return sse(messages ? messagesStream(round) : responsesStream(round))
}

beforeEach(async () => {
  script = []
  upstreamCalls = 0
  resetUsageForTest()
  resetWebSearchSessionsForTest()
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
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
        id: "gpt-droid",
        name: "GPT Droid",
        object: "model",
        version: "1",
        vendor: "openai",
        supported_endpoints: ["/responses"],
        capabilities: { ...capabilities, family: "gpt" },
      },
      {
        id: "claude-droid",
        name: "Claude Droid",
        object: "model",
        version: "1",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: { ...capabilities, family: "claude" },
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
      return Promise.resolve(upstream(target.pathname, body))
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

/** The usage Droid reads from the response, streamed or whole. */
async function droidUsage(
  path: string,
  body: JsonRecord,
): Promise<JsonRecord | undefined> {
  const response = await server.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
      "user-agent": "factory-cli/1.0.0",
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  expect(response.status).toBe(200)
  expect(upstreamCalls).toBe(2)
  if (body.stream !== true)
    return (JSON.parse(text) as { usage?: JsonRecord }).usage
  const frames = text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as JsonRecord)
  const terminal = frames.findLast(
    (frame) =>
      frame.type === "response.completed" || frame.type === "message_delta",
  )
  if (terminal?.type === "message_delta") return terminal.usage as JsonRecord
  return (terminal?.response as { usage?: JsonRecord } | undefined)?.usage
}

async function recordedTotals(): Promise<JsonRecord> {
  return (await getUsageResponse()).lifetime as JsonRecord
}

for (const stream of [true, false])
  test(`Droid's Responses context is the last round's input, ${stream ? "streamed" : "whole"}`, async () => {
    script = responsesRounds()
    const usage = await droidUsage("/v1/responses", {
      model: "gpt-droid",
      input: [{ role: "user", content: "Bun 1.4?" }],
      stream,
      tools: [
        { type: "function", name: "WebSearch", parameters: searchSchema },
        { type: "function", name: "LS", parameters: lsSchema },
      ],
    })
    expect(usage).toEqual({
      input_tokens: 104_000,
      input_tokens_details: { cached_tokens: 100_000 },
      output_tokens: 350,
      output_tokens_details: { reasoning_tokens: 220 },
      total_tokens: 104_350,
    })
    // The dashboard and request accounting keep every round's tokens.
    expect(await recordedTotals()).toMatchObject({
      total_input_tokens: 204_000,
      total_output_tokens: 350,
      total_requests: 1,
    })
  })

for (const stream of [true, false])
  test(`Droid's Messages context is the last round's input, ${stream ? "streamed" : "whole"}`, async () => {
    script = messagesRounds()
    const usage = await droidUsage("/v1/messages", {
      model: "claude-droid",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Bun 1.4?" }],
      stream,
      tools: [
        { name: "WebSearch", input_schema: searchSchema },
        { name: "LS", input_schema: lsSchema },
      ],
    })
    expect(usage).toMatchObject({
      input_tokens: 1_000,
      cache_read_input_tokens: 98_000,
      cache_creation_input_tokens: 5_000,
      output_tokens: 350,
    })
    expect(await recordedTotals()).toMatchObject({
      total_input_tokens: 204_000,
      total_output_tokens: 350,
      total_requests: 1,
    })
  })
