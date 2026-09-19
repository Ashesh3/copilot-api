import { afterEach, beforeEach, expect, jest, test } from "bun:test"

import {
  DEBUG_CAPTURE_MEMORY_MAX_BYTES,
  debugCaptureMemoryUsage,
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"
import { runWithMessagesFallbackObservation } from "~/lib/llm-debug-fallback"
import {
  clearLlmDebugLogs,
  finishLlmDebugLog,
  getLlmDebugLog,
  listLlmDebugLogs,
  startLlmDebugLog,
} from "~/lib/llm-debug-log"

beforeEach(async () => await clearLlmDebugLogs())
afterEach(async () => {
  await clearLlmDebugLogs()
  jest.useRealTimers()
})

function start(payload: Record<string, unknown>) {
  return startLlmDebugLog({
    method: "POST",
    path: "/v1/messages",
    requestBody: JSON.stringify(payload),
    requestHeaders: {},
    url: "https://example.test/v1/messages",
  })
}

function finish(id: string, body: unknown) {
  finishLlmDebugLog(id, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    status: 200,
    statusText: "OK",
  })
}

test.each([
  ["default", "default"],
  [[{ model: "claude-opus-4.8" }], ["claude-opus-4.8"]],
])(
  "records the requested fallback policy without claiming execution: %j",
  async (fallbacks, targetModels) => {
    const payload = {
      model: "claude-fable-5",
      messages: [{ role: "user", content: "hello" }],
      fallbacks,
    }
    const id = start(payload)
    expect(await getLlmDebugLog(id)).toMatchObject({
      status: "pending",
      fallbackObservations: [
        { kind: "requested", sourceModel: "claude-fable-5", targetModels },
      ],
      request: { body: JSON.stringify(payload) },
    })
    expect((await listLlmDebugLogs()).entries[0]).toMatchObject({
      fallbackObservations: [
        { kind: "requested", sourceModel: "claude-fable-5", targetModels },
      ],
    })
    expect(await getLlmDebugLog(id)).not.toHaveProperty("fallback")
  },
)

test.each([undefined, [], "any", [{ model: 4 }], [{ model: "" }]])(
  "does not invent a requested policy from unsupported fallbacks: %j",
  async (fallbacks) => {
    const id = start({ model: "source", fallbacks })
    expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
  },
)

test("captures an explicit upstream JSON fallback separately from its request policy", async () => {
  const id = start({ model: "source", fallbacks: "default" })
  const response = {
    type: "message",
    model: "target",
    content: [
      { type: "fallback", from: { model: "source" }, to: { model: "target" } },
      { type: "text", text: "answer" },
    ],
    stop_reason: "end_turn",
  }
  finish(id, response)
  expect(await getLlmDebugLog(id)).toMatchObject({
    fallbackObservations: [
      { kind: "requested", sourceModel: "source", targetModels: "default" },
      { kind: "upstream", fromModel: "source", targetModel: "target" },
    ],
    response: { body: JSON.stringify(response) },
  })
})

