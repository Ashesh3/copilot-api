/* eslint-disable @typescript-eslint/require-await -- Deterministic asynchronous transport fixtures. */
import { expect, test } from "bun:test"

import type { WebEvent } from "~/services/web/tool-loop"

import { runWithWebTools, type WebProtocol } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

const tool = {
  type: "function_call",
  id: "web-item",
  call_id: "web",
  name: "_copilot_web_search",
  arguments: '{"query":"news"}',
}
async function* frames(
  value: Record<string, unknown>,
): AsyncGenerator<WebEvent> {
  yield { data: JSON.stringify(value) }
}

test.each([false, true])(
  "effective continuation payload is snapshotted after each successful send (stream=%s)",
  async (stream) => {
    const payload = {
      input: "open",
      temperature: 0.7,
      stream,
      metadata: { original: true },
    }
    const snapshot = structuredClone(payload)
    const requests: Array<Record<string, unknown>> = []
    const response = await runWithWebTools(payload, () =>
      runManagedWebRequest({
        protocol: "responses",
        payload,
        send: async (body, _managed, report) => {
          requests.push(structuredClone(body))
          const final = requests.length === 3
          const accepted: Record<string, unknown> & {
            metadata: { acceptedRound: number }
          } = {
            ...body,
            metadata: { acceptedRound: requests.length },
          }
          delete accepted.temperature
          const reportAccepted = () => {
            report(accepted)
            // Later caller-side mutation cannot rewrite the accepted snapshot.
            accepted.metadata.acceptedRound = 999
          }
          const result = {
            id: `r${requests.length}`,
            status: "completed",
            output: final ? [] : [tool],
            usage: { input_tokens: 1, output_tokens: 2 },
          }
          if (!stream) {
            reportAccepted()
            return result
          }
          return (async function* () {
            // Lazy transports may report the accepted body during consumption.
            reportAccepted()
            if (!final)
              yield* frames({
                type: "response.output_item.added",
                output_index: 0,
                item: tool,
              })
            yield* frames({ type: "response.completed", response: result })
          })()
        },
        execute: async () => ({ text: "remote", isError: false }),
      }),
    )
    if (isWebStream(response))
      for await (const _event of response) {
        /* drain */
      }
    expect(requests).toHaveLength(3)
    expect(requests[0]).toHaveProperty("temperature", 0.7)
    expect(requests[1]).not.toHaveProperty("temperature")
    expect(requests[2]).not.toHaveProperty("temperature")
    expect(requests[1].metadata).toEqual({ acceptedRound: 1 })
    expect(requests[2].metadata).toEqual({ acceptedRound: 2 })
    expect(requests[2].input).toMatchObject([
      { role: "user", content: "open" },
      tool,
      { type: "function_call_output" },
      tool,
      { type: "function_call_output" },
    ])
    expect(payload).toEqual(snapshot)
  },
)

test.each<WebProtocol>(["messages", "chat", "responses"])(
  "buffered %s without managed intervention preserves upstream usage verbatim",
  async (protocol) => {
    const payload = { model: "fixture", messages: [], input: "hello" }
    const upstream = {
      id: "response",
      status: "completed",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "answer" }],
      output: [],
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "answer" },
        },
      ],
      usage: {
        input_tokens: "12",
        cache_read_input_tokens: -1,
        output_tokens: 7,
      },
    }
    const response = await runWithWebTools(payload, () =>
      runManagedWebRequest({ protocol, payload, send: async () => upstream }),
    )
    expect(response).toEqual(upstream)
  },
)

test("a transparent buffered result still honors cancellation during its send", async () => {
  const abort = new AbortController()
  const reason = new DOMException("client disconnected", "AbortError")
  const payload = { input: "hello" }
  const result = await runWithWebTools(payload, () =>
    runManagedWebRequest({
      protocol: "responses",
      payload,
      signal: abort.signal,
      send: async () => {
        abort.abort(reason)
        return { status: "completed", output: [] }
      },
    }),
  ).catch((error: unknown) => error)
  expect(result).toBe(reason)
})
