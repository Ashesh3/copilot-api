import { afterEach, beforeEach, expect, test } from "bun:test"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { server } from "~/server"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"
import {
  decodeDroidWebCarrier,
  DROID_WEB_CARRIER_LABEL,
  DROID_WEB_CARRIER_PREFIX,
} from "~/services/web/droid-web-protocol"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

type JsonRecord = Record<string, unknown>
const originalFetch = globalThis.fetch
const originalState = { ...state }
const inference: Array<JsonRecord> = []
const searches: Array<string> = []
const pageReads: Array<JsonRecord> = []
let script: Array<Array<JsonRecord>> = []

const droidHeaders = {
  authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
  "content-type": "application/json",
  "user-agent": "factory-cli/1.0.0",
}
const searchSchema = {
  type: "object",
  properties: { query: { type: "string" }, numResults: { type: "integer" } },
  required: ["query"],
  additionalProperties: false,
}
const fetchSchema = {
  type: "object",
  properties: { url: { type: "string", format: "uri" } },
  required: ["url"],
  additionalProperties: false,
}
const lsSchema = { type: "object", properties: {} }

function sse(values: Array<JsonRecord>): Response {
  const body = values
    .map(
      (value, index) =>
        `event: ${String(value.type)}\ndata: ${JSON.stringify(
          "response" in value || String(value.type).startsWith("response.") ?
            { ...value, sequence_number: index }
          : value,
        )}\n\n`,
    )
    .join("")
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

function responsesEvents(output: Array<JsonRecord>): Array<JsonRecord> {
  const id = `resp_${inference.length}`
  return [
    { type: "response.created", response: { id, status: "in_progress" } },
    ...output.flatMap((item, index) => [
      { type: "response.output_item.added", output_index: index, item },
      { type: "response.output_item.done", output_index: index, item },
    ]),
    {
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        model: "gpt-droid",
        output,
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
    },
  ]
}

function messagesEvents(blocks: Array<JsonRecord>): Array<JsonRecord> {
  const tool = blocks.some((block) => block.type === "tool_use")
  return [
    {
      type: "message_start",
      message: {
        id: `msg_up_${inference.length}`,
        type: "message",
        role: "assistant",
        model: "claude-droid",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    ...blocks.flatMap((block, index): Array<JsonRecord> => {
      if (block.type === "tool_use")
        return [
          {
            type: "content_block_start",
            index,
            content_block: { ...block, input: {} },
          },
          {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          },
          { type: "content_block_stop", index },
        ]
      return [
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
        { type: "content_block_stop", index },
      ]
    }),
    {
      type: "message_delta",
      delta: {
        stop_reason: tool ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ]
}

function pageRead(body: JsonRecord): Response {
  pageReads.push(body)
  const url = /https:\/\/\S+/u.exec(String(body.input))?.[0] ?? ""
  return Response.json({
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url },
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              status: "ok",
              content: "# Bun 1.4\nFaster.",
            }),
          },
        ],
      },
    ],
  })
}

function mcp(body: JsonRecord): Response {
  if (body.method === "initialize")
    return Response.json(
      { jsonrpc: "2.0", id: body.id, result: {} },
      { headers: { "Mcp-Session-Id": "droid-session" } },
    )
  const params = body.params as { arguments: { query: string } }
  searches.push(params.arguments.query)
  return Response.json({
    jsonrpc: "2.0",
    id: body.id,
    result: {
      content: [
        {
          type: "text",
          text: "Bun 1.4 is out [Bun blog](https://bun.sh/blog)",
        },
      ],
    },
  })
}

