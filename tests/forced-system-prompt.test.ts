import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { resolveForcedSystemPrompt } from "~/lib/forced-system-prompt"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { getCompactionPrompt } from "~/routes/responses/compact-prompt"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const FORCED = "Answer as the release engineer for this repository."
const CHAT_MODEL = "forced-chat"
const OTHER_CHAT_MODEL = "forced-chat-target"
const CLAUDE_MODEL = "claude-forced"
const RESPONSES_MODEL = "forced-responses"
const OTHER_RESPONSES_MODEL = "forced-responses-target"

interface UpstreamCall {
  path: string
  body: Record<string, unknown>
}

const upstream: Array<UpstreamCall> = []
let responseNumber = 0
const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  apiKeyAuth: state.apiKeyAuth,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  manualApprove: state.manualApprove,
  models: state.models,
}

function catalogModel(
  id: string,
  endpoints: Array<string>,
  family: string,
): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: family === "claude" ? "anthropic" : "openai",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family,
      limits: { max_output_tokens: 4096 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function responsesResult(id: string): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1,
    model: RESPONSES_MODEL,
    output: [
      {
        id: `${id}_message`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    output_text: "ok",
    status: "completed",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
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
}

function responsesStream(id: string): Response {
  const response = responsesResult(id)
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    { type: "response.completed", response },
  ]
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function upstreamResponse(call: UpstreamCall): Response {
  if (call.path.endsWith("/v1/messages/count_tokens")) {
    return Response.json({ input_tokens: 42 })
  }
  if (call.path.endsWith("/v1/messages")) {
    return Response.json({
      id: "msg_forced",
      type: "message",
      role: "assistant",
      model: CLAUDE_MODEL,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
  if (call.path.endsWith("/responses")) {
    responseNumber += 1
    const id = `resp_forced_${responseNumber}`
    return call.body.stream === true ?
        responsesStream(id)
      : Response.json(responsesResult(id))
  }
  if (call.body.stream === true) return chatStream()
  return Response.json({
    id: "chatcmpl_forced",
    object: "chat.completion",
    created: 1,
    model: CHAT_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function chatStream(): Response {
  const chunk = {
    id: "chatcmpl_forced",
    object: "chat.completion.chunk",
    created: 1,
    model: CHAT_MODEL,
  }
  const events = [
    {
      ...chunk,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "ok" },
          finish_reason: null,
        },
      ],
    },
    {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]
  return new Response(
    [...events.map((event) => JSON.stringify(event)), "[DONE]"]
      .map((data) => `data: ${data}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function requestBody(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  let text = ""
  if (typeof init?.body === "string") text = init.body
  else if (input instanceof Request) text = await input.clone().text()
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

beforeEach(() => {
  upstream.length = 0
  responseNumber = 0
  setConfigForTest(null)
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      catalogModel(CHAT_MODEL, ["/chat/completions"], "gpt"),
      catalogModel(OTHER_CHAT_MODEL, ["/chat/completions"], "gpt"),
      catalogModel(
        CLAUDE_MODEL,
        ["/v1/messages", "/chat/completions"],
        "claude",
      ),
      catalogModel(RESPONSES_MODEL, ["/responses"], "gpt"),
      catalogModel(OTHER_RESPONSES_MODEL, ["/responses"], "gpt"),
    ],
  } satisfies ModelsResponse
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input)
    const call = {
      path: new URL(url).pathname,
      body: await requestBody(input, init),
    }
    upstream.push(call)
    return upstreamResponse(call)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

function forceFor(model: string, clearOtherSystemPrompts = false): void {
  setModelSettingsForTest([
    { model, forcedSystemPrompt: FORCED, clearOtherSystemPrompts },
  ])
}

async function post(path: string, body: unknown): Promise<Response> {
  await seedProtocolDatabase()
  return server.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function lastUpstream(path: string): Record<string, unknown> {
  const call = upstream.findLast((entry) => entry.path.endsWith(path))
  if (!call) throw new Error(`Expected an upstream ${path} request`)
  return call.body
}

function upstreamMessages(path: string): Array<Record<string, unknown>> {
  return lastUpstream(path).messages as Array<Record<string, unknown>>
}

/** Roles and text only; the gateway adds its own prompt-cache markers. */
function upstreamTurns(
  path: string,
): Array<{ role: unknown; content: unknown }> {
  return upstreamMessages(path).map(({ role, content }) => ({ role, content }))
}

test("matches the requested model through reasoning suffixes and normalized versions", () => {
  setModelSettingsForTest([
    {
      model: "claude-opus-4.6",
      forcedSystemPrompt: FORCED,
      clearOtherSystemPrompts: true,
    },
  ])

  expect(resolveForcedSystemPrompt("claude-opus-4-6:high")).toEqual({
    model: "claude-opus-4.6",
    prompt: FORCED,
    clearOtherSystemPrompts: true,
  })
  expect(resolveForcedSystemPrompt("claude-opus-4.7")).toBeUndefined()
})

test("Chat Completions sends the forced prompt before the client's system prompts", async () => {
  forceFor(CHAT_MODEL)

  const response = await post("/v1/chat/completions", {
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: "Client system." },
      { role: "user", content: "Hello" },
    ],
  })

  expect(response.status).toBe(200)
  expect(upstreamTurns("/chat/completions")).toEqual([
    { role: "system", content: FORCED },
    { role: "system", content: "Client system." },
    { role: "user", content: "Hello" },
  ])
})

test("Chat Completions keeps only the forced prompt when clearing", async () => {
  forceFor(CHAT_MODEL, true)

  const response = await post("/v1/chat/completions", {
    model: `${CHAT_MODEL}:high`,
    messages: [
      { role: "system", content: "Client system." },
      { role: "developer", content: "Client developer." },
      { role: "user", content: "Hello" },
    ],
  })

  expect(response.status).toBe(200)
  expect(upstreamTurns("/chat/completions")).toEqual([
    { role: "system", content: FORCED },
    { role: "user", content: "Hello" },
  ])
})

test("the requested model's prompt applies when a redirect sends the request elsewhere", async () => {
  setModelRedirectsForTest([
    {
      id: "forced-redirect",
      sourceModel: CHAT_MODEL,
      sourceEffort: "all",
      targetModel: OTHER_CHAT_MODEL,
      enabled: true,
    },
  ])
  setModelSettingsForTest([
    { model: CHAT_MODEL, forcedSystemPrompt: FORCED },
    { model: OTHER_CHAT_MODEL, forcedSystemPrompt: "Target model prompt." },
  ])

  const response = await post("/v1/chat/completions", {
    model: CHAT_MODEL,
    messages: [{ role: "user", content: "Hello" }],
  })

  expect(response.status).toBe(200)
  expect(lastUpstream("/chat/completions").model).toBe(OTHER_CHAT_MODEL)
  expect(upstreamTurns("/chat/completions")).toEqual([
    { role: "system", content: FORCED },
    { role: "user", content: "Hello" },
  ])
})

test("Messages puts the forced prompt first in system for native Claude requests", async () => {
  forceFor(CLAUDE_MODEL)

  const response = await post("/v1/messages", {
    model: CLAUDE_MODEL,
    max_tokens: 64,
    system: "Client system.",
    messages: [{ role: "user", content: "Hello" }],
  })

  expect(response.status).toBe(200)
  const system = lastUpstream("/v1/messages").system as Array<
    Record<string, unknown>
  >
  expect(system.map((block) => block.text)).toEqual([FORCED, "Client system."])
})

test("Messages clearing removes client system prompts, including for token counts", async () => {
  forceFor(CLAUDE_MODEL, true)
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 64,
    system: [{ type: "text", text: "Client system." }],
    messages: [
      { role: "user", content: "Hello" },
      { role: "system", content: "Mid-conversation system." },
      { role: "user", content: "Continue" },
    ],
  }

  const response = await post("/v1/messages", body)
  const count = await post("/v1/messages/count_tokens", body)

  expect(response.status).toBe(200)
  expect(count.status).toBe(200)
  for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
    const sent = lastUpstream(path)
    expect(sent.system).toBe(FORCED)
    expect(JSON.stringify(sent.messages)).not.toContain("Mid-conversation")
    expect(JSON.stringify(sent.messages)).toContain("Continue")
  }
})

test("Messages translated to Chat keeps the forced prompt at the top", async () => {
  forceFor(CHAT_MODEL)

  const response = await post("/v1/messages", {
    model: CHAT_MODEL,
    max_tokens: 64,
    system: "Client system.",
    messages: [{ role: "user", content: "Hello" }],
  })

  expect(response.status).toBe(200)
  const [first, ...rest] = upstreamMessages("/chat/completions")
  expect(first.role).toBe("system")
  expect(String(first.content)).toStartWith(FORCED)
  expect(JSON.stringify([first, ...rest])).toContain("Client system.")
})

test("Claude permission reviews keep their classifier prompt", async () => {
  setConfigForTest({ permissionReviewModel: CLAUDE_MODEL })
  forceFor(CLAUDE_MODEL, true)
  const policy = [
    "You are a security monitor for autonomous AI coding agents.",
    "## Classification Process",
    "Review the transcript.",
    "## Output Format",
    "<block>yes</block> or <block>no</block>",
  ].join("\n")

  const response = await post("/v1/messages", {
    model: CLAUDE_MODEL,
    max_tokens: 64,
    system: policy,
    messages: [{ role: "user", content: "<transcript>ls</transcript>" }],
  })

  expect(response.status).toBe(200)
  const system = JSON.stringify(lastUpstream("/v1/messages").system)
  expect(system).toContain("You are a security monitor")
  expect(system).not.toContain(FORCED)
})

test("Responses puts the forced prompt at the start of instructions", async () => {
  forceFor(RESPONSES_MODEL)

  const response = await post("/v1/responses", {
    model: RESPONSES_MODEL,
    instructions: "Client instructions.",
    input: [
      { type: "message", role: "developer", content: "Client developer." },
      { type: "message", role: "user", content: "Hello" },
    ],
    stream: false,
  })

  expect(response.status).toBe(200)
  const sent = lastUpstream("/responses")
  expect(sent.instructions).toBe(`${FORCED}\n\nClient instructions.`)
  expect(JSON.stringify(sent.input)).toContain("Client developer.")
})

test("Responses clearing replaces instructions and drops system and developer input", async () => {
  forceFor(RESPONSES_MODEL, true)

  const response = await post("/v1/responses", {
    model: RESPONSES_MODEL,
    instructions: "Client instructions.",
    input: [
      { role: "system", content: "Client system." },
      { type: "message", role: "developer", content: "Client developer." },
      { type: "message", role: "user", content: "Hello" },
    ],
    stream: false,
  })

  expect(response.status).toBe(200)
  const sent = lastUpstream("/responses")
  expect(sent.instructions).toBe(FORCED)
  expect(JSON.stringify(sent.input)).not.toContain("Client system.")
  expect(JSON.stringify(sent.input)).not.toContain("Client developer.")
  expect(JSON.stringify(sent.input)).toContain("Hello")
})

test("Responses translated to Chat sends the forced prompt first", async () => {
  forceFor(CHAT_MODEL)

  const response = await post("/v1/responses", {
    model: CHAT_MODEL,
    instructions: "Client instructions.",
    input: "Hello",
    stream: false,
  })

  expect(response.status).toBe(200)
  expect(upstreamTurns("/chat/completions")[0]).toEqual({
    role: "system",
    content: `${FORCED}\n\nClient instructions.`,
  })
})

test("clearing keeps the gateway's JSON instruction for json_object output", async () => {
  forceFor(RESPONSES_MODEL, true)
  const body = {
    model: RESPONSES_MODEL,
    instructions: "Reply in JSON.",
    text: { format: { type: "json_object" } },
    input: [
      { type: "message", role: "developer", content: "Use JSON keys." },
      { type: "message", role: "user", content: "Extract entities." },
    ],
  }

  const response = await post("/v1/responses", { ...body, stream: false })
  const ws = await createSocket()
  await sendTurn(ws, body)

  expect(response.status).toBe(200)
  const sent = upstream.filter((call) => call.path.endsWith("/responses"))
  expect(sent).toHaveLength(2)
  for (const call of sent) {
    expect(call.body.instructions).toBe(FORCED)
    const input = JSON.stringify(call.body.input)
    expect(input).not.toContain("Use JSON keys.")
    expect(input).toContain("Respond with JSON.")
  }
  expect(ws.sent.some((frame) => frame.type === "error")).toBe(false)
})

test("compaction puts the forced prompt before the summary instructions", async () => {
  forceFor(RESPONSES_MODEL, true)

  const response = await post("/v1/responses/compact", {
    model: RESPONSES_MODEL,
    instructions: "Client instructions.",
    input: [
      { type: "message", role: "developer", content: "Client developer." },
      { type: "message", role: "user", content: "Hello" },
      { type: "message", role: "assistant", content: "Hi" },
    ],
  })

  expect(response.status).toBe(200)
  const sent = lastUpstream("/responses")
  expect(sent.instructions).toBe(`${FORCED}\n\n${getCompactionPrompt()}`)
  expect(JSON.stringify(sent.input)).not.toContain("Client developer.")
  expect(JSON.stringify(sent.input)).toContain("Hello")
})

test("Gemini requests get the forced prompt before their system instruction", async () => {
  forceFor(CHAT_MODEL)

  const response = await post(`/v1beta/models/${CHAT_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: "Client system." }] },
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  })

  expect(response.status).toBe(200)
  const [first, ...rest] = upstreamTurns("/chat/completions")
  expect(first).toEqual({ role: "system", content: FORCED })
  expect(JSON.stringify(rest)).toContain("Client system.")
})

test("WebSocket continuations use the current prompt of the requested model", async () => {
  setModelRedirectsForTest([
    {
      id: "forced-ws-redirect",
      sourceModel: RESPONSES_MODEL,
      sourceEffort: "all",
      targetModel: OTHER_RESPONSES_MODEL,
      enabled: true,
    },
  ])
  const targetSetting = {
    model: OTHER_RESPONSES_MODEL,
    forcedSystemPrompt: "Target model prompt.",
  }
  setModelSettingsForTest([
    { model: RESPONSES_MODEL, forcedSystemPrompt: FORCED },
    targetSetting,
  ])
  const ws = await createSocket()

  await sendTurn(ws, {
    model: RESPONSES_MODEL,
    instructions: "Client instructions.",
    input: "first",
  })
  // Later turns omit the model and instructions, so both come from the
  // stored turn, which holds the routed target model.
  setModelSettingsForTest([
    { model: RESPONSES_MODEL, forcedSystemPrompt: "Updated prompt." },
    targetSetting,
  ])
  await sendTurn(ws, {
    previous_response_id: completedResponseIds(ws).at(-1),
    input: "second",
  })
  setModelSettingsForTest([targetSetting])
  await sendTurn(ws, {
    previous_response_id: completedResponseIds(ws).at(-1),
    input: "third",
  })

  const turns = upstream.filter((call) => call.path.endsWith("/responses"))
  expect(turns.map((call) => call.body.model)).toEqual([
    OTHER_RESPONSES_MODEL,
    OTHER_RESPONSES_MODEL,
    OTHER_RESPONSES_MODEL,
  ])
  expect(turns.map((call) => call.body.instructions)).toEqual([
    `${FORCED}\n\nClient instructions.`,
    "Updated prompt.\n\nClient instructions.",
    "Client instructions.",
  ])
  expect(ws.sent.some((frame) => frame.type === "error")).toBe(false)
})

function completedResponseIds(
  ws: Awaited<ReturnType<typeof createSocket>>,
): Array<unknown> {
  return ws.sent
    .filter((frame) => frame.type === "response.completed")
    .map((frame) => (frame.response as { id?: unknown } | undefined)?.id)
}

test("WebSocket turns translated to Chat send only the forced prompt when clearing", async () => {
  forceFor(CHAT_MODEL, true)
  const ws = await createSocket()

  await sendTurn(ws, {
    model: CHAT_MODEL,
    instructions: "Client instructions.",
    input: [
      { type: "message", role: "developer", content: "Client developer." },
      { type: "message", role: "user", content: "Hello" },
    ],
  })

  const [first, ...rest] = upstreamTurns("/chat/completions")
  expect(first).toEqual({ role: "system", content: FORCED })
  expect(JSON.stringify(rest)).not.toContain("Client")
  expect(JSON.stringify(rest)).toContain("Hello")
  expect(ws.sent.some((frame) => frame.type === "error")).toBe(false)
})

async function createSocket() {
  let data: ResponsesWebSocketData | undefined
  await seedProtocolDatabase().then(() =>
    tryUpgradeResponsesWebSocket(
      new Request("http://localhost/responses", {
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "session-id": crypto.randomUUID(),
        },
      }),
      {
        upgrade(_request, options) {
          data = (options as { data: ResponsesWebSocketData }).data
          return true
        },
      },
    ),
  )
  if (!data) throw new Error("Expected authenticated WebSocket upgrade")
  const sent: Array<Record<string, unknown>> = []
  return {
    data,
    sent,
    send(frame: string) {
      sent.push(JSON.parse(frame) as Record<string, unknown>)
    },
    close() {},
  }
}

async function sendTurn(
  ws: Awaited<ReturnType<typeof createSocket>>,
  payload: Record<string, unknown>,
) {
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...payload }),
  )
}
