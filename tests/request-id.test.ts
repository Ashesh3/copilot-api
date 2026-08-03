import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

import { startLogicalRequestLog } from "../src/lib/request-logger"
import { createRoutingTelemetryRequestState } from "../src/lib/request-session"
import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let lastHeaders: Record<string, string> | undefined
let lastRoutingAffinity: RoutingAffinity | undefined
let upstreamResponseHeaders: Record<string, string>
let queuedResponses: Array<Response>

function createChatCompletionResponse(
  status = 200,
  headers: Record<string, string> = upstreamResponseHeaders,
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }),
    {
      status,
      headers,
    },
  )
}

const fetchMock = mock((_url: string, init?: RequestInit) => {
  lastHeaders = init?.headers as Record<string, string> | undefined
  lastRoutingAffinity = getRoutingAffinity()

  return queuedResponses.shift() ?? createChatCompletionResponse()
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  lastHeaders = undefined
  lastRoutingAffinity = undefined
  upstreamResponseHeaders = { "content-type": "application/json" }
  queuedResponses = []
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = undefined
  resetRoutingTelemetryForTest()
})

test("reuses an inbound request ID for both upstream and client responses", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "req-from-client",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastHeaders?.["X-Request-Id"]).toBe("req-from-client")
  expect(response.headers.get("x-request-id")).toBe("req-from-client")
})

test("generates a request ID when the client does not supply one", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
    }),
  })

  const generatedRequestId = response.headers.get("x-request-id")

  expect(response.status).toBe(200)
  expect(generatedRequestId).toBeTruthy()
  if (!generatedRequestId) {
    throw new TypeError("Expected x-request-id header to be present")
  }
  expect(lastHeaders?.["X-Request-Id"]).toBe(generatedRequestId)
})

test("exposes Copilot client session affinity in the provider path", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-session-id": "copilot-conversation",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastRoutingAffinity).toEqual({
    key: "copilot-conversation",
    source: "copilot_session",
  })
})

test("redacts routing affinity headers from debug request logs", async () => {
  const rawAffinityIds = [
    "claude-affinity-private",
    "copilot-affinity-private",
    "codex-affinity-private",
    "thread-affinity-private",
  ]
  const consoleLog = spyOn(console, "log").mockImplementation(() => undefined)
  state.debug = true
  try {
    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": rawAffinityIds[0] ?? "",
        "x-client-session-id": rawAffinityIds[1] ?? "",
        "session-id": rawAffinityIds[2] ?? "",
        "thread-id": rawAffinityIds[3] ?? "",
        "x-harmless-debug-header": "harmless-visible-value",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    })

    expect(response.status).toBe(200)
    const output = consoleLog.mock.calls.flat().join("\n")
    for (const rawAffinityId of rawAffinityIds) {
      expect(output).not.toContain(rawAffinityId)
    }
    expect(output).toContain("[REDACTED]")
    expect(output).toContain("x-harmless-debug-header")
    expect(output).toContain("harmless-visible-value")
  } finally {
    state.debug = false
    consoleLog.mockRestore()
  }
})

test("forwards upstream quota snapshot headers to the client response", async () => {
  upstreamResponseHeaders = {
    "content-type": "application/json",
    "x-quota-snapshot-chat": "remaining=42;limit=100",
  }

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("x-quota-snapshot-chat")).toBe(
    "remaining=42;limit=100",
  )
})

test("does not forward stale quota headers from a failed upstream retry attempt", async () => {
  queuedResponses.push(
    createChatCompletionResponse(503, {
      "content-type": "application/json",
      "retry-after": "0",
      "x-quota-snapshot-chat": "remaining=1;limit=100",
    }),
    createChatCompletionResponse(200, {
      "content-type": "application/json",
    }),
  )

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("x-quota-snapshot-chat")).toBeNull()
})

test("records one routed client request after HTTP model handling", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      max_tokens: 32,
      messages: [{ role: "user", content: "Hello" }],
      model: "gpt-4o",
    }),
  })

  expect(response.status).toBe(200)
  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(1)
  expect(snapshot.models[0]).toMatchObject({
    model: "gpt-4o",
    requests: 1,
  })
})

test("does not record non-model dashboard traffic", async () => {
  await server.request("/dashboard")

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(0)
})

test("does not record model requests rejected before upstream dispatch", () => {
  const telemetryState = createRoutingTelemetryRequestState("Chat Completions")
  const lifecycle = startLogicalRequestLog({
    inputLength: 10,
    method: "POST",
    model: "locally-rejected-model",
    path: "/v1/chat/completions",
    telemetryState,
    transport: "HTTP",
    turnId: "http-rejected",
  })
  lifecycle.finalize({ status: 403, terminalStatus: "REJECTED" })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(0)
  expect(snapshot.models).toEqual([])
})

test("records a logical WebSocket turn exactly once", () => {
  const telemetryState = createRoutingTelemetryRequestState(
    "Responses WebSocket",
  )
  const lifecycle = startLogicalRequestLog({
    inputLength: 10,
    method: "POST",
    model: "gpt-test",
    path: "/responses",
    telemetryState,
    transport: "Responses WebSocket",
    turnId: "turn-1",
  })
  Object.assign(telemetryState, {
    dispatched: true,
    lastDestination: "Responses",
    lastModel: "gpt-test",
    lastProvider: "GitHub Copilot",
  })

  expect(lifecycle.finalize({ status: 200, terminalStatus: "COMPLETE" })).toBe(
    true,
  )
  expect(lifecycle.finalize({ status: 500, terminalStatus: "ERROR" })).toBe(
    false,
  )

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(1)
  expect(snapshot.models[0]).toMatchObject({
    model: "gpt-test",
    requests: 1,
  })
})

test("does not record a logical turn that never reached a provider", () => {
  const telemetryState = createRoutingTelemetryRequestState(
    "Responses WebSocket",
  )
  const lifecycle = startLogicalRequestLog({
    inputLength: 10,
    method: "POST",
    model: "locally-rejected-model",
    path: "/responses",
    telemetryState,
    transport: "Responses WebSocket",
    turnId: "turn-rejected",
  })

  lifecycle.finalize({ status: 400, terminalStatus: "REJECTED" })

  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(snapshot.totals.requests).toBe(0)
})
