import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { getCompactionTriggerPrompt } from "~/routes/responses/compact-prompt"
import {
  type ResponsesWebSocketData,
  responsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

type JsonRecord = Record<string, unknown>

interface UpstreamRequest {
  body: JsonRecord
  path: string
}

const SUMMARY = [
  "## Current Task",
  "- Fix Codex remote compaction for translated models",
  "## Key Context",
  "- Branch: codex/remote-compaction-v2-bridge",
].join("\n")

const originalFetch = globalThis.fetch
const originalState = { ...state }
let upstreamRequests: Array<UpstreamRequest> = []
let upstreamResponse: (path: string) => Response

beforeEach(() => {
  state.accountType = "individual"
  state.copilotToken = "remote-compaction-token"
  state.githubToken = "remote-compaction-github-token"
  state.isMultiToken = false
  state.manualApprove = false
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  upstreamRequests = []
  upstreamResponse = () => {
    throw new TypeError("Unexpected upstream request")
  }
  globalThis.fetch = ((url, init) => {
    const rawUrl = url instanceof Request ? url.url : String(url)
    const path = new URL(rawUrl).pathname
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected a JSON upstream body")
    }
    upstreamRequests.push({ path, body: JSON.parse(init.body) as JsonRecord })
    return Promise.resolve(upstreamResponse(path))
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
})

describe("Codex remote compaction over translated Messages", () => {
  test("summarizes without tools and returns exactly one compaction item over HTTP SSE", async () => {
    installModel(["/v1/messages"])
    upstreamResponse = () => anthropicSummary()

    const response = await postResponses(codexCompactionRequest())

    expect(response.status).toBe(200)
    expect(readSummaryItem(await readSseEvents(response))).toBe(SUMMARY)
    const upstream = onlyUpstreamRequest("/v1/messages")
    expect(upstream.body.system).toContain("You are Codex.")
    expect(upstream.body.tools).toEqual([
      expect.objectContaining({ name: "exec_command" }),
    ])
    expect(upstream.body.tool_choice).toEqual({ type: "none" })
    expect(JSON.stringify(upstream.body)).not.toContain(
      "[Future Responses item]",
    )
    expect(lastUserText(upstream.body)).toBe(getCompactionTriggerPrompt())
  })

  test("rejects a tool-call turn instead of returning zero compaction items", async () => {
    installModel(["/v1/messages"])
    upstreamResponse = () => anthropicToolUseTurn()

    const response = await postResponses(codexCompactionRequest())

    expect(response.status).toBe(502)
    const body = await response.text()
    expect(body).toContain("compaction_summary_failed")
    expect(body).toContain("tool_use")
    expect(body).not.toContain('"type":"compaction"')
  })

  test("returns exactly one compaction item over a WebSocket turn", async () => {
    installModel(["/v1/messages"])
    upstreamResponse = () => anthropicSummary()

    const events = await sendWebSocketTurn(codexCompactionRequest())

    expect(readSummaryItem(events)).toBe(SUMMARY)
    expect(onlyUpstreamRequest("/v1/messages").body.tool_choice).toEqual({
      type: "none",
    })
  })

  test("restores the returned summary on the next Messages turn", async () => {
    installModel(["/v1/messages"])
    upstreamResponse = () => anthropicSummary("Continuing.")

    const response = await postResponses({
      model: "compaction-model",
      input: [
        {
          type: "compaction",
          encrypted_content: Buffer.from(SUMMARY).toString("base64"),
        },
        { type: "message", role: "user", content: "Continue the fix." },
      ],
    })

    expect(response.status).toBe(200)
    const messages = onlyUpstreamRequest("/v1/messages").body
      .messages as Array<JsonRecord>
    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: `[Previous conversation summary]\n${SUMMARY}` },
      ],
    })
  })

  test("leaves Codex local compaction turns as ordinary messages", async () => {
    installModel(["/v1/messages"])
    upstreamResponse = () => anthropicSummary()
    const request = codexCompactionRequest({ stream: false })
    request.input = (request.input as Array<JsonRecord>).filter(
      (item) => item.type !== "compaction_trigger",
    )

    const response = await postResponses(request)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { output: Array<JsonRecord> }
    expect(body.output.map((item) => item.type)).toEqual([
      "reasoning",
      "message",
    ])
    expect(onlyUpstreamRequest("/v1/messages").body.tool_choice).toEqual({
      type: "auto",
    })
  })
})

describe("Codex remote compaction over translated Chat Completions", () => {
  test("buffers the summary and returns one compaction item over HTTP SSE", async () => {
    installModel(["/chat/completions"])
    upstreamResponse = () => chatSummary()

    const response = await postResponses(codexCompactionRequest())

    expect(response.status).toBe(200)
    expect(readSummaryItem(await readSseEvents(response))).toBe(SUMMARY)
    const upstream = onlyUpstreamRequest("/chat/completions")
    expect(upstream.body.stream).toBe(false)
    expect(upstream.body).not.toHaveProperty("stream_options")
    expect(upstream.body.tool_choice).toBe("none")
    expect(lastUserText(upstream.body)).toBe(getCompactionTriggerPrompt())
  })

  test("returns one compaction item over a WebSocket turn", async () => {
    installModel(["/chat/completions"])
    upstreamResponse = () => chatSummary()

    const events = await sendWebSocketTurn(codexCompactionRequest())

    expect(readSummaryItem(events)).toBe(SUMMARY)
    const upstream = onlyUpstreamRequest("/chat/completions")
    expect(upstream.body.stream).toBe(false)
    expect(upstream.body).not.toHaveProperty("stream_options")
    expect(upstream.body.tool_choice).toBe("none")
  })
})

