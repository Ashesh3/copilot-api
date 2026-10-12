import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { requestLogger, setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  enableDatabaseUsageForTest,
  getUsageResponse,
  resetUsageForTest,
} from "~/lib/usage-tracker"
import { handleCountTokens } from "~/routes/messages/count-tokens-handler"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

const originalModels = state.models
let logs: ReturnType<typeof spyOn<typeof console, "log">>

beforeEach(() => {
  resetUsageForTest()
  logs = spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  logs.mockRestore()
  enableDatabaseUsageForTest()
  setConfigForTest(null)
  setModelRedirectsForTest([])
  state.models = originalModels
})

function usageApp(handler: (c: Context) => Response | Promise<Response>) {
  const app = new Hono()
  app.use(requestLogger)
  app.post("/", handler)
  return app
}

function responseReader(response: Response) {
  if (!response.body) throw new Error("Missing streaming fixture body")
  return response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
}

async function expectUsage(input: number, output: number, requests: number) {
  const response = await getUsageResponse()
  expect(response.lifetime).toMatchObject({
    total_input_tokens: input,
    total_output_tokens: output,
    total_requests: requests,
  })
  expect(response.twenty_four_hour).toMatchObject({
    total_input_tokens: input,
    total_output_tokens: output,
    request_count: requests,
  })
}

function saturatedPayload(): ChatCompletionsPayload {
  return {
    model: "fixture-model",
    messages: [{ role: "user", content: "hello" }],
    tools: Array.from({ length: 44 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: "Fixture tool",
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 12 }, (_, property) => [
              `arg_${property}`,
              {
                type: "string",
                description: "Fixture argument",
                enum: ["a", "b", "c", "d"],
              },
            ]),
          ),
          required: ["arg_0"],
        },
      },
    })),
  }
}

const model: Model = {
  id: "fixture-model",
  name: "Fixture Model",
  object: "model",
  version: "1",
  capabilities: {
    family: "fixture",
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
}

test("SSE records final observed usage once instead of a saturated schema estimate", async () => {
  const payload = saturatedPayload()
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(64 * 1024)
  const count = await getTokenCount(payload, model)
  expect(count.input).toBe(Number.MAX_SAFE_INTEGER)
  const finish = Promise.withResolvers<undefined>()
  const app = usageApp((c) => {
    setRequestContext(c, { estimatedInputTokens: count.input })
    return streamSSE(c, async (stream) => {
      await finish.promise
      await stream.writeSSE({ data: "unchanged response" })
      setRequestContext(c, { inputTokens: 120, outputTokens: 5 })
    })
  })
  const response = await app.request("/", { method: "POST" })
  const body = response.text()
  try {
    await expectUsage(0, 0, 0)
    expect(logs.mock.calls.flat().join("\n")).not.toContain(
      Number.MAX_SAFE_INTEGER.toLocaleString(),
    )
  } finally {
    finish.resolve(undefined)
  }
  expect(await body).toBe("data: unchanged response\n\n")
  await expectUsage(120, 5, 1)
  await expectUsage(120, 5, 1)
})

test("an estimate remains diagnostic and a response with no usage is uncharged", async () => {
  const app = usageApp((c) => {
    setRequestContext(c, { estimatedInputTokens: 321 })
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: "no usage provided" })
    })
  })
  const response = await app.request("/", { method: "POST" })
  await response.text()
  await expectUsage(0, 0, 0)
  expect(logs.mock.calls.flat().join("\n")).toContain("321")
})

test("buffered observed usage is available immediately and counts real zero usage", async () => {
  const app = usageApp((c) => {
    setRequestContext(c, { inputTokens: 0, outputTokens: 0 })
    return c.json({ usage: { input_tokens: 0, output_tokens: 0 } })
  })
  const response = await app.request("/", { method: "POST" })
  await expectUsage(0, 0, 1)
  expect(await response.json()).toEqual({
    usage: { input_tokens: 0, output_tokens: 0 },
  })
  await expectUsage(0, 0, 1)
})

test("buffered responses preserve valid output when input usage is invalid", async () => {
  const app = usageApp((c) => {
    setRequestContext(c, {
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 7,
    })
    return c.json({ content: "unchanged" })
  })
  const response = await app.request("/", { method: "POST" })
  await expectUsage(0, 7, 1)
  expect(await response.json()).toEqual({ content: "unchanged" })
})

test("SSE preserves chunk identity and backpressure before collecting usage", async () => {
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
  let pulls = 0
  const app = usageApp((c) => {
    setRequestContext(c, { inputTokens: 12, outputTokens: 4 })
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const value = chunks.at(pulls++)
          if (value === undefined) controller.close()
          else controller.enqueue(value)
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(body, {
      status: 201,
      statusText: "Fixture",
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "x-fixture": "kept",
      },
    })
  })
  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(201)
  expect(response.statusText).toBe("Fixture")
  expect(response.headers.get("x-fixture")).toBe("kept")
  expect(pulls).toBe(0)
  await expectUsage(0, 0, 0)
  const reader = responseReader(response)
  expect((await reader.read()).value).toBe(chunks[0])
  expect(pulls).toBe(1)
  expect((await reader.read()).value).toBe(chunks[1])
  expect(pulls).toBe(2)
  expect((await reader.read()).done).toBe(true)
  await expectUsage(12, 4, 1)
})

test("cancellation waits for source cleanup and records fresh usage at most once", async () => {
  const cleanup = Promise.withResolvers<undefined>()
  const pulling = Promise.withResolvers<undefined>()
  const reason = new Error("client disconnected")
  let receivedReason: unknown
  const app = usageApp((c) => {
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulling.resolve(undefined)
          return cleanup.promise
        },
        async cancel(value: unknown) {
          receivedReason = value
          await cleanup.promise
          setRequestContext(c, { inputTokens: 17, outputTokens: 2 })
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })
  })
  const response = await app.request("/", { method: "POST" })
  const reader = responseReader(response)
  const read = reader.read()
  await pulling.promise
  const cancelled = reader.cancel(reason)
  try {
    await expectUsage(0, 0, 0)
  } finally {
    cleanup.resolve(undefined)
  }
  await cancelled
  expect((await read).done).toBe(true)
  expect(receivedReason).toBe(reason)
  await expectUsage(17, 2, 1)
  await reader.cancel(reason)
  await expectUsage(17, 2, 1)
})

test("SSE errors propagate unchanged after collecting the last observed usage", async () => {
  const failure = new Error("upstream failed")
  const app = usageApp((c) => {
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          setRequestContext(c, { inputTokens: 19, outputTokens: 3 })
          controller.error(failure)
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })
  })
  const response = await app.request("/", { method: "POST" })
  await expectUsage(0, 0, 0)
  expect(await response.text().catch((error: unknown) => error)).toBe(failure)
  await expectUsage(19, 3, 1)
})

test("custom token-count endpoint returns an estimate without charging inference usage", async () => {
  setModelRedirectsForTest([])
  setConfigForTest({
    customProviders: [
      {
        id: "count-fixture",
        name: "Count Fixture",
        type: "openai-compatible",
        baseUrl: "https://unused.example/v1",
        apiKey: "fixture-key",
        models: [{ id: "count-model", kind: "chat" }],
      },
    ],
  })
  state.models = undefined
  const app = usageApp(handleCountTokens)
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "count-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "Hello" }],
    }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { input_tokens: number }
  expect(body.input_tokens).toBeGreaterThan(0)
  await expectUsage(0, 0, 0)
})
