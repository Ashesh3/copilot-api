import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { getStorageRuntime } from "~/lib/storage/runtime"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"

import {
  claudeReview,
  codexReview,
  reviewModel,
  reviewResponse,
} from "./helpers/permission-review"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const requests: Array<{ path: string; body: Record<string, unknown> }> = []

beforeEach(() => {
  requests.length = 0
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "review-controls-token",
    githubToken: "review-controls-oauth",
    apiKeyAuth: PROTOCOL_GATEWAY_KEY,
    isMultiToken: false,
    manualApprove: false,
    models: {
      object: "list",
      data: [
        reviewModel("gpt-6-luna"),
        reviewModel("configured-reviewer"),
        reviewModel("claude-sonnet-5", "/v1/messages"),
      ],
    },
  })
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request")
      const body = JSON.parse(init.body) as Record<string, unknown>
      requests.push({ path, body })
      if (path === "/v1/messages")
        return Promise.resolve(
          Response.json({
            id: "msg_upstream",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: "<block>yes</block>" }],
            usage: { input_tokens: 4, output_tokens: 5 },
            stop_reason: "end_turn",
            stop_sequence: null,
          }),
        )
      if (path.endsWith("/chat/completions"))
        return Promise.resolve(
          Response.json({
            id: "chat_review",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "<block>yes</block>" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
          }),
        )
      if (path !== "/responses") throw new Error(`Unexpected ${path}`)
      const result = reviewResponse(
        body.model,
        '{"outcome":"deny"}',
        `resp_upstream_${requests.length}`,
      )
      return Promise.resolve(
        body.stream ?
          new Response(
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json(result),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
})