beforeEach(async () => {
  inference.length = 0
  searches.length = 0
  pageReads.length = 0
  script = []
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
      if (target.pathname === "/mcp/readonly") return Promise.resolve(mcp(body))
      if (body.tool_choice === "required")
        return Promise.resolve(pageRead(body))
      inference.push(body)
      const next = script.shift() ?? []
      return Promise.resolve(
        sse(
          target.pathname === "/v1/messages" ?
            messagesEvents(next)
          : responsesEvents(next),
        ),
      )
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

async function post(
  path: string,
  body: JsonRecord,
): Promise<Array<JsonRecord>> {
  const response = await server.request(path, {
    method: "POST",
    headers: droidHeaders,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  expect(response.status).toBe(200)
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as JsonRecord)
}

const reasoning = {
  type: "reasoning",
  id: "rs_droid_1",
  summary: [],
  encrypted_content: "enc_droid_1",
}
const answer = {
  type: "message",
  id: "msg_droid_answer",
  status: "completed",
  role: "assistant",
  content: [
    { type: "output_text", text: "Bun 1.4 is faster.", annotations: [] },
  ],
}

test("Droid's Responses WebSearch and FetchUrl run on GitHub and replay intact", async () => {
  script = [
    [
      reasoning,
      {
        type: "function_call",
        id: "fc_droid_1",
        status: "completed",
        call_id: "call_ws",
        name: "WebSearch",
        arguments: '{"query":"bun 1.4"}',
      },
      {
        type: "function_call",
        id: "fc_droid_2",
        status: "completed",
        call_id: "call_fetch",
        name: "FetchUrl",
        arguments: '{"url":"https://bun.sh/blog/bun-v1.4"}',
      },
    ],
    [answer],
  ]
  const user = { role: "user", content: [{ type: "input_text", text: "Bun?" }] }
  const frames = await post("/v1/responses", {
    model: "gpt-droid",
    input: [user],
    store: false,
    stream: true,
    prompt_cache_key: "droid-session",
    tools: [
      {
        type: "function",
        name: "WebSearch",
        parameters: searchSchema,
        strict: false,
      },
      {
        type: "function",
        name: "FetchUrl",
        parameters: fetchSchema,
        strict: false,
      },
      { type: "function", name: "LS", parameters: lsSchema, strict: false },
    ],
  })
  expect(searches).toEqual(["bun 1.4"])
  expect(pageReads).toHaveLength(1)
  expect(String(pageReads[0].input)).toContain("https://bun.sh/blog/bun-v1.4")
  expect(inference).toHaveLength(2)
  // Droid renders no hosted search items, so none is added for it.
  expect(JSON.stringify(inference[0].tools)).not.toContain('"web_search"')
  const outputs = (inference[1].input as Array<JsonRecord>).filter(
    (item) => item.type === "function_call_output",
  )
  expect(outputs.map((item) => String(item.output).split("\n")[0])).toEqual([
    'Web Search Results for: "bun 1.4"',
    'URL Content from: "https://bun.sh/blog/bun-v1.4"',
  ])

  expect(frames.filter((frame) => frame.type === "error")).toEqual([])
  const completed = frames.find((frame) => frame.type === "response.completed")
  const output = (completed?.response as JsonRecord).output as Array<JsonRecord>
  expect(output.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
    "reasoning",
    "message",
  ])
  const narration = (output[1].content as Array<JsonRecord>)[0].text
  expect(narration).toMatch(
    /^Searching the web \(copilot-api\): "bun 1\.4" → sources: bun\.sh\n\nReading https:\/\/bun\.sh\/blog\/bun-v1\.4 \(copilot-api\) → read \d+ characters$/u,
  )
  expect(decodeDroidWebCarrier(output[2].encrypted_content)?.calls).toEqual([
    { id: "call_ws", name: "WebSearch", input: '{"query":"bun 1.4"}' },
    {
      id: "call_fetch",
      name: "FetchUrl",
      input: '{"url":"https://bun.sh/blog/bun-v1.4"}',
    },
  ])

  // Droid's next turn replays the output; the model sees its real history.
  script = [[answer]]
  await post("/v1/responses", {
    model: "gpt-droid",
    input: [user, ...output, { role: "user", content: "Thanks" }],
    store: false,
    stream: true,
    tools: [{ type: "function", name: "LS", parameters: lsSchema }],
  })
  const replayed = inference[2].input as Array<JsonRecord>
  expect(replayed.map((item) => item.type ?? item.role)).toEqual([
    "user",
    "reasoning",
    "function_call",
    "function_call",
    "function_call_output",
    "function_call_output",
    "message",
    "user",
  ])
  expect(JSON.stringify(replayed)).not.toContain(DROID_WEB_CARRIER_PREFIX)
  expect(JSON.stringify(replayed)).not.toContain("(copilot-api)")
  expect(replayed[4]).toEqual(outputs[0])
})

test("Droid's Messages WebSearch runs on GitHub and replays intact", async () => {
  script = [
    [
      { type: "text", text: "Searching." },
      {
        type: "tool_use",
        id: "toolu_ws",
        name: "WebSearch",
        input: { query: "bun 1.4" },
      },
    ],
    [{ type: "text", text: "Bun 1.4 is faster." }],
  ]
  const tools = [
    { name: "WebSearch", input_schema: searchSchema },
    { name: "LS", input_schema: lsSchema },
  ]
  const frames = await post("/v1/messages", {
    model: "claude-droid",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "Bun?" }],
    tools,
  })
  expect(searches).toEqual(["bun 1.4"])
  expect(inference).toHaveLength(2)
  const blocks = new Map<number, JsonRecord>()
  for (const frame of frames) {
    const index = Number(frame.index)
    if (frame.type === "content_block_start")
      blocks.set(index, { ...(frame.content_block as JsonRecord) })
    const delta = frame.delta as JsonRecord | undefined
    const block = blocks.get(index)
    if (frame.type !== "content_block_delta" || !delta || !block) continue
    for (const field of ["text", "thinking", "signature"]) {
      const piece = delta[field]
      const previous = block[field]
      if (typeof piece === "string")
        block[field] = (typeof previous === "string" ? previous : "") + piece
    }
  }
  const content = [...blocks.values()]
  expect(content.map((block) => block.type)).toEqual([
    "text",
    "text",
    "thinking",
    "text",
  ])
  expect(content[1].text).toBe(
    'Searching the web (copilot-api): "bun 1.4" → sources: bun.sh',
  )
  expect(content[2].thinking).toBe(DROID_WEB_CARRIER_LABEL)

  script = [[{ type: "text", text: "You're welcome." }]]
  await post("/v1/messages", {
    model: "claude-droid",
    max_tokens: 1024,
    stream: true,
    messages: [
      { role: "user", content: "Bun?" },
      { role: "assistant", content },
      { role: "user", content: "Thanks" },
    ],
    tools,
  })
  const replayed = inference[2].messages as Array<JsonRecord>
  expect(replayed.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ])
  expect(replayed[1].content).toEqual([
    { type: "text", text: "Searching." },
    {
      type: "tool_use",
      id: "toolu_ws",
      name: "WebSearch",
      input: { query: "bun 1.4" },
    },
  ])
  expect(JSON.stringify(replayed[2])).toContain(
    String.raw`Web Search Results for: \"bun 1.4\"`,
  )
  expect(JSON.stringify(replayed)).not.toContain(DROID_WEB_CARRIER_PREFIX)
})

test("other clients' WebSearch functions stay theirs", async () => {
  script = [
    [
      {
        type: "function_call",
        id: "fc_other",
        status: "completed",
        call_id: "call_other",
        name: "WebSearch",
        arguments: '{"query":"bun"}',
      },
    ],
  ]
  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: { ...droidHeaders, "user-agent": "other-agent/1.0" },
    body: JSON.stringify({
      model: "gpt-droid",
      input: "Bun?",
      stream: true,
      tools: [
        { type: "function", name: "WebSearch", parameters: searchSchema },
      ],
    }),
  })
  const text = await response.text()
  expect(response.status).toBe(200)
  expect(searches).toEqual([])
  expect(inference).toHaveLength(1)
  expect(text).toContain('"call_id":"call_other"')
})
