/* eslint-disable @typescript-eslint/require-await -- Deterministic transport and request-lifecycle fixtures. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import type { WebEvent } from "~/services/web/tool-loop"

import { requestLogger, setRequestContext } from "~/lib/request-logger"
import { getHistoryRuntime } from "~/lib/telemetry-writer"
import {
  enableDatabaseUsageForTest,
  getUsageResponse,
  resetUsageForTest,
} from "~/lib/usage-tracker"
import {
  createResponsesWebSocketTurn,
  finalizeResponsesWebSocketTurn,
  runWithWebSocketRequestContext,
} from "~/routes/responses/websocket-lifecycle"
import { runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()
let logs: ReturnType<typeof spyOn<typeof console, "log">>
beforeEach(() => {
  resetUsageForTest()
  logs = spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  logs.mockRestore()
  enableDatabaseUsageForTest()
})
async function* messagesRound(): AsyncGenerator<WebEvent> {
  for (const value of [
    {
      type: "message_start",
      message: {
        id: "m1",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
          output_tokens: 0,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "web",
        name: "_copilot_web_search",
        input: { query: "news" },
      },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ])
    yield { data: JSON.stringify(value) }
}
async function expectUsage(input: number, output: number, requests = 1) {
  expect((await getUsageResponse()).lifetime).toMatchObject({
    total_input_tokens: input,
    total_output_tokens: output,
    total_requests: requests,
  })
}

test("HTTP cancellation during managed execution records complete observed usage before cleanup", async () => {
  const executing = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const producerDone = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  const payload = { model: "fixture", messages: [], stream: true }
  const app = new Hono()
  app.use(requestLogger)
  app.post("/", async (c) => {
    const response = await runWithWebTools(payload, () =>
      runManagedWebRequest({
        protocol: "messages",
        payload,
        signal: controller.signal,
        send: async () => messagesRound(),
        execute: async () => {
          executing.resolve(undefined)
          await release.promise
          controller.signal.throwIfAborted()
          return { text: "unused", isError: false }
        },
      }),
    )
    if (!isWebStream(response)) throw new Error("Expected stream")
    return streamSSE(c, async (stream) => {
      stream.onAbort(() =>
        controller.abort(new DOMException("cancelled", "AbortError")),
      )
      try {
        for await (const event of response) {
          setRequestContext(c, {
            inputTokens: 15,
            outputTokens: 0,
            model: "fixture",
          })
          await stream.writeSSE({ data: event.data ?? "" })
        }
      } catch {
        /* cancelled source */
      } finally {
        setRequestContext(c, { inputTokens: 15, outputTokens: 0 })
        producerDone.resolve(undefined)
      }
    })
  })
  const response = await app.request("/", { method: "POST" })
  if (!response.body) throw new Error("Missing body")
  const reader = response.body.getReader()
  const draining = (async () => {
    while (!(await reader.read()).done) {
      /* drain */
    }
  })()
  await executing.promise
  await reader.cancel()
  try {
    await expectUsage(15, 4)
  } finally {
    release.resolve(undefined)
    await producerDone.promise
    await draining
  }
  await expectUsage(15, 4)
})

test.each(["throw", "failed", "incomplete", "completed"])(
  "HTTP managed usage survives second-round %s without double counting",
  async (outcome) => {
    const payload = { model: "fixture", input: "open page", stream: true }
    let sends = 0
    const app = new Hono()
    app.use(requestLogger)
    app.post("/", async (c) => {
      const response = await runWithWebTools(payload, () =>
        runManagedWebRequest({
          protocol: "responses",
          payload,
          send: async () => {
            if (++sends > 1 && outcome === "throw")
              throw new Error("second-round failure")
            const first = sends === 1
            const item = {
              type: "function_call",
              id: "web",
              call_id: "call",
              name: "_copilot_web_search",
              arguments: '{"query":"news"}',
            }
            return (async function* () {
              yield {
                data: JSON.stringify({
                  type: "response.created",
                  response: { id: `r${sends}` },
                }),
              }
              if (first)
                yield {
                  data: JSON.stringify({
                    type: "response.output_item.added",
                    output_index: 0,
                    item,
                  }),
                }
              yield {
                data: JSON.stringify({
                  type: first ? "response.completed" : `response.${outcome}`,
                  response: {
                    id: `r${sends}`,
                    status: first ? "completed" : outcome,
                    output: first ? [item] : [],
                    usage: {
                      input_tokens: first ? 10 : 20,
                      output_tokens: first ? 4 : 6,
                    },
                  },
                }),
              }
            })()
          },
          execute: async () => ({ text: "remote", isError: false }),
        }),
      )
      if (!isWebStream(response)) throw new Error("Expected stream")
      return streamSSE(c, async (stream) => {
        try {
          for await (const event of response)
            await stream.writeSSE({ data: event.data ?? "" })
        } catch {
          /* source failure does not erase prior usage */
        } finally {
          setRequestContext(c, {
            inputTokens: 0,
            outputTokens: 0,
            model: "fixture",
          })
        }
      })
    })
    await (await app.request("/", { method: "POST" })).text()
    const finalUsage = outcome === "completed" || outcome === "incomplete"
    await expectUsage(finalUsage ? 30 : 10, finalUsage ? 10 : 4)
  },
)