test("captures explicit native SSE fallback events without interpreting model differences", async () => {
  const id = start({ model: "source", stream: true })
  const frames = [
    {
      type: "message_start",
      message: { type: "message", model: "source", content: [] },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "fallback",
        from: { model: "source" },
        to: { model: "target" },
      },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ]
  const wire = frames
    .map(
      (event) =>
        `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
    )
    .join("")
  finishLlmDebugLog(id, {
    body: wire,
    headers: { "content-type": "text/event-stream" },
    status: 200,
    statusText: "OK",
  })
  expect(await getLlmDebugLog(id)).toMatchObject({
    fallbackObservations: [
      { kind: "upstream", fromModel: "source", targetModel: "target" },
    ],
    response: { body: wire },
  })
})

test("ignores fallback-looking text, request history, and response model changes", async () => {
  const id = start({
    model: "source",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "fallback",
            from: { model: "older" },
            to: { model: "source" },
          },
        ],
      },
    ],
  })
  finish(id, {
    type: "message",
    model: "target",
    content: [
      {
        type: "text",
        text: '{"type":"fallback","from":{"model":"source"},"to":{"model":"target"}}',
      },
    ],
    stop_reason: "end_turn",
  })
  expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
})

function requestPayload(model = "claude-fable-5", content = "same prompt") {
  return { model, messages: [{ role: "user", content }], max_tokens: 128 }
}

function inboundRequest(
  options: {
    credential?: string | null
    session?: string | null
    thread?: string
  } = {},
) {
  const headers = new Headers()
  const credential =
    options.credential === undefined ? "private-client-key" : options.credential
  const session =
    options.session === undefined ? "private-session" : options.session
  if (credential) headers.set("authorization", `Bearer ${credential}`)
  if (session) headers.set("x-claude-code-session-id", session)
  if (options.thread) headers.set("thread-id", options.thread)
  return new Request("https://gateway.test/v1/messages", {
    method: "POST",
    headers,
  })
}

function scopedStart(
  payload: Record<string, unknown> = requestPayload(),
  request = inboundRequest(),
  upstreamPayload = payload,
) {
  return runWithMessagesFallbackObservation({ request, payload }, () =>
    start(upstreamPayload),
  )
}

function refuse(id: string) {
  finish(id, {
    type: "message",
    model: "claude-fable-5",
    content: [],
    stop_reason: "refusal",
  })
}

test("infers only the next matching client model retry after a completed refusal", async () => {
  const previousLogId = scopedStart()
  refuse(previousLogId)
  const id = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(id)).toMatchObject({
    fallbackObservations: [
      {
        kind: "client",
        fromModel: "claude-fable-5",
        targetModel: "claude-opus-4.8",
        previousLogId,
        reason: "refusal",
        evidence: "inferred",
      },
    ],
  })
  expect(await getLlmDebugLog(id)).not.toHaveProperty("fallback")
  const repeated = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(repeated)).not.toHaveProperty(
    "fallbackObservations",
  )
})

test("keeps the original client fallback request policy through upstream model rewrites", async () => {
  const original = { ...requestPayload(), fallbacks: "default" }
  const id = scopedStart(
    original,
    inboundRequest(),
    requestPayload("redirected-upstream"),
  )
  expect(await getLlmDebugLog(id)).toMatchObject({
    fallbackObservations: [
      {
        kind: "requested",
        sourceModel: "claude-fable-5",
        targetModels: "default",
      },
    ],
  })
})

test.each([
  { credential: "another-key" },
  { session: "another-session" },
  { credential: null },
  { session: null },
])(
  "isolates client observations from a different or missing identity: %j",
  async (options) => {
    const source = scopedStart()
    refuse(source)
    const id = scopedStart(
      requestPayload("claude-opus-4.8"),
      inboundRequest(options),
    )
    expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
  },
)

test("isolates child threads sharing a parent session", async () => {
  const source = scopedStart(
    requestPayload(),
    inboundRequest({ thread: "child-a" }),
  )
  refuse(source)
  const id = scopedStart(
    requestPayload("claude-opus-4.8"),
    inboundRequest({ thread: "child-b" }),
  )
  expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
})

test("consumes refusal evidence when a different request intervenes", async () => {
  const source = scopedStart()
  refuse(source)
  scopedStart(requestPayload("claude-fable-5", "different prompt"))
  const id = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
})

test("does not correlate a retry that also removes compatibility fields", async () => {
  const source = scopedStart({
    ...requestPayload(),
    fallbacks: "default",
    display: "cli",
  })
  refuse(source)
  const id = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
})

test("late completion cannot establish evidence after a newer same-session request", async () => {
  const old = scopedStart()
  scopedStart(requestPayload("claude-fable-5", "newer turn"))
  refuse(old)
  const id = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
})

test("a concurrently started request cannot retrospectively inherit a refusal", async () => {
  const source = scopedStart()
  const retry = scopedStart(requestPayload("claude-opus-4.8"))
  refuse(source)
  expect(await getLlmDebugLog(retry)).not.toHaveProperty("fallbackObservations")
})

test("expires client refusal evidence after one minute", async () => {
  jest.useFakeTimers()
  const now = Date.now()
  jest.setSystemTime(now)
  const source = scopedStart()
  refuse(source)
  jest.setSystemTime(now + 60_001)
  const id = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
})

test("clearing debug captures also clears refusal correlation", async () => {
  const source = scopedStart()
  refuse(source)
  await clearLlmDebugLogs()
  const id = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
})

test.each([
  ["claude-opus-4-8", "claude-opus-4.8"],
  ["claude-opus-4.8:high", "claude-opus-4.8:max"],
])(
  "does not label equivalent model aliases as a client fallback: %s -> %s",
  async (sourceModel, targetModel) => {
    const source = scopedStart(requestPayload(sourceModel))
    refuse(source)
    const id = scopedStart(requestPayload(targetModel))
    expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
  },
)

test("does not label client aliases that dispatch to the same upstream model", async () => {
  const source = scopedStart(
    requestPayload("alias-a"),
    inboundRequest(),
    requestPayload("same-upstream"),
  )
  refuse(source)
  const id = scopedStart(
    requestPayload("alias-b"),
    inboundRequest(),
    requestPayload("same-upstream"),
  )
  expect(await getLlmDebugLog(id)).not.toHaveProperty("fallbackObservations")
})

test("does not serialize correlation keys or request fingerprints", async () => {
  const source = scopedStart()
  refuse(source)
  const id = scopedStart(requestPayload("claude-opus-4.8"))
  const detail = await getLlmDebugLog(id)
  expect(detail).toHaveProperty("fallbackObservations")
  const serialized = JSON.stringify(detail)
  expect(serialized).not.toContain("private-client-key")
  expect(serialized).not.toContain("private-session")
  expect(serialized).not.toContain("fingerprint")
  expect(serialized).not.toContain("credential")
})

test("starts the client retry window after a long-running refusal finishes", async () => {
  jest.useFakeTimers()
  const now = Date.now()
  jest.setSystemTime(now)
  const source = scopedStart()
  jest.setSystemTime(now + 70_000)
  refuse(source)
  const retry = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(retry)).toMatchObject({
    fallbackObservations: [{ kind: "client", previousLogId: source }],
  })
})

test("does not correlate refusal content that did not arrive as a complete successful response", async () => {
  const source = scopedStart()
  finishLlmDebugLog(source, {
    body: JSON.stringify({
      type: "message",
      content: [],
      stop_reason: "refusal",
    }),
    headers: { "content-type": "application/json" },
    status: 200,
    statusText: "OK",
    bodyBytesComplete: false,
  })
  const retry = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(retry)).not.toHaveProperty("fallbackObservations")
})

test("never infers from refusal words or metadata nested in assistant text", async () => {
  const source = scopedStart()
  finish(source, {
    type: "message",
    content: [{ type: "text", text: '{"stop_reason":"refusal"}' }],
    stop_reason: "end_turn",
  })
  const retry = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(retry)).not.toHaveProperty("fallbackObservations")
})

test("does not attribute an upstream-target refusal to the original client model", async () => {
  const source = scopedStart()
  finish(source, {
    type: "message",
    content: [
      {
        type: "fallback",
        from: { model: "claude-fable-5" },
        to: { model: "third-model" },
      },
    ],
    stop_reason: "refusal",
  })
  const retry = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(retry)).not.toHaveProperty("fallbackObservations")
})

test("accepts reordered object keys but preserves all nested request values", async () => {
  const source = scopedStart()
  refuse(source)
  const retry = scopedStart({
    max_tokens: 128,
    messages: [{ content: "same prompt", role: "user" }],
    model: "claude-opus-4.8",
  })
  expect(await getLlmDebugLog(retry)).toMatchObject({
    fallbackObservations: [{ kind: "client", previousLogId: source }],
  })
})

test("retains a decided client observation across multiple upstream attempts in one request", async () => {
  const source = scopedStart()
  refuse(source)
  const payload = requestPayload("claude-opus-4.8")
  const ids = runWithMessagesFallbackObservation(
    { request: inboundRequest(), payload },
    () => [start(payload), start({ ...payload, model: "configured-target" })],
  )
  for (const id of ids) {
    expect(await getLlmDebugLog(id)).toMatchObject({
      fallbackObservations: [
        {
          kind: "client",
          previousLogId: source,
          targetModel: "claude-opus-4.8",
        },
      ],
    })
  }
})

test("clearing captures invalidates an in-flight request before its late refusal", async () => {
  const source = scopedStart()
  await clearLlmDebugLogs()
  refuse(source)
  const retry = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(retry)).not.toHaveProperty("fallbackObservations")
})

test("does not link client retries to captures removed by memory pressure", async () => {
  const source = scopedStart()
  refuse(source)
  const reserved = DEBUG_CAPTURE_MEMORY_MAX_BYTES - debugCaptureMemoryUsage()
  expect(reserveDebugCaptureMemory(reserved)).toBe(true)
  try {
    start({ model: "memory-pressure" })
    expect(await getLlmDebugLog(source)).toBeUndefined()
  } finally {
    releaseDebugCaptureMemory(reserved)
  }
  const retry = scopedStart(requestPayload("claude-opus-4.8"))
  expect(await getLlmDebugLog(retry)).not.toHaveProperty("fallbackObservations")
})

test("returns defensive copies of requested target arrays in summaries", async () => {
  const id = start({ model: "source", fallbacks: [{ model: "target" }] })
  const summary = (await listLlmDebugLogs()).entries[0]
  const requested = summary.fallbackObservations?.find(
    (entry) => entry.kind === "requested",
  )
  if (!requested || requested.targetModels === "default")
    throw new Error("Missing requested targets")
  requested.targetModels[0] = "mutated"
  expect(await getLlmDebugLog(id)).toMatchObject({
    fallbackObservations: [{ kind: "requested", targetModels: ["target"] }],
  })
})

test("clearing captures removes decided client evidence from later attempts in the same request", async () => {
  const sourcePayload = { ...requestPayload(), fallbacks: "default" }
  const source = scopedStart(sourcePayload)
  refuse(source)
  const payload = { ...sourcePayload, model: "claude-opus-4.8" }
  await runWithMessagesFallbackObservation(
    { request: inboundRequest(), payload },
    async () => {
      const first = start(payload)
      expect(
        (await getLlmDebugLog(first))?.fallbackObservations,
      ).toContainEqual({
        kind: "client",
        fromModel: "claude-fable-5",
        targetModel: "claude-opus-4.8",
        previousLogId: source,
        reason: "refusal",
        evidence: "inferred",
      })
      await clearLlmDebugLogs()
      const second = start(payload)
      expect((await getLlmDebugLog(second))?.fallbackObservations).toEqual([
        {
          kind: "requested",
          sourceModel: "claude-opus-4.8",
          targetModels: "default",
        },
      ])
    },
  )
})

test("expiry removes decided client evidence from new attempts without rewriting retained observations", async () => {
  jest.useFakeTimers()
  const now = Date.now()
  jest.setSystemTime(now)
  const source = scopedStart()
  refuse(source)
  const payload = requestPayload("claude-opus-4.8")
  await runWithMessagesFallbackObservation(
    { request: inboundRequest(), payload },
    async () => {
      const first = start(payload)
      expect(await getLlmDebugLog(first)).toHaveProperty("fallbackObservations")
      jest.setSystemTime(now + 10 * 60_000 + 1)
      expect(await getLlmDebugLog(source)).toBeUndefined()
      const second = start(payload)
      expect(await getLlmDebugLog(second)).not.toHaveProperty(
        "fallbackObservations",
      )
      expect((await getLlmDebugLog(first))?.fallbackObservations).toMatchObject(
        [{ kind: "client", previousLogId: source }],
      )
    },
  )
})
