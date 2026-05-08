import { beforeEach, expect, test } from "bun:test"

import {
  clearLlmDebugLogs,
  finishLlmDebugLog,
  getLlmDebugLog,
  LLM_DEBUG_LOG_RETENTION_MS,
  listLlmDebugLogs,
  startLlmDebugLog,
} from "../src/lib/llm-debug-log"

beforeEach(() => {
  clearLlmDebugLogs()
})

test("stores raw request and response details in memory", () => {
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
  expect(detail?.request.headers.authorization).toBe("Bearer raw-token")
  expect(detail?.response?.body).toBe('{"ok":true}')
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
