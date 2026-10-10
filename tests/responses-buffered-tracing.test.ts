import type { Span, SpanJSON } from "@sentry/core"

import * as Sentry from "@sentry/bun"
import { ServerRuntimeClient } from "@sentry/core"
import { expect, test } from "bun:test"
import { Hono } from "hono"

import type { ResponsesChatCompletionFactory } from "~/routes/responses/chat-fallback-completion"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import { handleWithChatCompletions } from "~/routes/responses/handler"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

interface RecordedChatSpans {
  started: Array<Span>
  ended: Array<SpanJSON>
}

async function withRecordedChatSpans(
  run: (spans: RecordedChatSpans) => Promise<void>,
): Promise<void> {
  const client = new ServerRuntimeClient({
    dsn: "https://public@example.invalid/1",
    integrations: [],
    stackParser: () => [],
    tracesSampleRate: 1,
    transport: () => ({
      send: () => Promise.resolve({ statusCode: 200 }),
      flush: () => Promise.resolve(true),
    }),
  })
  const spans: RecordedChatSpans = { started: [], ended: [] }
  client.on("spanStart", (span) => {
    if (Sentry.spanToJSON(span).op === "gen_ai.chat") spans.started.push(span)
  })
  client.on("spanEnd", (span) => {
    const completed = Sentry.spanToJSON(span)
    if (completed.op === "gen_ai.chat") spans.ended.push(completed)
  })
  try {
    await Sentry.withScope(async (scope) => {
      scope.setClient(client)
      await run(spans)
    })
  } finally {
    await client.close(1000)
  }
}

function completion(): ChatCompletionResponse {
  return {
    id: "chat-traced",
    object: "chat.completion",
    created: 1,
    model: "trace-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Buffered answer" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 5,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 4 },
    },
  }
}

function createApp(
  completionFactory: ResponsesChatCompletionFactory,
  options: { compactionTrigger?: boolean; stream?: boolean } = {},
) {
  const app = new Hono()
  app.onError((_error, c) => c.json({ error: "Provider failed" }, 502))
  app.post(
    "/",
    async (c) =>
      await handleWithChatCompletions(
        c,
        {
          model: "trace-model",
          messages: [{ role: "user", content: "Private input" }],
          stream: options.stream ?? true,
        },
        {
          bufferResponse: true,
          compactionTrigger: options.compactionTrigger,
          completionFactory,
          requestedModel: "public-model",
        },
      ),
  )
  return app
}

test.each([false, true])(
  "records the buffered Chat span and usage for client stream=%s",
  async (stream) => {
    await withRecordedChatSpans(async ({ started, ended }) => {
      let upstreamSpan: Span | undefined
      const app = createApp(
        (payload) => {
          upstreamSpan = Sentry.getActiveSpan()
          expect(payload.stream).toBe(false)
          return Promise.resolve({
            processedPayload: payload,
            response: completion(),
          })
        },
        { stream },
      )
      const response = await app.request("/", { method: "POST" })

      // The span covers upstream execution and finishes before SSE delivery.
      expect(started).toHaveLength(1)
      expect(upstreamSpan).toBe(started[0])
      expect(ended).toHaveLength(1)
      expect(ended[0].data).toMatchObject({
        "gen_ai.request.model": "trace-model",
        "gen_ai.response.model": "trace-model",
        "gen_ai.usage.input_tokens": 11,
        "gen_ai.usage.output_tokens": 5,
        "gen_ai.usage.input_tokens.cached": 4,
      })
      expect(ended[0].data["gen_ai.response.streaming"]).toBe(
        stream ? true : undefined,
      )
      expect(JSON.stringify(ended[0])).not.toContain("Private input")
      expect(JSON.stringify(ended[0])).not.toContain("Buffered answer")
      const body = await response.text()
      expect(body).toContain("Buffered answer")
      if (stream) expect(body).toContain("event: response.completed")
      expect(ended).toHaveLength(1)
    })
  },
)

test("finishes the buffered SSE Chat span when the provider fails", async () => {
  await withRecordedChatSpans(async ({ started, ended }) => {
    const app = createApp(() => Promise.reject(new Error("Provider failed")))
    const response = await app.request("/", { method: "POST" })
    await response.text()

    expect(response.status).toBe(502)
    expect(started).toHaveLength(1)
    expect(ended).toHaveLength(1)
    expect(ended[0].status).toBe("internal_error")
  })
})

test("finishes the Chat span on abort before a pending provider settles", async () => {
  await withRecordedChatSpans(async ({ started, ended }) => {
    const admitted = Promise.withResolvers<undefined>()
    const upstream = Promise.withResolvers<ChatCompletionResponse>()
    const controller = new AbortController()
    const app = createApp(async (payload) => {
      admitted.resolve(undefined)
      return { processedPayload: payload, response: await upstream.promise }
    })
    const pending = app.request("/", {
      method: "POST",
      signal: controller.signal,
    })
    await admitted.promise
    controller.abort(new DOMException("Client disconnected", "AbortError"))
    try {
      expect(started).toHaveLength(1)
      expect(ended).toHaveLength(1)
      expect(ended[0].status).toBe("cancelled")
    } finally {
      upstream.reject(controller.signal.reason)
      await (await pending).text()
    }
    expect(ended).toHaveLength(1)
  })
})

test("leaves existing compaction span behavior unchanged", async () => {
  await withRecordedChatSpans(async ({ started, ended }) => {
    const app = createApp(
      (payload) =>
        Promise.resolve({
          processedPayload: payload,
          response: completion(),
        }),
      { compactionTrigger: true },
    )
    const response = await app.request("/", { method: "POST" })
    const body = await response.text()

    expect(body).toContain('"type":"compaction"')
    expect(body).toContain("event: response.completed")
    expect(started).toEqual([])
    expect(ended).toEqual([])
  })
})