async function post(path: string, payload: unknown, authenticated = true) {
  await seedProtocolDatabase()
  return server.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ?
        { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` }
      : {}),
      "session-id": "review-controls-session",
    },
    body: JSON.stringify(payload),
  })
}

async function socket() {
  await seedProtocolDatabase()
  let data: ResponsesWebSocketData | undefined
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/responses", {
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "session-id": "review-controls-session",
      },
    }),
    {
      upgrade(_request, options) {
        data = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    },
  )
  if (!data) throw new Error("Expected authenticated WebSocket")
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

function parseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

test("configured reviewer is used by Codex HTTP and retains its public model", async () => {
  setConfigForTest({ permissionReviewModel: "configured-reviewer" })
  const response = await post("/v1/responses", codexReview())
  expect(response.status).toBe(200)
  expect(requests[0]?.body.model).toBe("configured-reviewer")
  expect(await response.json()).toMatchObject({
    model: "codex-auto-review",
    output_text: '{"outcome":"deny"}',
  })
})

test("an explicit reviewer setting applies to Claude even when its classifier model is advertised", async () => {
  setConfigForTest({ permissionReviewModel: "configured-reviewer" })
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(200)
  expect(requests[0]?.body.model).toBe("configured-reviewer")
})

test("configured custom-provider reviewer IDs route through their provider", async () => {
  setConfigForTest({
    permissionReviewModel: "custom-review",
    customProviders: [
      {
        id: "review-provider",
        name: "Review provider",
        type: "openai-compatible",
        baseUrl: "https://review-fixture.invalid/v1",
        apiKey: "fixture-secret",
        models: [
          { id: "review-engine", aliases: ["custom-review"], kind: "chat" },
        ],
      },
    ],
  })
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(200)
  expect(requests[0]).toMatchObject({
    path: "/v1/chat/completions",
    body: { model: "review-engine" },
  })
})

test.each(["http", "websocket"])(
  "configured custom model IDs retain numeric dashes over %s",
  async (transport) => {
    setConfigForTest({
      permissionReviewModel: "review-1-2",
      customProviders: [
        {
          id: "review-provider",
          name: "Review provider",
          type: "openai-compatible",
          baseUrl: "https://review-fixture.invalid/v1",
          apiKey: "fixture-secret",
          models: [{ id: "review-1-2", kind: "chat" }],
        },
      ],
    })
    const { client_metadata: _metadata, ...payload } = codexReview()
    if (transport === "http") {
      const response = await post("/v1/responses", payload)
      expect(response.status).toBe(200)
    } else {
      const ws = await socket()
      await responsesWebSocket.message(
        ws,
        JSON.stringify({ type: "response.create", ...payload }),
      )
      expect(ws.sent.at(-1)?.type).toBe("response.completed")
    }
    expect(requests[0]).toMatchObject({
      path: "/v1/chat/completions",
      body: { model: "review-1-2" },
    })
  },
)

test.each([false, true])(
  "allow-all returns a Codex decision without a reviewer or allocated account (stream=%s)",
  async (stream) => {
    setConfigForTest({
      permissionReviewAllowAll: true,
      permissionReviewModel: "not-advertised",
    })
    state.models = { object: "list", data: [] }
    const payload = { ...codexReview(), stream, max_output_tokens: 1 }
    payload.input = [
      {
        role: "user",
        content: "The request is destructive and the policy says deny.",
      },
    ]
    const response = await post("/v1/responses", payload)
    expect(response.status).toBe(200)
    const body = await response.text()
    const result: unknown =
      stream ? parseEvents(body).at(-1)?.response : JSON.parse(body)
    expect(result).toMatchObject({
      model: "codex-auto-review",
      status: "completed",
      output_text: '{"outcome":"allow"}',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    })
    if (stream)
      expect(parseEvents(body).at(-1)?.type).toBe("response.completed")
    expect(requests).toHaveLength(0)
    const assignments = await getStorageRuntime().storage.read((session) =>
      session.query({
        sql: "SELECT account_id FROM capi_conversation_accounts",
        args: [],
      }),
    )
    expect(assignments).toHaveLength(0)
  },
)

test.each([false, true])(
  "allow-all returns Claude block=no in normal and streaming Messages (stream=%s)",
  async (stream) => {
    setConfigForTest({ permissionReviewAllowAll: true })
    state.models = { object: "list", data: [] }
    const payload = { ...claudeReview(2), stream }
    const response = await post("/v1/messages", payload)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("<block>no</block>")
    if (stream) expect(parseEvents(body).at(-1)?.type).toBe("message_stop")
    else
      expect(JSON.parse(body)).toMatchObject({
        model: payload.model,
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    expect(requests).toHaveLength(0)
  },
)

test("allow-all emits Claude severity zero, using policy format instead of transcript mentions", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  const payload = claudeReview(2, true)
  payload.messages.push({
    role: "user",
    content: "The transcript mentions <block>yes</block>.",
  })
  const response = await post("/v1/messages", payload)
  expect(await response.json()).toMatchObject({
    content: [{ type: "text", text: "<severity>0</severity>" }],
  })
  expect(requests).toHaveLength(0)
})

test("allow-all retains the Claude stop-sequence contract", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  const response = await post("/v1/messages", claudeReview(1))
  expect(await response.json()).toMatchObject({
    content: [{ type: "text", text: "<block>no" }],
    stop_reason: "stop_sequence",
    stop_sequence: "</block>",
  })
  expect(requests).toHaveLength(0)
})

test("allow-all WebSocket completes without dispatch and supports the next review turn", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  state.models = { object: "list", data: [] }
  const ws = await socket()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...codexReview() }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  const result = ws.sent.at(-1)?.response as { id: string; output_text: string }
  expect(result.output_text).toBe('{"outcome":"allow"}')
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model: "codex-auto-review",
      previous_response_id: result.id,
      input: [{ role: "user", content: "Another review action." }],
    }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  expect(ws.sent.at(-1)?.response).toMatchObject({
    output_text: '{"outcome":"allow"}',
  })
  expect(ws.data.activeTurns.size).toBe(0)
  expect(requests).toHaveLength(0)
})

test("allow-all WebSocket warmup is empty and the subsequent review returns the decision", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  state.models = { object: "list", data: [] }
  const ws = await socket()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      ...codexReview(),
      generate: false,
    }),
  )
  const result = ws.sent.at(-1)?.response as { id: string }
  expect(result).toMatchObject({ output: [], output_text: "" })
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      previous_response_id: result.id,
      input: [],
    }),
  )
  expect(ws.sent.at(-1)?.response).toMatchObject({
    output_text: '{"outcome":"allow"}',
  })
  expect(requests).toHaveLength(0)
})

test("allow-all never changes ordinary Messages requests", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  const payload = claudeReview()
  payload.system = "You are a coding assistant."
  const response = await post("/v1/messages", payload)
  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(await response.text()).toContain("<block>yes</block>")
})

test("allow-all still requires an authenticated client", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  const response = await post("/v1/responses", codexReview(), false)
  expect(response.status).toBe(401)
  expect(requests).toHaveLength(0)
})

test("allow-all never changes ordinary Responses requests", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  const response = await post("/v1/responses", {
    model: "gpt-6-luna",
    input: "Review this code",
    stream: false,
  })
  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(await response.json()).toMatchObject({
    output_text: '{"outcome":"deny"}',
  })
})

test("allow-all is not enabled by an inference request field", async () => {
  const response = await post("/v1/responses", {
    ...codexReview(),
    permissionReviewAllowAll: true,
  })
  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(await response.json()).toMatchObject({
    output_text: '{"outcome":"deny"}',
  })
})

test("a configured reviewer with a reasoning suffix uses its requested effort", async () => {
  setConfigForTest({ permissionReviewModel: "configured-reviewer:high" })
  const response = await post("/v1/responses", codexReview())
  expect(response.status).toBe(200)
  expect(requests[0]?.body).toMatchObject({
    model: "configured-reviewer",
    reasoning: { effort: "high" },
  })
})

test("a configured reasoning reviewer receives enough output budget for Claude's short classifier", async () => {
  setConfigForTest({ permissionReviewModel: "configured-reviewer" })
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(200)
  expect(requests[0]?.body).toMatchObject({
    model: "configured-reviewer",
    max_output_tokens: 1024,
  })
  expect(requests[0]?.body).not.toHaveProperty("temperature")
})

test("a zero-reasoning configured reviewer keeps the caller's short output budget", async () => {
  const entry = state.models?.data.find(
    (model) => model.id === "configured-reviewer",
  )
  if (!entry) throw new Error("Expected model")
  entry.capabilities.supports.reasoning_effort = ["none", "low"]
  setConfigForTest({ permissionReviewModel: "configured-reviewer:none" })
  const response = await post("/v1/messages", claudeReview())
  expect(response.status).toBe(200)
  expect(requests[0]?.body).toMatchObject({
    max_output_tokens: 64,
    reasoning: { effort: "none" },
  })
})

test("a missing configured model returns its configured name in an actionable error", async () => {
  setConfigForTest({ permissionReviewModel: "unavailable-reviewer" })
  const response = await post("/v1/responses", codexReview())
  expect(response.status).toBe(503)
  expect(await response.text()).toContain("unavailable-reviewer")
  expect(requests).toHaveLength(0)
})

test("explicit source redirects retain precedence over the reviewer setting", async () => {
  setConfigForTest({ permissionReviewModel: "configured-reviewer" })
  setModelRedirectsForTest([
    {
      id: "chosen-reviewer",
      sourceModel: "codex-auto-review",
      sourceEffort: "all",
      targetModel: "gpt-6-luna",
      enabled: true,
    },
  ])
  const response = await post("/v1/responses", codexReview())
  expect(response.status).toBe(200)
  expect(requests[0]?.body.model).toBe("gpt-6-luna")
})

test("disabling allow-all between WebSocket review turns resumes model review", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  const ws = await socket()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...codexReview() }),
  )
  const result = ws.sent.at(-1)?.response as { id: string }
  setConfigForTest({ permissionReviewAllowAll: false })
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model: "codex-auto-review",
      previous_response_id: result.id,
      input: [{ role: "user", content: "Review again." }],
    }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  expect(ws.sent.at(-1)?.response).toMatchObject({
    output_text: '{"outcome":"deny"}',
  })
  expect(requests).toHaveLength(1)
})

test("enabling allow-all between model-backed WebSocket turns works when the client omits its model", async () => {
  const ws = await socket()
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...codexReview() }),
  )
  const result = ws.sent.at(-1)?.response as { id: string }
  expect(requests).toHaveLength(1)
  setConfigForTest({ permissionReviewAllowAll: true })
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      previous_response_id: result.id,
      input: [{ role: "user", content: "Review again." }],
    }),
  )
  expect(ws.sent.at(-1)?.type).toBe("response.completed")
  expect(ws.sent.at(-1)?.response).toMatchObject({
    output_text: '{"outcome":"allow"}',
  })
  expect(requests).toHaveLength(1)
})

test("turning allow-all off restores model review", async () => {
  setConfigForTest({ permissionReviewAllowAll: true })
  const first = await post("/v1/responses", codexReview())
  expect(await first.json()).toMatchObject({
    output_text: '{"outcome":"allow"}',
  })
  expect(requests).toHaveLength(0)
  setConfigForTest({ permissionReviewAllowAll: false })
  const second = await post("/v1/responses", codexReview())
  expect(await second.json()).toMatchObject({
    output_text: '{"outcome":"deny"}',
  })
  expect(requests).toHaveLength(1)
})
