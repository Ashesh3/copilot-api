import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import {
  clearLlmDebugLogs,
  getLlmDebugLog,
  listLlmDebugLogs,
} from "../src/lib/llm-debug-log"
import { runWithRoutingAffinity } from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import {
  copilotFetch,
  copilotHeaders,
  setHttpRetrySleepForTest,
} from "../src/services/copilot/copilot-client"
import {
  createRetryBudget,
  MAX_DELAY_SECONDS,
  MAX_RETRIES,
  MAX_ROUTED_SENDS,
  PRE_HEADER_MAX_DELAY_SECONDS,
  setTransportEventSinkForTest,
} from "../src/services/copilot/transport-retry"

const originalFetch = globalThis.fetch
const queuedResults: Array<Error | Response> = []
const capturedRequests: Array<{ url: string; init?: RequestInit }> = []
const transportEvents: Array<{
  attributes: Record<string, unknown>
  outcome: string
}> = []
const httpRetrySleeps: Array<number> = []

type BunTimeoutRequestInit = RequestInit & {
  timeout?: boolean | number
}

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

  const next = queuedResults.shift()
  if (!next) {
    throw new Error(`Unexpected fetch: ${requestUrl}`)
  }

  if (next instanceof Error) {
    throw next
  }

  return next
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  setTransportEventSinkForTest((message, attributes) => {
    transportEvents.push({
      attributes,
      outcome: message.replace("copilot transport ", ""),
    })
  })
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  setTransportEventSinkForTest()
  setHttpRetrySleepForTest()
})

beforeEach(() => {
  fetchMock.mockClear()
  queuedResults.length = 0
  capturedRequests.length = 0
  transportEvents.length = 0
  httpRetrySleeps.length = 0
  setHttpRetrySleepForTest((ms) => {
    httpRetrySleeps.push(ms)
    return Promise.resolve()
  })
  clearLlmDebugLogs()
  resetRoutingTelemetryForTest()
  state.accountType = "individual"
  state.githubToken = "github-token"
  state.copilotToken = "expired-copilot-token"
  state.isMultiToken = false
})

