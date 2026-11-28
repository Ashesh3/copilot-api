import { afterEach, describe, expect, test } from "bun:test"

import type { InterceptAssistantResult } from "~/lib/intercept/assistant"

import {
  DEBUG_CAPTURE_MEMORY_MAX_BYTES,
  debugCaptureMemoryUsage,
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"
import { LocalHTTPError } from "~/lib/error"
import { CanonicalEditError } from "~/lib/intercept/canonical"
import {
  CaptureBudgetError,
  InterceptEngine,
  StaleRevisionError,
} from "~/lib/intercept/engine"
import { retainedBytes } from "~/lib/intercept/held-body"
import { DEFAULT_INTERCEPT_CONFIG } from "~/lib/intercept/types"

const engines: Array<InterceptEngine> = []

function newEngine(
  runner?: ConstructorParameters<typeof InterceptEngine>[0],
): InterceptEngine {
  const engine = new InterceptEngine(runner)
  engines.push(engine)
  return engine
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.resetForTest()
})

function chatRequest(content: string, stream = false) {
  return {
    method: "POST",
    path: "/chat/completions",
    url: "https://api.githubcopilot.com/chat/completions",
    upstream: "copilot" as const,
    headers: {},
    body: JSON.stringify({
      model: "gpt-4o",
      stream,
      messages: [{ role: "user", content }],
    }),
  }
}

function chatResponse(content: string): Response {
  return Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  })
}

function responseInput(response: Response, requestBody: string) {
  return {
    method: "POST",
    path: "/chat/completions",
    url: "https://api.githubcopilot.com/chat/completions",
    upstream: "copilot" as const,
    response,
    requestSnapshot: {
      method: "POST",
      path: "/chat/completions",
      model: "gpt-4o",
      body: requestBody,
      headers: {},
    },
  }
}

function nextQueued(engine: InterceptEngine): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>()
  const unsubscribe = engine.subscribe((event) => {
    if (event.type !== "queued") return
    unsubscribe()
    resolve(event.item.id)
  })
  return promise
}

describe("capture memory", () => {
  test("an edit that does not fit is refused and leaves the item unchanged", async () => {
    const engine = newEngine()
    engine.updateConfig({ enabled: true, direction: "request" })
    const queued = nextQueued(engine)
    const pending = engine.interceptRequest(chatRequest("original"))
    const id = await queued
    const filler =
      DEBUG_CAPTURE_MEMORY_MAX_BYTES - debugCaptureMemoryUsage() - 10
    reserveDebugCaptureMemory(filler)
    try {
      expect(() =>
        engine.editPendingItem(id, {
          body: chatRequest("x".repeat(1000)).body,
        }),
      ).toThrow(CaptureBudgetError)
    } finally {
      releaseDebugCaptureMemory(filler)
    }

    expect(engine.getItem(id)?.currentBody).toBe(chatRequest("original").body)
    engine.forwardAllPending()
    expect((await pending).modified).toBe(false)
  })

  test("a held response reserves the request it answers", async () => {
    const engine = newEngine()
    engine.updateConfig({ enabled: true, direction: "response" })
    const requestBody = chatRequest("y".repeat(20_000)).body
    const response = chatResponse("short")
    const responseBytes = Buffer.byteLength(await response.clone().text())
    const before = debugCaptureMemoryUsage()

    const queued = nextQueued(engine)
    const pending = engine.interceptResponse(
      responseInput(response, requestBody),
    )
    await queued

    expect(debugCaptureMemoryUsage() - before).toBe(
      3 * responseBytes + 2 * Buffer.byteLength(requestBody),
    )
    engine.forwardAllPending()
    await pending
    engine.clearRecent()
    expect(debugCaptureMemoryUsage()).toBe(before)
  })

  test("a suggestion without a preview still reserves its summary and operations", () => {
    const item = { originalBody: "{}", currentBody: "{}" }
    const summary = "s".repeat(10_000)

    const withSuggestion = retainedBytes({
      ...item,
      assistantSuggestion: {
        id: "suggestion",
        createdAt: new Date(0).toISOString(),
        model: "test-model",
        summary,
        operations: [{ op: "delete", id: "msg-0", reason: "r".repeat(5000) }],
        previewBody: null,
        previewCanonical: null,
        durationMs: 0,
        reusedItemCount: 0,
        reusedOperationCount: 0,
        revision: 0,
      },
    })

    expect(withSuggestion - retainedBytes(item)).toBeGreaterThan(15_000)
  })
})

function stalledResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"))
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("response capture", () => {
  test("turning Intercept off releases a response that never finishes", async () => {
    const engine = newEngine()
    engine.updateConfig({ enabled: true, direction: "response" })
    const stalled = stalledResponse()

    const pending = engine.interceptResponse(
      responseInput(stalled, chatRequest("hi", true).body),
    )
    await Bun.sleep(10)
    engine.updateConfig({ enabled: false })

    expect(await pending).toBe(stalled)
  })

  test("a client gone before capture starts passes a stalled response through", async () => {
    const engine = newEngine()
    engine.updateConfig({ enabled: true, direction: "response" })
    const stalled = stalledResponse()

    const result = await engine.interceptResponse({
      ...responseInput(stalled, chatRequest("hi", true).body),
      signal: AbortSignal.abort(),
    })

    expect(result).toBe(stalled)
  })

  test("reading a response counts against its hold time", async () => {
    const engine = newEngine()
    engine.updateConfig({
      enabled: true,
      direction: "response",
      timeoutSeconds: 15,
    })
    const body = JSON.stringify({ choices: [] })
    const slow = new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          await Bun.sleep(50)
          controller.enqueue(new TextEncoder().encode(body))
          controller.close()
        },
      }),
      { headers: { "content-type": "application/json" } },
    )
    const startedAt = Date.now()

    const queued = nextQueued(engine)
    const pending = engine.interceptResponse(
      responseInput(slow, chatRequest("hi").body),
    )
    const item = engine.getItem(await queued)

    expect(item?.expiresAtMs).toBeLessThanOrEqual(startedAt + 15_000 + 5)
    expect(item?.expiresAtMs).toBeLessThan((item?.createdAtMs ?? 0) + 15_000)
    engine.forwardAllPending()
    await pending
  })

  test("a dropped response is a local error, not an upstream response", async () => {
    const engine = newEngine()
    engine.updateConfig({ enabled: true, direction: "response" })
    const queued = nextQueued(engine)
    const pending = engine.interceptResponse(
      responseInput(chatResponse("hello"), chatRequest("hi").body),
    )
    engine.dropItem(await queued, "not this one")

    const failure: unknown = await pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(LocalHTTPError)
    if (!(failure instanceof LocalHTTPError)) return
    expect(failure.response.status).toBe(403)
    expect(failure.clientBody).toMatchObject({
      error: { code: "intercept_dropped" },
    })
  })

  test("a BOM-prefixed response is still held for a body-less request", async () => {
    const engine = newEngine()
    engine.updateConfig({ enabled: true, direction: "response" })
    const withBom = new Response(`\uFEFF${JSON.stringify({ data: [] })}`, {
      headers: { "content-type": "application/json" },
    })

    const queued = nextQueued(engine)
    const pending = engine.interceptResponse(responseInput(withBom, ""))
    expect(engine.getItem(await queued)?.phase).toBe("response")
    engine.forwardAllPending()
    await pending
  })
})

describe("held request edits", () => {
  test("a raw edit cannot switch between streamed and buffered", async () => {
    const engine = newEngine()
    engine.updateConfig({ enabled: true, direction: "request" })
    const queued = nextQueued(engine)
    const pending = engine.interceptRequest(chatRequest("hi", true))
    const id = await queued

    expect(() =>
      engine.editPendingItem(id, { body: chatRequest("hi", false).body }),
    ).toThrow(CanonicalEditError)
    engine.forwardAllPending()
    await pending
  })

  test("only the suggestion the operator reviewed can be applied", async () => {
    const suggestion: InterceptAssistantResult = {
      id: "reviewed",
      createdAt: new Date(0).toISOString(),
      model: "test-model",
      summary: "test",
      operations: [{ op: "replace", id: "msg-0", content: "assisted" }],
      previewBody: null,
      previewCanonical: null,
      durationMs: 0,
      reusedItemCount: 0,
      reusedOperationCount: 0,
    }
    const engine = newEngine(() => Promise.resolve(suggestion))
    engine.updateConfig({ enabled: true, direction: "request" })
    const queued = nextQueued(engine)
    const pending = engine.interceptRequest(chatRequest("original"))
    const id = await queued
    await engine.triggerAssistant(id)

    expect(() =>
      engine.applyAssistantDiff(id, { suggestionId: "other", revision: 0 }),
    ).toThrow(StaleRevisionError)
    expect(engine.getItem(id)?.revision).toBe(0)
    engine.applyAssistantDiff(id, { suggestionId: "reviewed", revision: 0 })
    expect(engine.getItem(id)?.currentBody).toContain("assisted")
    engine.forwardAllPending()
    await pending
  })
})