test("forwards the compaction trigger unchanged to native Responses", async () => {
  installModel(["/responses"], "openai")
  upstreamResponse = () =>
    Response.json({
      id: "resp_native_compaction",
      object: "response",
      created_at: 1,
      model: "compaction-model",
      status: "completed",
      output: [
        { id: "cmp_native", type: "compaction", encrypted_content: "opaque" },
      ],
      output_text: "",
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })

  const response = await postResponses(
    codexCompactionRequest({ stream: false }),
  )

  expect(response.status).toBe(200)
  const upstream = onlyUpstreamRequest("/responses")
  expect((upstream.body.input as Array<JsonRecord>).at(-1)).toEqual({
    type: "compaction_trigger",
  })
  expect(upstream.body.tool_choice).toBe("auto")
  const body = (await response.json()) as { output: Array<JsonRecord> }
  expect(body.output).toEqual([
    { id: "cmp_native", type: "compaction", encrypted_content: "opaque" },
  ])
})

function codexCompactionRequest(extra: JsonRecord = {}): JsonRecord {
  return {
    model: "compaction-model",
    instructions: "You are Codex.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix remote compaction." }],
      },
      {
        type: "function_call",
        call_id: "call_status",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "git status" }),
      },
      {
        type: "function_call_output",
        call_id: "call_status",
        output: "nothing to commit",
      },
      { type: "compaction_trigger" },
    ],
    tools: [
      {
        type: "function",
        name: "exec_command",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "high" },
    store: false,
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }),
    },
    ...extra,
  }
}

function installModel(
  endpoints: Array<string>,
  vendor: "anthropic" | "openai" = "anthropic",
): void {
  state.models = {
    object: "list",
    data: [
      {
        id: "compaction-model",
        name: "Compaction Model",
        object: "model",
        preview: false,
        vendor,
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: endpoints,
        capabilities: {
          family: vendor === "anthropic" ? "claude" : "gpt",
          limits: { max_output_tokens: 4096 },
          object: "model_capabilities",
          supports: { reasoning_effort: ["low", "medium", "high"] },
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  } satisfies ModelsResponse
}

function anthropicSummary(text = SUMMARY): Response {
  return Response.json({
    id: "msg_compaction_summary",
    type: "message",
    role: "assistant",
    model: "compaction-model",
    content: [
      { type: "thinking", thinking: "Summarizing.", signature: "sig" },
      { type: "text", text },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30 },
  })
}

/** The production failure: two thinking blocks and two tool calls. */
function anthropicToolUseTurn(): Response {
  return Response.json({
    id: "msg_compaction_tool_use",
    type: "message",
    role: "assistant",
    model: "compaction-model",
    content: [
      { type: "thinking", thinking: "", signature: "sig-a" },
      { type: "thinking", thinking: "", signature: "sig-b" },
      {
        type: "tool_use",
        id: "toolu_status",
        name: "exec_command",
        input: { cmd: "git status" },
      },
      {
        type: "tool_use",
        id: "toolu_log",
        name: "exec_command",
        input: { cmd: "git log -1" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30 },
  })
}

function chatSummary(): Response {
  return Response.json({
    id: "chatcmpl_compaction_summary",
    object: "chat.completion",
    created: 1,
    model: "compaction-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: SUMMARY },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  })
}

async function postResponses(body: JsonRecord): Promise<Response> {
  await seedProtocolDatabase()
  return await server.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

async function sendWebSocketTurn(body: JsonRecord): Promise<Array<JsonRecord>> {
  const sent: Array<string> = []
  const ws = {
    data: {
      activeTurns: new Map(),
      closed: false,
      nextTurnSequence: 0,
      type: "responses",
      requestId: "req-remote-compaction",
      affinity: { key: "session-remote-compaction", source: "claude_session" },
      nativeMessagesOptions: {},
      effectiveNativeMessagesOptions: {},
      responseSnapshots: new Map(),
    } satisfies ResponsesWebSocketData,
    send(data: string): void {
      sent.push(data)
    },
    close(): void {},
  }
  await seedProtocolDatabase()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...body }),
  )
  return sent.map((frame) => JSON.parse(frame) as JsonRecord)
}

async function readSseEvents(response: Response): Promise<Array<JsonRecord>> {
  const events: Array<JsonRecord> = []
  for (const line of (await response.text()).split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice("data: ".length)
    if (data === "[DONE]") continue
    events.push(JSON.parse(data) as JsonRecord)
  }
  return events
}

/** Apply the Codex v2 contract: one compaction item, then completion. */
function readSummaryItem(events: Array<JsonRecord>): string {
  const done = events
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => event.item as JsonRecord)
  expect(done).toHaveLength(1)
  const [item] = done
  expect(item.type).toBe("compaction")
  expect(String(item.id)).toStartWith("cmp_")
  const completed = events.find((event) => event.type === "response.completed")
  expect(
    (completed?.response as { output?: unknown } | undefined)?.output,
  ).toEqual([item])
  return Buffer.from(String(item.encrypted_content), "base64").toString("utf8")
}

function onlyUpstreamRequest(path: string): UpstreamRequest {
  expect(upstreamRequests.map((request) => request.path)).toEqual([path])
  return upstreamRequests[0]
}

function lastUserText(body: JsonRecord): string | undefined {
  const messages = body.messages as Array<JsonRecord>
  const last = messages.at(-1)
  expect(last?.role).toBe("user")
  const content = last?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const textBlock = (content as Array<JsonRecord>).findLast(
    (block) => block.type === "text",
  )
  return typeof textBlock?.text === "string" ? textBlock.text : undefined
}
