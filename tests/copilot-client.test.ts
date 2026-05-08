import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import { clearLlmDebugLogs, listLlmDebugLogs } from "../src/lib/llm-debug-log"
import { state } from "../src/lib/state"
import {
  copilotFetch,
  copilotHeaders,
} from "../src/services/copilot/copilot-client"

const originalFetch = globalThis.fetch
const queuedResponses: Array<Response> = []
const queuedFailures: Array<Error> = []
const capturedRequests: Array<{ url: string; init?: RequestInit }> = []

function getRequestUrl(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url
  }
  if (url instanceof URL) {
    return url.toString()
  }
  return url.url
}

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const requestUrl = getRequestUrl(url)
  capturedRequests.push({ url: requestUrl, init })

  const failure = queuedFailures.shift()
  if (failure) {
    throw failure
  }

  const next = queuedResponses.shift()
  if (!next) {
    throw new Error(`Unexpected fetch: ${requestUrl}`)
  }

  return next
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
  queuedResponses.length = 0
  queuedFailures.length = 0
  capturedRequests.length = 0
  clearLlmDebugLogs()
  state.accountType = "individual"
  state.githubToken = "github-token"
  state.copilotToken = "expired-copilot-token"
  state.isMultiToken = false
})

test("refreshes the single-token copilot token and retries the request after a 401", async () => {
  queuedResponses.push(
    new Response("Unauthorized", { status: 401 }),
    new Response(
      JSON.stringify({
        token: "fresh-copilot-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
  })

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(3)
  expect(capturedRequests[1]?.url).toContain("/copilot_internal/v2/token")
  expect(state.copilotToken).toBe("fresh-copilot-token")
  expect(capturedRequests[2]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-copilot-token",
  })
})

test("retries transient 408 and 504 upstream responses", async () => {
  for (const status of [408, 504]) {
    queuedResponses.length = 0
    capturedRequests.length = 0
    fetchMock.mockClear()

    queuedResponses.push(
      new Response("Retry me", {
        status,
        headers: { "retry-after": "0" },
      }),
      new Response("{}", { status: 200 }),
    )

    const response = await copilotFetch("/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer expired-copilot-token",
        "content-type": "application/json",
      },
    })

    expect(response.status).toBe(200)
    expect(capturedRequests).toHaveLength(2)
  }
})

test("stops after a single retry for retryable upstream responses", async () => {
  queuedResponses.push(
    new Response("Still overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
    new Response("Still overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
  })

  expect(response.status).toBe(503)
  expect(capturedRequests).toHaveLength(2)
})

test("includes a per-session X-Agent-Task-Id header", () => {
  state.sessionId = "session-guid"

  const headers = copilotHeaders()

  expect(headers["X-Agent-Task-Id"]).toBe("session-guid")
})

test("sets a descriptive User-Agent header", () => {
  const headers = copilotHeaders()

  expect(headers["User-Agent"]).toContain("copilot-api")
})

test("does not retry unknown upstream 400 responses", async () => {
  queuedResponses.push(
    new Response("feature unsupported by model", {
      status: 400,
      headers: { "retry-after": "0" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
  })

  expect(response.status).toBe(400)
  expect(capturedRequests).toHaveLength(1)
})

test("does not retry aborted upstream fetches", async () => {
  queuedFailures.push(new Error("The operation was aborted"))

  let thrownError: unknown
  try {
    await copilotFetch("/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer expired-copilot-token",
        "content-type": "application/json",
      },
    })
  } catch (error) {
    thrownError = error
  }
  expect(thrownError).toBeInstanceOf(Error)
  if (!(thrownError instanceof Error)) {
    throw new TypeError("Expected copilotFetch to throw an Error")
  }
  expect(thrownError.message).toContain("aborted")

  expect(capturedRequests).toHaveLength(1)
})

test("captures raw LLM request and response attempts for dashboard debugging", async () => {
  queuedResponses.push(
    new Response('{"choices":[]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )

  const requestBody = JSON.stringify({
    messages: [{ role: "user", content: "debug capture" }],
    model: "gpt-debug",
  })
  const response = await copilotFetch("/chat/completions", {
    body: requestBody,
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
      "X-Request-Id": "req-capture",
    },
    method: "POST",
  })
  await response.text()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const logs = listLlmDebugLogs()
  expect(logs.count).toBe(1)
  expect(logs.entries[0]?.model).toBe("gpt-debug")
  expect(logs.entries[0]?.requestId).toBe("req-capture")
  expect(logs.entries[0]?.requestPreview).toContain("debug capture")
  expect(logs.entries[0]?.responseStatus).toBe(200)
  expect(logs.entries[0]?.responsePreview).toContain("choices")
})