test("WebSocket finalization records managed checkpoint on abort exactly once", async () => {
  const data = {
    activeTurns: new Map(),
    nextTurnSequence: 0,
    requestId: "usage-ws",
  }
  const turn = createResponsesWebSocketTurn(data, "{}")
  turn.model = "fixture"
  const executing = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const payload = { model: "fixture", messages: [], stream: true }
  const response = await runWithWebSocketRequestContext(
    undefined,
    {},
    turn,
    () =>
      runWithWebTools(payload, () =>
        runManagedWebRequest({
          protocol: "messages",
          payload,
          signal: turn.abortController.signal,
          send: async () => messagesRound(),
          execute: async () => {
            executing.resolve(undefined)
            await release.promise
            turn.abortController.signal.throwIfAborted()
            return { text: "unused", isError: false }
          },
        }),
      ),
  )
  if (!isWebStream(response)) throw new Error("Expected stream")
  const consuming = (async () => {
    try {
      for await (const _event of response) {
        /* outside creator ALS */
      }
    } catch {
      /* abort */
    }
  })()
  await executing.promise
  turn.abortController.abort(new DOMException("closed", "AbortError"))
  finalizeResponsesWebSocketTurn(data, turn, {
    status: 499,
    terminalStatus: "ABORTED",
  })
  try {
    await expectUsage(15, 4)
  } finally {
    release.resolve(undefined)
    await consuming
  }
  finalizeResponsesWebSocketTurn(data, turn, {
    status: 499,
    terminalStatus: "ABORTED",
  })
  await expectUsage(15, 4)
})

test.each(["http", "websocket"])(
  "%s records known managed subtotals and an explicit collection gap once",
  async (transport) => {
    await seedProtocolDatabase()
    enableDatabaseUsageForTest()
    const payload = { model: "fixture", input: "open" }
    let sends = 0
    const work = () =>
      runWithWebTools(payload, () =>
        runManagedWebRequest({
          protocol: "responses",
          payload,
          send: async () =>
            ++sends === 1 ?
              {
                status: "completed",
                output: [
                  {
                    type: "function_call",
                    id: "web",
                    call_id: "web",
                    name: "_copilot_web_search",
                    arguments: '{"query":"news"}',
                  },
                ],
                usage: { input_tokens: 10, output_tokens: 4 },
              }
            : {
                status: "completed",
                output: [],
                usage: { input_tokens: null, output_tokens: 6 },
              },
          execute: async () => ({ text: "remote", isError: false }),
        }),
      )
    if (transport === "http") {
      const app = new Hono()
      app.use(requestLogger)
      app.post("/", async (c) => {
        await work()
        setRequestContext(c, {
          inputTokens: 0,
          outputTokens: 0,
          model: "fixture",
        })
        return c.json({ ok: true })
      })
      await (await app.request("/", { method: "POST" })).text()
    } else {
      const data = {
        activeTurns: new Map(),
        nextTurnSequence: 0,
        requestId: "invalid-usage-ws",
      }
      const turn = createResponsesWebSocketTurn(data, "{}")
      turn.model = "fixture"
      await runWithWebSocketRequestContext(undefined, {}, turn, work)
      await turn.terminal.succeed({
        kind: "completed",
        status: 200,
        terminalStatus: "COMPLETE",
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      finalizeResponsesWebSocketTurn(data, turn, {
        status: 200,
        terminalStatus: "COMPLETE",
      })
    }
    const runtime = getHistoryRuntime()
    await runtime.writer.flush()
    expect(
      (await runtime.repository.readUsageTotals(0)).lifetime,
    ).toMatchObject({ inputTokens: 10, outputTokens: 10, requestCount: 1 })
    expect((await runtime.repository.collectionStatus()).unknownGaps).toBe(1)
  },
)

test("WebSocket failure writer errors still finalize the captured usage", async () => {
  const data = {
    activeTurns: new Map(),
    nextTurnSequence: 0,
    requestId: "failed-writer",
  }
  const turn = createResponsesWebSocketTurn(data, "{}")
  const failure = {
    kind: "thrown" as const,
    error: new Error("upstream failed"),
  }
  turn.managedUsage = { inputTokens: 10, outputTokens: 4 }
  turn.failureWriters.set(failure, async () => {
    throw new Error("send failed")
  })
  expect(
    await turn.terminal.fail(failure).catch((error: unknown) => error),
  ).toEqual(new Error("send failed"))
  expect(data.activeTurns.size).toBe(0)
  await expectUsage(10, 4)
  finalizeResponsesWebSocketTurn(data, turn, {
    status: 500,
    terminalStatus: "ERROR",
  })
  await expectUsage(10, 4)
})

test("HTTP managed requests without reported usage cannot inherit transport estimates", async () => {
  const payload = { model: "fixture", input: "open" }
  const app = new Hono()
  app.use(requestLogger)
  app.post("/", async (c) => {
    let sends = 0
    await runWithWebTools(payload, () =>
      runManagedWebRequest({
        protocol: "responses",
        payload,
        send: async () => ({
          status: "completed",
          output:
            ++sends === 1 ?
              [
                {
                  type: "function_call",
                  call_id: "web",
                  name: "_copilot_web_search",
                  arguments: '{"query":"news"}',
                },
              ]
            : [],
        }),
        execute: async () => ({ text: "remote", isError: false }),
      }),
    )
    setRequestContext(c, { inputTokens: 100, outputTokens: 0 })
    return c.json({ ok: true })
  })
  await (await app.request("/", { method: "POST" })).text()
  await expectUsage(0, 0, 0)
})
