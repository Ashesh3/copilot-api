/* eslint-disable @typescript-eslint/require-await -- Deterministic transport and request-lifecycle fixtures. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import type { WebEvent } from "~/services/web/tool-loop"

import { requestLogger, setRequestContext } from "~/lib/request-logger"
import { getHistoryRuntime } from "~/lib/telemetry-writer"
import {
  enableDatabaseUsageForTest,
  resetUsageForTest,
} from "~/lib/usage-tracker"
import {
  createResponsesWebSocketTurn,
  finalizeResponsesWebSocketTurn,
  runWithWebSocketRequestContext,
} from "~/routes/responses/websocket-lifecycle"
import { runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()
let logs: ReturnType<typeof spyOn<typeof console, "log">>
beforeEach(() => {
  resetUsageForTest()
  enableDatabaseUsageForTest()
  logs = spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  logs.mockRestore()
  enableDatabaseUsageForTest()
})

async function* invalidSnapshotRound(): AsyncGenerator<WebEvent> {
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
    { type: "message_delta", delta: {}, usage: { output_tokens: 4 } },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { cache_read_input_tokens: null, output_tokens: null },
    },
    { type: "message_stop" },
  ])
    yield { data: JSON.stringify(value) }
}

async function* finalRound(): AsyncGenerator<WebEvent> {
  for (const value of [
    {
      type: "message_start",
      message: { id: "m2", usage: { input_tokens: 2, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "answer" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ])
    yield { data: JSON.stringify(value) }
}

async function expectStoredUsage(inputTokens: number, outputTokens: number) {
  const runtime = getHistoryRuntime()
  await runtime.writer.flush()
  expect((await runtime.repository.readUsageTotals(0)).lifetime).toMatchObject({
    inputTokens,
    outputTokens,
    requestCount: 1,
  })
  expect((await runtime.repository.collectionStatus()).unknownGaps).toBe(1)
}

test("HTTP cancellation retains prior same-round measurements after invalid Messages deltas", async () => {
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
        send: async () => invalidSnapshotRound(),
        execute: async () => {
          executing.resolve(undefined)
          await release.promise
          controller.signal.throwIfAborted()
          return { text: "unused", isError: false }
        },
      }),
    )
    if (!isWebStream(response)) throw new Error("Expected managed stream")
    return streamSSE(c, async (stream) => {
      stream.onAbort(() =>
        controller.abort(new DOMException("cancelled", "AbortError")),
      )
      try {
        for await (const event of response) {
          setRequestContext(c, {
            inputTokens: 999,
            outputTokens: 0,
            model: "fixture",
          })
          await stream.writeSSE({ data: event.data ?? "" })
        }
      } catch {
        /* cancelled source */
      } finally {
        setRequestContext(c, { inputTokens: 999, outputTokens: 0 })
        producerDone.resolve(undefined)
      }
    })
  })
  const response = await app.request("/", { method: "POST" })
  if (!response.body) throw new Error("Missing response body")
  const reader = response.body.getReader()
  const draining = (async () => {
    while (!(await reader.read()).done) {
      /* drain */
    }
  })()
  await executing.promise
  await reader.cancel()
  try {
    await expectStoredUsage(15, 4)
  } finally {
    release.resolve(undefined)
    await producerDone.promise
    await draining
  }
  await expectStoredUsage(15, 4)
})

test("WebSocket finalization records retained snapshot usage once across a continuation", async () => {
  const payload = { model: "fixture", messages: [], stream: true }
  const data = {
    activeTurns: new Map(),
    nextTurnSequence: 0,
    requestId: "invalid-snapshot-ws",
  }
  const turn = createResponsesWebSocketTurn(data, "{}")
  turn.model = "fixture"
  let sends = 0
  const response = await runWithWebSocketRequestContext(
    undefined,
    {},
    turn,
    () =>
      runWithWebTools(payload, () =>
        runManagedWebRequest({
          protocol: "messages",
          payload,
          send: async () =>
            ++sends === 1 ? invalidSnapshotRound() : finalRound(),
          execute: async () => ({ text: "remote", isError: false }),
        }),
      ),
  )
  if (!isWebStream(response)) throw new Error("Expected managed stream")
  for await (const _event of response) {
    /* consume outside the creator scope, as the transport does */
  }
  expect(sends).toBe(2)
  expect(turn.managedUsage).toEqual({
    inputTokens: 17,
    outputTokens: 5,
    unknownTokenCount: true,
  })
  await turn.terminal.succeed({
    kind: "completed",
    status: 200,
    terminalStatus: "COMPLETE",
    usage: { input_tokens: 999, output_tokens: 0 },
  })
  finalizeResponsesWebSocketTurn(data, turn, {
    status: 200,
    terminalStatus: "COMPLETE",
  })
  await expectStoredUsage(17, 5)
})
