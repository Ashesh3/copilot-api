import { beforeEach, expect, test } from "bun:test"

import {
  abortLlmDebugLog,
  clearLlmDebugLogs,
  failLlmDebugLog,
  finishLlmDebugLog,
  getLlmDebugLog,
  LLM_DEBUG_LOG_RETENTION_MS,
  listLlmDebugLogs,
  startLlmDebugLog,
} from "../src/lib/llm-debug-log"

beforeEach(() => {
  clearLlmDebugLogs()
})

test("stores request details with sensitive headers redacted", () => {
  const startedAtMs = Date.now()
  const requestBody = JSON.stringify({
    messages: [{ role: "user", content: "Find this request" }],
    model: "gpt-test",
    stream: false,
  })
  const id = startLlmDebugLog({
    method: "POST",
    path: "/chat/completions",
    requestBody,
    requestHeaders: { authorization: "Bearer raw-token" },
    requestId: "req-debug-1",
    startedAtMs,
    url: "https://example.test/chat/completions",
  })

  finishLlmDebugLog(
    id,
    {
      body: '{"ok":true}',
      headers: { "content-type": "application/json" },
      status: 200,
      statusText: "OK",
    },
    startedAtMs + 123,
  )

  const list = listLlmDebugLogs()
  expect(list.count).toBe(1)
  expect(list.entries[0]?.model).toBe("gpt-test")
  expect(list.entries[0]?.requestPreview).toContain("Find this request")
  expect(list.entries[0]?.responsePreview).toContain("ok")
  expect(list.entries[0]?.durationMs).toBe(123)

  const detail = getLlmDebugLog(id)
  expect(detail?.request.body).toBe(requestBody)
  expect(detail?.request.headers.authorization).toBe("[REDACTED]")
  expect(detail?.response?.body).toBe('{"ok":true}')
})

test("redacts credentials from stored debug URLs and structured bodies", () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({
      api_key: "body-secret",
      nested: { refresh_token: "refresh-secret" },
    }),
    requestHeaders: {
      cookie: "session=secret",
      "x-api-key": "header-secret",
    },
    url: "https://example.test/responses?api_key=query-secret&safe=value",
  })

  const detail = getLlmDebugLog(id)
  expect(detail?.request.url).not.toContain("query-secret")
  expect(detail?.request.url).toContain("safe=value")
  expect(detail?.request.body).not.toContain("body-secret")
  expect(detail?.request.body).not.toContain("refresh-secret")
  expect(detail?.request.headers.cookie).toBe("[REDACTED]")
  expect(detail?.request.headers["x-api-key"]).toBe("[REDACTED]")
})

test("prunes entries older than the retention window", () => {
  const now = Date.now()
  startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "old-model" }),
    requestHeaders: {},
    startedAtMs: now - LLM_DEBUG_LOG_RETENTION_MS - 1,
    url: "https://example.test/responses",
  })
  const freshId = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "fresh-model" }),
    requestHeaders: {},
    startedAtMs: now,
    url: "https://example.test/responses",
  })

  const list = listLlmDebugLogs()
  expect(list.count).toBe(1)
  expect(list.entries[0]?.id).toBe(freshId)
  expect(list.entries[0]?.model).toBe("fresh-model")
})

test("keeps aborted requests terminal when late response work finishes", () => {
  const startedAtMs = Date.now()
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "gpt-abort" }),
    requestHeaders: {},
    startedAtMs,
    url: "https://example.test/responses",
  })
  const abortError = new Error("client disconnected")
  abortError.name = "AbortError"

  abortLlmDebugLog(id, { error: abortError, endedAtMs: startedAtMs + 25 })
  finishLlmDebugLog(
    id,
    {
      body: '{"late":true}',
      headers: { "content-type": "application/json" },
      status: 200,
      statusText: "OK",
    },
    startedAtMs + 50,
  )
  failLlmDebugLog(id, new Error("late failure"), startedAtMs + 75)

  const detail = getLlmDebugLog(id)
  expect(detail?.status).toBe("aborted")
  expect(detail?.durationMs).toBe(25)
  expect(detail?.error?.name).toBe("AbortError")
  expect(detail?.response).toBeUndefined()
})

test("does not let an abort overwrite a completed request", () => {
  const startedAtMs = Date.now()
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "gpt-complete" }),
    requestHeaders: {},
    startedAtMs,
    url: "https://example.test/responses",
  })
  finishLlmDebugLog(
    id,
    {
      body: "{}",
      headers: {},
      status: 200,
      statusText: "OK",
    },
    startedAtMs + 10,
  )
  abortLlmDebugLog(id, {
    error: new Error("late abort"),
    endedAtMs: startedAtMs + 20,
  })

  expect(getLlmDebugLog(id)?.status).toBe("complete")
  expect(getLlmDebugLog(id)?.durationMs).toBe(10)
})
