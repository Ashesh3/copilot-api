import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let lastHeaders: Record<string, string> | undefined
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
  upstreamResponseHeaders = { "content-type": "application/json" }
  queuedResponses = []
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = undefined
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
  expect(lastHeaders?.["X-Request-Id"]).toBe(generatedRequestId)
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