test("refreshes the single-token copilot token and retries the request after a 401", async () => {
  queuedResults.push(
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
    queuedResults.length = 0
    capturedRequests.length = 0
    fetchMock.mockClear()

    queuedResults.push(
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
  queuedResults.push(
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

test("derives restart-stable upstream headers from request affinity", () => {
  state.sessionId = "before-restart"
  const first = runWithRoutingAffinity(
    { key: "conversation", source: "codex_session" },
    () => copilotHeaders(),
  )
  state.sessionId = "after-restart"
  const second = runWithRoutingAffinity(
    { key: "conversation", source: "codex_session" },
    () => copilotHeaders(),
  )

  expect(second["X-Client-Session-Id"]).toBe(first["X-Client-Session-Id"])
  expect(first["X-Interaction-Id"]).toBe(first["X-Client-Session-Id"])
  expect(first["X-Agent-Task-Id"]).toBe(first["X-Client-Session-Id"])
  expect(first["X-Client-Session-Id"]).not.toBe(state.sessionId)
})

test("uses process identity for unidentified requests", () => {
  state.sessionId = "process-session"

  const headers = copilotHeaders()

  expect(headers["X-Interaction-Id"]).toBe("process-session")
  expect(headers["X-Client-Session-Id"]).toBe("process-session")
  expect(headers["X-Agent-Task-Id"]).toBe("process-session")
})

test("sets a descriptive User-Agent header", () => {
  const headers = copilotHeaders()

  expect(headers["User-Agent"]).toContain("copilot-api")
})

test("does not retry unknown upstream 400 responses", async () => {
  queuedResults.push(
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
  queuedResults.push(new Error("The operation was aborted"))

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
  expect(listLlmDebugLogs().entries[0]?.status).toBe("aborted")
})

test("marks an aborted debug clone-body read as aborted", async () => {
  const abortError = new Error("response body was aborted")
  abortError.name = "AbortError"
  const response = new Response("stream body", {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  })
  Object.defineProperty(response, "clone", {
    configurable: true,
    value: () =>
      ({
        text: () => Promise.reject(abortError),
      }) as unknown as Response,
  })
  queuedResults.push(response)

  await copilotFetch("/responses", {
    body: JSON.stringify({ model: "gpt-aborted-stream", stream: true }),
    headers: {
      Authorization: "Bearer expired-copilot-token",
      "content-type": "application/json",
    },
    method: "POST",
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = listLlmDebugLogs().entries[0]
  expect(entry).toBeDefined()
  expect(entry.status).toBe("aborted")
  expect(entry.responseStatus).toBe(200)
  expect(entry.errorMessage).toBe("response body was aborted")
})

test("captures raw LLM request and response attempts for dashboard debugging", async () => {
  queuedResults.push(
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

// --- Transport-level connection errors ---

const AUTH_HEADERS = {
  Authorization: "Bearer expired-copilot-token",
  "content-type": "application/json",
}

/** The exact shape Bun throws when a pooled keep-alive socket is reset. */
function bunSocketClosedError(): Error {
  const error = new Error(
    "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  )
  return Object.assign(error, {
    code: "ECONNRESET",
    errno: 0,
    path: "https://api.githubcopilot.com/responses?session=secret-token",
  })
}

function llmSends(): Array<{ url: string; init?: RequestInit }> {
  return capturedRequests.filter(
    (request) => !request.url.includes("/copilot_internal/"),
  )
}

test("retries Bun's socket-closed ECONNRESET and returns the retried response", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(2)
})

test("records every Copilot transport attempt with its retry reason", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch(
    "/responses",
    { method: "POST", headers: AUTH_HEADERS },
    {
      telemetry: {
        accountId: 7,
        destination: "Responses",
        model: "gpt-telemetry-test",
        provider: "GitHub Copilot",
        reason: "initial",
      },
    },
  )

  expect(response.status).toBe(200)
  const snapshot = getRoutingTelemetrySnapshot({
    accounts: [{ id: 7, accountType: "individual", healthy: true }],
    multiToken: true,
    window: "1h",
  })
  expect(snapshot.totals).toMatchObject({
    failovers: 0,
    retries: 1,
    upstreamCalls: 2,
  })
  expect(snapshot.models[0]).toMatchObject({
    model: "gpt-telemetry-test",
    outcomes: { success: 1, transportError: 1 },
    provider: "GitHub Copilot",
  })
  expect(snapshot.models[0]?.accounts).toEqual([
    { accountId: 7, share: 1, upstreamCalls: 2 },
  ])
})

test("disables Bun pooling and replaces its idle deadline with caller cancellation", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )
  const abortController = new AbortController()
  const requestInit: BunTimeoutRequestInit = {
    method: "POST",
    headers: AUTH_HEADERS,
    keepalive: true,
    signal: abortController.signal,
    timeout: 1,
  }

  const response = await copilotFetch("/responses", requestInit)

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(2)
  expect(capturedRequests.map(({ init }) => init?.keepalive)).toEqual([
    false,
    false,
  ])
  expect(
    capturedRequests.map(
      ({ init }) => (init as BunTimeoutRequestInit | undefined)?.timeout,
    ),
  ).toEqual([false, false])
})

test("keeps Bun's runtime timeout on signal-less control-plane calls", async () => {
  queuedResults.push(new Response("{}", { status: 200 }))
  const requestInit: BunTimeoutRequestInit = {
    method: "GET",
    timeout: false,
  }

  const response = await copilotFetch("/models", requestInit)

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.keepalive).toBe(false)
  expect(
    (capturedRequests[0]?.init as BunTimeoutRequestInit | undefined)?.timeout,
  ).toBeUndefined()
})

test("retries when the connection code is only on error.cause", async () => {
  const cause = Object.assign(new Error("upstream closed the stream"), {
    code: "ECONNRESET",
  })
  // Message matches no retry pattern — only the nested code makes it retryable.
  queuedResults.push(
    new Error("request failed", { cause }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(2)
})

test("caps repeated connection errors at two transport sends", async () => {
  queuedResults.push(bunSocketClosedError(), bunSocketClosedError())

  let thrownError: unknown
  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch (error) {
    thrownError = error
  }

  expect(thrownError).toBeInstanceOf(Error)
  expect((thrownError as Error).message).toContain("socket connection")
  expect(capturedRequests).toHaveLength(2)
})

test("stops retrying when the request is aborted during the backoff", async () => {
  const controller = new AbortController()
  queuedResults.push(bunSocketClosedError())
  setTimeout(() => {
    controller.abort()
  }, 50)

  let thrownError: unknown
  try {
    await copilotFetch("/responses", {
      method: "POST",
      headers: AUTH_HEADERS,
      signal: controller.signal,
    })
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.name).toBe("AbortError")
  expect(capturedRequests).toHaveLength(1)
})

test("caps an ECONNRESET followed by a 503 at two sends", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("Overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(503)
  expect(capturedRequests).toHaveLength(2)
})

test("caps a 503 followed by an ECONNRESET at two sends", async () => {
  queuedResults.push(
    new Response("Overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
    bunSocketClosedError(),
  )

  let thrownError: unknown
  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.message).toContain(
    "socket connection",
  )
  expect(capturedRequests).toHaveLength(2)
})

test("caps a 401 refresh followed by an ECONNRESET at two LLM sends", async () => {
  queuedResults.push(
    new Response("Unauthorized", { status: 401 }),
    new Response(
      JSON.stringify({
        token: "fresh-copilot-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    bunSocketClosedError(),
  )

  let thrownError: unknown
  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch (error) {
    thrownError = error
  }

  expect((thrownError as Error | undefined)?.message).toContain(
    "socket connection",
  )
  expect(llmSends()).toHaveLength(2)
})

test("keeps the same X-Request-Id across a transport retry", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  await copilotFetch("/responses", {
    method: "POST",
    headers: { ...AUTH_HEADERS, "X-Request-Id": "req-retry-chain" },
  })

  expect(capturedRequests).toHaveLength(2)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    "X-Request-Id": "req-retry-chain",
  })
  expect(capturedRequests[1]?.init?.headers).toMatchObject({
    "X-Request-Id": "req-retry-chain",
  })
})

test("records the connection error code and a sanitized path in LLM debug", async () => {
  queuedResults.push(bunSocketClosedError(), bunSocketClosedError())

  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch {
    // exhausted retries — the debug entry is what this test asserts on
  }
  await new Promise((resolve) => setTimeout(resolve, 0))

  const summary = listLlmDebugLogs().entries[0]
  expect(summary).toBeDefined()
  const entry = getLlmDebugLog(summary.id)
  expect(entry?.error?.code).toBe("ECONNRESET")
  expect(entry?.error?.errno).toBe(0)
  expect(entry?.error?.path).toBe("https://api.githubcopilot.com/responses")
})

test("does not retry an ECONNABORTED when the caller already disconnected", async () => {
  const controller = new AbortController()
  controller.abort()
  queuedResults.push(
    Object.assign(new Error("The connection was aborted by the peer"), {
      code: "ECONNABORTED",
    }),
  )

  let thrownError: unknown
  try {
    await copilotFetch("/responses", {
      method: "POST",
      headers: AUTH_HEADERS,
      signal: controller.signal,
    })
  } catch (error) {
    thrownError = error
  }

  expect(thrownError).toBeDefined()
  expect(capturedRequests).toHaveLength(1)
  expect(transportEvents).toHaveLength(0)
})

// `delayMs` is the rounded nominal backoff, while `elapsedMs` is real wall
// clock; a timer may fire a couple of ms early, so compare with tolerance.
// The regression this guards (per-attempt timing reported as chain elapsed)
// would leave elapsedMs near zero, far outside this margin.
const SCHEDULING_TOLERANCE_MS = 50

test("reports total chain elapsed time including backoff", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })

  const terminal = transportEvents.at(-1)
  expect(terminal?.outcome).toBe("response_received")
  const elapsedMs = terminal?.attributes.elapsedMs as number
  const attemptMs = terminal?.attributes.attemptMs as number
  const delayMs = transportEvents[0]?.attributes.delayMs as number

  expect(elapsedMs).toBeGreaterThanOrEqual(delayMs - SCHEDULING_TOLERANCE_MS)
  // Chain elapsed must exceed the single send it ended on.
  expect(elapsedMs).toBeGreaterThan(attemptMs)
})

/** A Bun socket error wrapped in an outer Error, carrying fields on the cause. */
function causeWrappedSocketError(): Error {
  return new Error("upstream request failed", {
    cause: Object.assign(new Error("socket closed"), {
      code: "ECONNRESET",
      errno: 0,
      path: "https://api.githubcopilot.com/responses?session=secret",
    }),
  })
}

test("records cause-level errno and path in LLM debug", async () => {
  queuedResults.push(causeWrappedSocketError(), causeWrappedSocketError())

  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch {
    // exhausted — the debug entry is what this test asserts on
  }
  await new Promise((resolve) => setTimeout(resolve, 0))

  const summary = listLlmDebugLogs().entries[0]
  const entry = getLlmDebugLog(summary.id)
  expect(entry?.error?.code).toBe("ECONNRESET")
  expect(entry?.error?.errno).toBe(0)
  expect(entry?.error?.path).toBe("https://api.githubcopilot.com/responses")
})

test("retries ECONNABORTED instead of reading it as a client cancellation", async () => {
  // The message contains "aborted"; only the code distinguishes a dead socket
  // from a caller-initiated abort.
  const socketAborted = Object.assign(
    new Error("The connection was aborted by the peer"),
    { code: "ECONNABORTED" },
  )
  queuedResults.push(socketAborted, new Response("{}", { status: 200 }))

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(200)
  expect(capturedRequests).toHaveLength(2)
  expect(transportEvents.map((event) => event.outcome)).toEqual([
    "retrying",
    "response_received",
  ])
})

test("emits no transport telemetry when only an HTTP status was retried", async () => {
  queuedResults.push(
    new Response("Overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
    new Response("{}", { status: 200 }),
  )

  await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })

  expect(capturedRequests).toHaveLength(2)
  expect(transportEvents).toHaveLength(0)
})

test("emits no transport telemetry when only a 401 refresh was retried", async () => {
  queuedResults.push(
    new Response("Unauthorized", { status: 401 }),
    new Response(
      JSON.stringify({
        token: "fresh-copilot-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    new Response("{}", { status: 200 }),
  )

  await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })

  expect(transportEvents).toHaveLength(0)
})

test("pairs a retried chain with exactly one response_received", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("{}", { status: 200 }),
  )

  await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })

  expect(transportEvents.map((event) => event.outcome)).toEqual([
    "retrying",
    "response_received",
  ])
  const chainIds = new Set(
    transportEvents.map((event) => event.attributes.retryChainId),
  )
  expect(chainIds.size).toBe(1)
  expect(transportEvents[1]?.attributes.status).toBe(200)
})

test("pairs an exhausted chain with exactly one terminal event", async () => {
  queuedResults.push(bunSocketClosedError(), bunSocketClosedError())

  try {
    await copilotFetch("/responses", { method: "POST", headers: AUTH_HEADERS })
  } catch {
    // exhausted — telemetry is what this test asserts on
  }

  expect(transportEvents.map((event) => event.outcome)).toEqual([
    "retrying",
    "exhausted",
  ])
  const chainIds = new Set(
    transportEvents.map((event) => event.attributes.retryChainId),
  )
  expect(chainIds.size).toBe(1)
})

test("reports a retried chain that ends in 503 as response_received, not recovery", async () => {
  queuedResults.push(
    bunSocketClosedError(),
    new Response("Overloaded", {
      status: 503,
      headers: { "retry-after": "0" },
    }),
  )

  const response = await copilotFetch("/responses", {
    method: "POST",
    headers: AUTH_HEADERS,
  })

  expect(response.status).toBe(503)
  expect(transportEvents.map((event) => event.outcome)).toEqual([
    "retrying",
    "response_received",
  ])
  expect(transportEvents[1]?.attributes.status).toBe(503)
})

test("bounds pre-header retry delay without weakening the send budget", () => {
  // A `retry-after` large enough to clamp at MAX_DELAY_SECONDS sleeps 144-180s
  // before any header is sent, which alone exceeds Cloudflare's ~120-125s
  // origin inactivity budget and produces a deterministic 524.
  expect(PRE_HEADER_MAX_DELAY_SECONDS).toBe(30)
  expect(PRE_HEADER_MAX_DELAY_SECONDS).toBeLessThan(MAX_DELAY_SECONDS)

  // MAX_ROUTED_SENDS permits at most two pre-header sleeps per routed call.
  const worstCaseSilenceSeconds =
    (MAX_ROUTED_SENDS - 1) * PRE_HEADER_MAX_DELAY_SECONDS
  expect(worstCaseSilenceSeconds).toBeLessThan(120)

  // The ceiling bounds delay duration only — the COPILOT-API-15 send-count
  // invariants must be untouched.
  expect(MAX_ROUTED_SENDS).toBe(3)
  expect(MAX_RETRIES).toBe(1)
  expect(createRetryBudget()).toEqual({ remaining: MAX_ROUTED_SENDS - 1 })
})

test("caps Retry-After only when the caller opts into the streaming pre-header ceiling", async () => {
  queuedResults.push(
    new Response("overloaded", {
      status: 429,
      headers: { "retry-after": "170" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch(
    "/chat/completions",
    { method: "POST" },
    { maxHttpRetryDelaySeconds: PRE_HEADER_MAX_DELAY_SECONDS },
  )

  expect(response.status).toBe(200)
  expect(httpRetrySleeps).toEqual([PRE_HEADER_MAX_DELAY_SECONDS * 1000])
  expect(capturedRequests).toHaveLength(2)
})

test("keeps the normal Retry-After delay for callers without a streaming ceiling", async () => {
  queuedResults.push(
    new Response("overloaded", {
      status: 429,
      headers: { "retry-after": "170" },
    }),
    new Response("{}", { status: 200 }),
  )

  const response = await copilotFetch("/chat/completions", { method: "POST" })

  expect(response.status).toBe(200)
  expect(httpRetrySleeps).toHaveLength(1)
  expect(httpRetrySleeps[0]).toBeGreaterThan(
    PRE_HEADER_MAX_DELAY_SECONDS * 1000,
  )
  expect(httpRetrySleeps[0]).toBeLessThanOrEqual(MAX_DELAY_SECONDS * 1000)
  expect(capturedRequests).toHaveLength(2)
})