describe("AI Assist session", () => {
  const assistant = {
    ...DEFAULT_INTERCEPT_CONFIG.assistant,
    enabled: true,
    autoRun: false,
    model: "test-model",
    sharedInstruction: "Rewrite the user turn",
  }
  const noChanges: InterceptAssistantResult = {
    id: "none",
    createdAt: new Date(0).toISOString(),
    model: "test-model",
    summary: "No change",
    operations: [],
    previewBody: null,
    previewCanonical: null,
    durationMs: 0,
    reusedItemCount: 0,
    reusedOperationCount: 0,
  }

  test("changing AI Assist settings or turning Intercept off forgets this session's results", async () => {
    const seen: Array<number | undefined> = []
    const engine = newEngine((options) => {
      seen.push(options.cache?.size)
      options.cache?.remember("scope", "key", { itemId: null, operations: [] })
      return Promise.resolve(noChanges)
    })
    engine.updateConfig({ enabled: true, direction: "request", assistant })
    let queued = nextQueued(engine)
    let pending = engine.interceptRequest(chatRequest("original"))
    let id = await queued

    await engine.triggerAssistant(id)
    await engine.triggerAssistant(id)
    engine.updateConfig({
      assistant: { ...assistant, reasoningEffort: "high" },
    })
    await engine.triggerAssistant(id)
    engine.updateConfig({ enabled: false })
    await pending

    engine.updateConfig({ enabled: true })
    queued = nextQueued(engine)
    pending = engine.interceptRequest(chatRequest("again"))
    id = await queued
    await engine.triggerAssistant(id)

    // Remembered across runs; forgotten on a settings change and on turn-off.
    expect(seen).toEqual([0, 1, 0, 0])
    engine.forwardAllPending()
    await pending
  })

  test("a run still in flight cannot refill the cache after a settings change", async () => {
    const { promise: release, resolve } = Promise.withResolvers<undefined>()
    const seen: Array<number | undefined> = []
    const engine = newEngine(async (options) => {
      seen.push(options.cache?.size)
      if (seen.length === 1) await release
      options.cache?.remember("scope", "key", { itemId: null, operations: [] })
      return noChanges
    })
    engine.updateConfig({ enabled: true, direction: "request", assistant })
    const queued = nextQueued(engine)
    const pending = engine.interceptRequest(chatRequest("original"))
    const id = await queued

    const slow = engine.triggerAssistant(id)
    engine.updateConfig({
      assistant: { ...assistant, reasoningEffort: "high" },
    })
    resolve(undefined)
    await slow
    await engine.triggerAssistant(id)

    expect(seen).toEqual([0, 0])
    engine.forwardAllPending()
    await pending
  })

  test("an automatic run that cannot start tells the operator why", async () => {
    const engine = newEngine(() => Promise.resolve(noChanges))
    engine.updateConfig({
      enabled: true,
      direction: "request",
      assistant: { ...assistant, autoRun: true, sharedInstruction: "" },
    })
    const queued = nextQueued(engine)
    const pending = engine.interceptRequest(chatRequest("original"))
    await queued

    const [held] = engine.getSnapshot().pending
    expect(held.assistantStatus).toBe("error")
    expect(held.assistantError).toContain(
      "AI Assist did not run: no user message is set for requests",
    )
    engine.forwardAllPending()
    await pending
  })
})
