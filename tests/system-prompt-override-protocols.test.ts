import { afterEach, beforeEach, expect, test } from "bun:test"

import type { SystemPromptOverride } from "~/lib/system-prompt-overrides"
import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
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

const CHAIN: Array<SystemPromptOverride> = [
  { mode: "clear", prompt: "Base OLD" },
  { mode: "append", prompt: "Top" },
  { mode: "replace", find: "OLD", replacement: "NEW" },
]
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
let rejectedModel: string | undefined
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
  rejectedModel = undefined
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
    if (call.body.model === rejectedModel) {
      return Response.json(
        { error: { message: "Model rejected request" } },
        { status: 422 },
      )
    }
    return upstreamResponse(call)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
})

function configure(
  model: string,
  rules: Array<SystemPromptOverride> = CHAIN,
): void {
  setModelSettingsForTest([{ model, systemPromptOverrides: rules }])
}

test("Chat and Google routes apply the same ordered chain", async () => {
  configure(CHAT_MODEL)
  expect(
    (
      await post("/v1/chat/completions", {
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: "Discard" },
          { role: "user", content: "Keep OLD" },
        ],
      })
    ).status,
  ).toBe(200)
  expect(upstreamTurns("/chat/completions")).toEqual([
    { role: "system", content: "Top\n\nBase NEW" },
    { role: "user", content: "Keep OLD" },
  ])
  expect(
    (
      await post(`/v1beta/models/${CHAT_MODEL}:generateContent`, {
        systemInstruction: { parts: [{ text: "Discard" }] },
        contents: [{ role: "user", parts: [{ text: "Keep OLD" }] }],
      })
    ).status,
  ).toBe(200)
  expect(upstreamTurns("/chat/completions")).toEqual([
    { role: "system", content: "Top\n\nBase NEW" },
    { role: "user", content: "Keep OLD" },
  ])
})

test.each(["/v1/messages", "/v1/messages/count_tokens"])(
  "native Messages chains apply to %s",
  async (path) => {
    configure(CLAUDE_MODEL)
    const response = await post(path, {
      model: CLAUDE_MODEL,
      max_tokens: 64,
      system: "Discard",
      messages: [{ role: "user", content: "Keep OLD" }],
    })
    expect(response.status).toBe(200)
    const sent = lastUpstream(path)
    expect(sent.system).toBe("Top\n\nBase NEW")
    expect(sent.messages).toEqual([{ role: "user", content: "Keep OLD" }])
  },
)

test.each([CHAT_MODEL, CLAUDE_MODEL, RESPONSES_MODEL])(
  "Responses chains survive translation to %s",
  async (model) => {
    configure(model)
    const response = await post("/v1/responses", {
      model,
      instructions: "Discard",
      input: [
        { role: "developer", content: "Discard developer" },
        { role: "user", content: "Keep OLD" },
      ],
      stream: false,
    })
    expect(response.status).toBe(200)
    const body = upstream.at(-1)?.body
    if (!body) throw new Error("Expected upstream request")
    const text = JSON.stringify(body)
    expect(text).toContain(String.raw`Top\n\nBase NEW`)
    expect(text).not.toContain("Discard")
    expect(text).toContain("Keep OLD")
  },
)

test.each([false, true])(
  "WebSocket chains use current rules without reapplying to stored text (input=%s)",
  async (inInput) => {
    configure(RESPONSES_MODEL, [
      { mode: "replace", find: "Client", replacement: "Client changed" },
      { mode: "append", prompt: "Top" },
    ])
    const ws = await createSocket()
    await sendTurn(ws, {
      model: RESPONSES_MODEL,
      ...(inInput ?
        {
          input: [
            { role: "system", content: "Client instructions" },
            { role: "user", content: "first" },
          ],
        }
      : { instructions: "Client instructions", input: "first" }),
    })
    await sendTurn(ws, {
      previous_response_id: completedResponseIds(ws).at(-1),
      input: "second",
    })
    configure(RESPONSES_MODEL, [
      { mode: "replace", find: "Client", replacement: "Updated" },
    ])
    await sendTurn(ws, {
      previous_response_id: completedResponseIds(ws).at(-1),
      input: "third",
    })
    setModelSettingsForTest([])
    await sendTurn(ws, {
      previous_response_id: completedResponseIds(ws).at(-1),
      input: "fourth",
    })

    const prompts = upstream
      .filter((call) => call.path.endsWith("/responses"))
      .map(({ body }) => {
        if (!inInput) return body.instructions
        const input = body.input as Array<Record<string, unknown>>
        return input.find((item) => item.role === "system")?.content
      })
    expect(prompts).toEqual([
      "Top\n\nClient changed instructions",
      "Top\n\nClient changed instructions",
      "Updated instructions",
      "Client instructions",
    ])
    expect(ws.sent.some((frame) => frame.type === "error")).toBe(false)
  },
)

