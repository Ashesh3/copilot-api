import { afterEach, beforeEach, expect, jest, test } from "bun:test"

import {
  abortLlmDebugLog,
  clearLlmDebugLogs,
  failLlmDebugLog,
  finishLlmDebugLog,
  getLlmDebugLog,
  LLM_DEBUG_HISTORY_WINDOW_MS,
  listLlmDebugLogs,
  startLlmDebugLog,
} from "../src/lib/llm-debug-log"

beforeEach(() => {
  clearLlmDebugLogs()
})

afterEach(() => {
  clearLlmDebugLogs()
  jest.useRealTimers()
})

test("stores exact request and completed response details", () => {
  const startedAtMs = Date.now()
  const requestBody = `{"messages": [ {"role": "user", "content": "Find this request"} ], "api_key": "body-secret", "model": "gpt-test", "stream": false}`
  const responseBody = `{ "access_token": "response-secret", "ok": true }`
  const requestHeaders = {
    authorization: "Bearer raw-token",
    cookie: "session=secret",
    "x-api-key": "header-secret",
  }
  const responseHeaders = {
    "content-type": "application/json",
    "set-cookie": "upstream=secret",
  }
  const url =
    "https://url-user:url-password@example.test/chat/completions?api_key=query-secret"
  const id = startLlmDebugLog({
    method: "POST",
    path: "/chat/completions",
    requestBody,
    requestHeaders,
    requestId: "req-debug-1",
    startedAtMs,
    url,
  })

  finishLlmDebugLog(
    id,
    {
      body: responseBody,
      headers: responseHeaders,
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
  expect(detail?.request).toMatchObject({
    body: requestBody,
    bodyBytes: new TextEncoder().encode(requestBody).byteLength,
    headers: requestHeaders,
    url,
  })
  expect(detail?.response).toMatchObject({
    body: responseBody,
    bodyBytes: new TextEncoder().encode(responseBody).byteLength,
    headers: responseHeaders,
  })
})

test("classifies non-success upstream responses as errors", () => {
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "gpt-test" }),
    requestHeaders: {},
    url: "https://example.test/responses",
  })

  finishLlmDebugLog(id, {
    body: JSON.stringify({
      error: { code: "invalid_request_body", message: "Invalid request" },
    }),
    headers: { "content-type": "application/json" },
    status: 400,
    statusText: "Bad Request",
  })

  expect(getLlmDebugLog(id)?.status).toBe("error")
  expect(listLlmDebugLogs().entries[0]?.status).toBe("error")
})

test("stores exact session headers and nested structured request body", () => {
  const rawIds = [
    "root-session-private",
    "root-thread-private",
    "conversation-private",
    "prompt-cache-private",
    "safety-private",
    "client-session-private",
    "client-thread-private",
    "claude-session-private",
  ]
  const requestBody = JSON.stringify({
    session_id: rawIds[0],
    thread_id: rawIds[1],
    conversation_id: rawIds[2],
    prompt_cache_key: rawIds[3],
    safety_identifier: rawIds[4],
    client_metadata: JSON.stringify({
      session_id: rawIds[5],
      thread_id: rawIds[6],
    }),
    metadata: {
      user_id: JSON.stringify({ session_id: rawIds[7] }),
    },
    model: "gpt-test",
  })
  const requestHeaders = {
    "X-Agent-Task-Id": "derived-agent-task-id",
    "X-Client-Session-Id": "derived-client-session-id",
    "X-Interaction-Id": "derived-interaction-id",
  }
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody,
    requestHeaders,
    url: "https://example.test/responses",
  })

  const detail = getLlmDebugLog(id)
  expect(detail?.request.body).toBe(requestBody)
  expect(detail?.request.headers).toEqual(requestHeaders)
})

test("stores non-JSON request bodies unchanged", () => {
  const requestBody = "api_key=body-secret & keep = exact spacing"
  const id = startLlmDebugLog({
    method: "POST",
    path: "/embeddings",
    requestBody,
    requestHeaders: {},
    url: "https://example.test/embeddings",
  })

  expect(getLlmDebugLog(id)?.request.body).toBe(requestBody)
})

test("stores exact aborted response details and runtime error path", () => {
  const startedAtMs = Date.now()
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: "{}",
    requestHeaders: {},
    startedAtMs,
    url: "https://example.test/responses",
  })
  const errorPath =
    "https://error-user:error-password@example.test/responses?token=error-secret"
  const error = Object.assign(new Error("client disconnected"), {
    code: "ECONNABORTED",
    path: errorPath,
  })
  const responseBody = `{ "refresh_token": "response-secret" }`
  const responseHeaders = {
    "content-type": "application/json",
    "set-cookie": "upstream=secret",
  }

  abortLlmDebugLog(id, {
    endedAtMs: startedAtMs + 25,
    error,
    response: {
      body: responseBody,
      headers: responseHeaders,
      status: 499,
      statusText: "Client Closed Request",
    },
  })

  const detail = getLlmDebugLog(id)
  expect(detail?.error?.path).toBe(errorPath)
  expect(detail?.response).toMatchObject({
    body: responseBody,
    bodyBytes: new TextEncoder().encode(responseBody).byteLength,
    headers: responseHeaders,
  })
})

test("returns defensive clones of raw entries", () => {
  const requestBody = `{ "api_key": "request-secret" }`
  const responseBody = `{ "access_token": "response-secret" }`
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody,
    requestHeaders: { authorization: "Bearer raw-token" },
    url: "https://example.test/responses?token=query-secret",
  })
  finishLlmDebugLog(id, {
    body: responseBody,
    headers: { "set-cookie": "upstream=secret" },
    status: 200,
    statusText: "OK",
  })

  const firstRead = getLlmDebugLog(id)
  if (!firstRead?.response) throw new Error("Expected a completed debug entry")
  firstRead.request.body = "mutated"
  firstRead.request.headers.authorization = "mutated"
  firstRead.response.body = "mutated"
  firstRead.response.headers["set-cookie"] = "mutated"

  const secondRead = getLlmDebugLog(id)
  expect(secondRead?.request.body).toBe(requestBody)
  expect(secondRead?.request.headers.authorization).toBe("Bearer raw-token")
  expect(secondRead?.response?.body).toBe(responseBody)
  expect(secondRead?.response?.headers["set-cookie"]).toBe("upstream=secret")
})

test("prunes entries older than the retention window", () => {
  const now = Date.now()
  startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "old-model" }),
    requestHeaders: {},
    startedAtMs: now - LLM_DEBUG_HISTORY_WINDOW_MS - 1,
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

test("retains complete previews inside the retention window", () => {
  const longPrompt = "x".repeat(400)
  const id = startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "fresh-model", input: longPrompt }),
    requestHeaders: {},
    url: "https://example.test/responses",
  })

  const entry = listLlmDebugLogs().entries.find((item) => item.id === id)
  expect(entry?.requestPreview).toContain(longPrompt)
})

test("evicts expired entries while idle and releases the backing store", () => {
  jest.useFakeTimers()
  const startedAtMs = Date.now()
  startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: JSON.stringify({ model: "idle-model", input: "retained" }),
    requestHeaders: {},
    startedAtMs,
    url: "https://example.test/responses",
  })

  jest.advanceTimersByTime(LLM_DEBUG_HISTORY_WINDOW_MS)
  jest.setSystemTime(startedAtMs)

  // Moving the clock back proves the timer removed the entry; a read-time
  // prune alone would keep it at this timestamp.
  expect(listLlmDebugLogs().count).toBe(0)
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
