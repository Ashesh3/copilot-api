import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import { clearLlmDebugLogs, startLlmDebugLog } from "../src/lib/llm-debug-log"
import { state } from "../src/lib/state"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth
const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) => {
  return new Response(
    [
      'data: {"choices":[{"finish_reason":"content_filter","index":0,"delta":{"content":null}}],"id":"msg_replay","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n",
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

beforeEach(() => {
  fetchMock.mockClear()
  clearLlmDebugLogs()
  state.apiKeyAuth = undefined
  state.accountType = "individual"
  state.copilotToken = "fresh-copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("serves LLM debug logs through dashboard API", async () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ input: "dashboard lookup", model: "gpt-ui" }),
    requestHeaders: { authorization: "Bearer raw-token" },
    requestId: "req-dashboard",
    url: "https://example.test/responses",
  })

  const listResponse = await server.request("/dashboard/api/llm-debug")
  expect(listResponse.status).toBe(200)
  const listBody = (await listResponse.json()) as {
    entries: Array<{ id: string; requestPreview: string }>
  }
  expect(listBody.entries[0]?.id).toBe(id)
  expect(listBody.entries[0]?.requestPreview).toContain("dashboard lookup")

  const detailResponse = await server.request(`/dashboard/api/llm-debug/${id}`)
  expect(detailResponse.status).toBe(200)
  const detailBody = (await detailResponse.json()) as {
    request: { headers: Record<string, string> }
  }
  expect(detailBody.request.headers.authorization).toBe("Bearer raw-token")

  const clearResponse = await server.request("/dashboard/api/llm-debug", {
    method: "DELETE",
  })
  expect(clearResponse.status).toBe(200)

  const afterClearResponse = await server.request("/dashboard/api/llm-debug")
  const afterClearBody = (await afterClearResponse.json()) as { count: number }
  expect(afterClearBody.count).toBe(0)
})

test("dashboard bundle ships the LLM debug UI", () => {
  expect(DASHBOARD_HTML).toContain("LLM Debug")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/llm-debug")
  expect(DASHBOARD_HTML).toContain("Expand all")
  expect(DASHBOARD_HTML).toContain("Collapse all")
  expect(DASHBOARD_HTML).toContain("contain:layout paint")
  expect(DASHBOARD_HTML).not.toContain("Reformatted, not exact bytes")
  expect(DASHBOARD_HTML).not.toContain("Quick Add: Nebius Qwen3 Embedding")
})

test("replays a chat completions debug log with fresh auth and parses SSE metadata", async () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/chat/completions",
    requestBody: JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
      model: "claude-fable-5",
      stream: true,
    }),
    requestHeaders: { authorization: "Bearer captured-token" },
    requestId: "req-replay",
    url: "https://api.githubcopilot.com/chat/completions",
  })

  const response = await server.request(
    `/dashboard/api/llm-debug/${id}/replay`,
    {
      body: JSON.stringify({
        body: {
          messages: [{ role: "user", content: "Hello edited" }],
          model: "claude-fable-5",
          stream: true,
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    finishReason: string
    responseId: string
    streamEvents: Array<unknown>
    usage: { prompt_tokens: number }
  }
  expect(body.finishReason).toBe("content_filter")
  expect(body.responseId).toBe("msg_replay")
  expect(body.usage.prompt_tokens).toBe(10)
  expect(body.streamEvents.length).toBeGreaterThan(0)

  const upstreamInit = fetchMock.mock.calls[0]?.[1] as
    | { body?: string; headers?: Record<string, string> }
    | undefined
  expect(upstreamInit?.headers?.Authorization).toBe(
    "Bearer fresh-copilot-token",
  )
  expect(upstreamInit?.headers?.Authorization).not.toBe("Bearer captured-token")
  expect(upstreamInit?.body).toContain("Hello edited")
})

test("rejects invalid replay requests", async () => {
  const missingResponse = await server.request(
    "/dashboard/api/llm-debug/missing/replay",
    {
      body: JSON.stringify({ body: {} }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  )
  expect(missingResponse.status).toBe(404)

  const embeddingsId = startLlmDebugLog({
    method: "POST",
    path: "/embeddings",
    requestBody: JSON.stringify({ input: "hello", model: "embed" }),
    requestHeaders: {},
    url: "https://api.githubcopilot.com/embeddings",
  })
  const unsupportedResponse = await server.request(
    `/dashboard/api/llm-debug/${embeddingsId}/replay`,
    {
      body: JSON.stringify({ body: { input: "hello", model: "embed" } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  )
  expect(unsupportedResponse.status).toBe(400)

  const chatId = startLlmDebugLog({
    method: "POST",
    path: "/chat/completions",
    requestBody: JSON.stringify({ messages: [], model: "gpt" }),
    requestHeaders: {},
    url: "https://api.githubcopilot.com/chat/completions",
  })
  const invalidJsonResponse = await server.request(
    `/dashboard/api/llm-debug/${chatId}/replay`,
    {
      body: JSON.stringify({ body: "{nope" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  )
  expect(invalidJsonResponse.status).toBe(400)

  const missingModelResponse = await server.request(
    `/dashboard/api/llm-debug/${chatId}/replay`,
    {
      body: JSON.stringify({ body: { messages: [] } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  )
  expect(missingModelResponse.status).toBe(400)
})

test("dashboard bundle ships the LLM replay UI", () => {
  expect(DASHBOARD_HTML).toContain("Replay")
  expect(DASHBOARD_HTML).toContain("Back to Debug")
})