test("JSON output requirements survive clearing and replacements", async () => {
  configure(RESPONSES_MODEL, [
    { mode: "clear", prompt: "" },
    { mode: "replace", find: "JSON", replacement: "BAD" },
  ])
  const response = await post("/v1/responses", {
    model: RESPONSES_MODEL,
    instructions: "Client JSON",
    input: [{ role: "user", content: "Hello" }],
    text: { format: { type: "json_object" } },
    stream: false,
  })
  expect(response.status).toBe(200)
  const body = lastUpstream("/responses")
  expect(JSON.stringify(body)).not.toContain("BAD")
  expect(JSON.stringify(body.input)).toContain("Respond with JSON.")
})

test("permission classifiers retain their policy with an override chain", async () => {
  setConfigForTest({ permissionReviewModel: CLAUDE_MODEL })
  configure(CLAUDE_MODEL)
  const system =
    "You are a security monitor for autonomous AI coding agents.\n## Classification Process\nReview the transcript.\n## Output Format\n<block>yes</block> or <block>no</block>"
  const response = await post("/v1/messages", {
    model: CLAUDE_MODEL,
    max_tokens: 64,
    system,
    messages: [{ role: "user", content: "<transcript>ls</transcript>" }],
  })
  expect(response.status).toBe(200)
  expect(lastUpstream("/v1/messages").system).toBe(system)
})

test("redirects keep the requested model's chain", async () => {
  setModelRedirectsForTest([
    {
      id: "override-redirect",
      sourceModel: CHAT_MODEL,
      sourceEffort: "all",
      targetModel: OTHER_CHAT_MODEL,
      enabled: true,
    },
  ])
  configure(CHAT_MODEL)
  const response = await post("/v1/chat/completions", {
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: "Discard" },
      { role: "user", content: "Hello" },
    ],
  })
  expect(response.status).toBe(200)
  expect(lastUpstream("/chat/completions").model).toBe(OTHER_CHAT_MODEL)
  expect(upstreamTurns("/chat/completions")[0]).toEqual({
    role: "system",
    content: "Top\n\nBase NEW",
  })
})

test("model fallback applies the source chain once per fresh attempt", async () => {
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: [
        {
          id: "override-fallback",
          sourceModel: CHAT_MODEL,
          targetModel: OTHER_CHAT_MODEL,
          enabled: true,
        },
      ],
    }),
  )
  rejectedModel = CHAT_MODEL
  configure(CHAT_MODEL, [
    { mode: "replace", find: "Client", replacement: "Client changed" },
    { mode: "append", prompt: "Top" },
  ])
  const response = await post("/v1/chat/completions", {
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: "Client instructions" },
      { role: "user", content: "Hello" },
    ],
  })
  expect(response.status).toBe(200)
  const calls = upstream.filter((call) =>
    call.path.endsWith("/chat/completions"),
  )
  expect(calls.map((call) => call.body.model)).toEqual([
    CHAT_MODEL,
    OTHER_CHAT_MODEL,
  ])
  for (const call of calls) {
    expect(
      (call.body.messages as Array<Record<string, unknown>>)[0].content,
    ).toBe("Top\n\nClient changed instructions")
  }
})

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

function completedResponseIds(
  ws: Awaited<ReturnType<typeof createSocket>>,
): Array<unknown> {
  return ws.sent
    .filter((frame) => frame.type === "response.completed")
    .map((frame) => (frame.response as { id?: unknown } | undefined)?.id)
}

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
