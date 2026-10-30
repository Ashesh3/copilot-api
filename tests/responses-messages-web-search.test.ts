import "./helpers/auth-misc-data-dir"
import { afterAll, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import { state } from "~/lib/state"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"

import { mergeTurns } from "./helpers/messages-turns"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

type Item = Record<string, unknown>
type Reply = (toolNames: Array<string>) => Item

useProtocolDatabase()
const MODEL = "claude-bridge-fixture"
const EVIDENCE = "EVIDENCE [Source](https://example.test/)"
// Conversations store this state, so its tag is a wire contract.
const ENVELOPE_PREFIX = "capi_anthropic_web_search_v1:"
const QUESTION = { type: "message", role: "user", content: "What changed?" }
const FINAL_CONTENT = [
  { type: "thinking", thinking: "Summarize.", signature: "sig-final" },
  { type: "text", text: "Version 2 shipped." },
]
const originalFetch = globalThis.fetch
const upstream: Array<Item> = []
let replies: Array<Reply> = []
let searches = 0

function searchRound(name: string): Item {
  return {
    content: [
      { type: "thinking", thinking: "Plan the search.", signature: "sig-1" },
      { type: "text", text: "Let me look that up." },
      { type: "tool_use", id: "toolu_search", name, input: { query: "v2" } },
    ],
    stop_reason: "tool_use",
  }
}

function mcpReply(body: Item): Response {
  if (body.method === "initialize")
    return Response.json(
      { jsonrpc: "2.0", id: body.id, result: {} },
      { headers: { "Mcp-Session-Id": "bridge-search" } },
    )
  searches++
  return Response.json({
    jsonrpc: "2.0",
    id: body.id,
    result: { content: [{ type: "text", text: EVIDENCE }] },
  })
}

function fixtureFetch(url: string | URL | Request, init?: RequestInit) {
  const target = new URL(url instanceof Request ? url.url : String(url))
  const body = JSON.parse(
    typeof init?.body === "string" ? init.body : "{}",
  ) as Item
  if (target.pathname === "/mcp/readonly")
    return Promise.resolve(mcpReply(body))
  upstream.push(body)
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Item>) : []
  const reply = replies.shift()?.(tools.map((tool) => String(tool.name))) ?? {
    content: FINAL_CONTENT,
    stop_reason: "end_turn",
  }
  return Promise.resolve(
    Response.json({
      id: `msg_${upstream.length}`,
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 3 },
      ...reply,
    }),
  )
}

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(async () => {
  upstream.length = 0
  replies = [(names) => searchRound(names[0] ?? "")]
  searches = 0
  resetWebSearchSessionsForTest()
  globalThis.fetch = Object.assign(fixtureFetch, {
    preconnect: originalFetch.preconnect,
  })
  state.accountType = "individual"
  state.apiKeyAuth = PROTOCOL_GATEWAY_KEY
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: MODEL,
        name: MODEL,
        object: "model",
        version: "1",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 1024 },
          object: "model_capabilities",
          supports: { tool_calls: true },
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  await seedProtocolDatabase()
})

async function post(route: string, body: Item): Promise<string> {
  const response = await server.request(route, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return await response.text()
}

function sseFrames(text: string): Array<Item> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as Item)
}

async function turn(body: Item): Promise<{
  frames: Array<Item>
  output: Array<Item>
  result: Item
}> {
  const text = await post("/v1/responses", body)
  const frames = body.stream ? sseFrames(text) : []
  const result =
    body.stream ?
      (frames.find((frame) => frame.type === "response.completed")
        ?.response as Item)
    : (JSON.parse(text) as Item)
  return { frames, output: result.output as Array<Item>, result }
}

function messageText(item: Item): unknown {
  return (item.content as Array<Item>)[0]?.text
}

test.each([false, true])(
  "a bridged turn shows every gateway-managed search round, stream=%j",
  async (stream) => {
    const { frames, output, result } = await turn({
      model: MODEL,
      input: [QUESTION],
      stream,
    })

    expect(upstream).toHaveLength(2)
    expect(searches).toBe(1)
    expect(output.map((item) => item.type)).toEqual([
      "reasoning",
      "message",
      "web_search_call",
      "reasoning",
      "message",
    ])
    expect(
      output
        .filter((item) => item.type === "message")
        .map((item) => [item.phase, messageText(item)]),
    ).toEqual([
      ["commentary", "Let me look that up."],
      ["final_answer", "Version 2 shipped."],
    ])
    expect(output[2]).toMatchObject({
      id: "ws_toolu_search",
      status: "completed",
      action: { type: "search", query: "v2" },
    })
    expect(String(output[2].encrypted_content)).toStartWith(ENVELOPE_PREFIX)
    // Search results stay private tool history, never visible output.
    expect(JSON.stringify(result)).not.toContain("EVIDENCE")
    expect(result.output_text).toBe(
      "Let me look that up.\n\nVersion 2 shipped.",
    )
    if (!stream) return
    const lifecycle = frames.filter(
      (frame) =>
        (frame.item as Item | undefined)?.type === "web_search_call"
        || String(frame.type).startsWith("response.web_search_call"),
    )
    expect(lifecycle.map((frame) => frame.type)).toEqual([
      "response.output_item.added",
      "response.output_item.done",
    ])
    expect(lifecycle[0].item).not.toHaveProperty("encrypted_content")
    expect(lifecycle[1].item).toEqual(output[2])
  },
)

test("the next turn replays the search history Claude answered after", async () => {
  const first = await turn({ model: MODEL, input: [QUESTION] })
  const continuation = mergeTurns(upstream[1].messages)
  upstream.length = 0

  await turn({
    model: MODEL,
    input: [
      QUESTION,
      ...first.output,
      { type: "message", role: "user", content: "Thanks" },
    ],
  })

  expect(continuation).toHaveLength(3)
  expect(mergeTurns(upstream[0].messages)).toEqual([
    ...continuation,
    { role: "assistant", content: FINAL_CONTENT },
    { role: "user", content: [{ type: "text", text: "Thanks" }] },
  ])
  // The tool-less turn still declares the replayed tool, owned by the gateway.
  expect((upstream[0].tools as Array<Item>).map((tool) => tool.name)).toEqual([
    "_copilot_web_search",
  ])
})

test("hosted web_search from Codex is run by the gateway", async () => {
  const { output } = await turn({
    model: MODEL,
    input: [QUESTION],
    tools: [{ type: "web_search", external_web_access: true }],
  })

  expect(upstream).toHaveLength(2)
  expect(searches).toBe(1)
  expect(output.some((item) => item.type === "function_call")).toBe(false)
  expect(output.find((item) => item.type === "web_search_call")).toMatchObject({
    id: "ws_toolu_search",
    action: { type: "search", query: "v2" },
  })
})

test("native Messages clients still receive only the final round", async () => {
  const text = await post("/v1/messages", {
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: "What changed?" }],
  })
  const body = JSON.parse(text) as Item

  expect(upstream).toHaveLength(2)
  expect(searches).toBe(1)
  expect(body.content).toEqual(FINAL_CONTENT)
  expect(body.usage).toMatchObject({ input_tokens: 4, output_tokens: 6 })
})

async function openSocket() {
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
  const sent: Array<Item> = []
  const socket = {
    data,
    send(frame: string) {
      sent.push(JSON.parse(frame) as Item)
    },
    close() {},
  }
  return { sent, socket }
}

test("a WebSocket continuation replays the managed search rounds", async () => {
  const { sent, socket } = await openSocket()
  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: MODEL,
      input: [QUESTION],
    }),
  )
  const first = sent.find((frame) => frame.type === "response.completed")
    ?.response as Item
  expect(
    (first.output as Array<Item>).find(
      (item) => item.type === "web_search_call",
    ),
  ).toBeDefined()
  const continuation = mergeTurns(upstream[1].messages)
  upstream.length = 0

  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: MODEL,
      previous_response_id: first.id,
      input: [{ type: "message", role: "user", content: "Thanks" }],
    }),
  )

  expect(sent.filter((frame) => frame.type === "error")).toEqual([])
  expect(mergeTurns(upstream[0].messages).slice(0, 3)).toEqual(continuation)
})
