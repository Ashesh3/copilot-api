/* eslint-disable @typescript-eslint/require-await -- Deterministic asynchronous protocol fixtures. */
import { expect, test } from "bun:test"

import type { WebEvent } from "~/services/web/tool-loop"

import { isRecord, runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

const web = {
  type: "function_call",
  id: "web-item",
  call_id: "web",
  name: "_copilot_web_search",
  arguments: '{"query":"news"}',
}
const calls = [
  {
    type: "computer_call",
    id: "computer-item",
    call_id: "computer",
    action: { type: "click", x: 12, y: 34 },
    pending_safety_checks: [{ id: "check", code: "test", message: "retain" }],
    status: "completed",
  },
  {
    type: "apply_patch_call",
    id: "patch-item",
    call_id: "patch",
    operation: { type: "create_file", path: "README", diff: "+hello" },
    status: "completed",
  },
]

async function* frames(
  client: Record<string, unknown>,
): AsyncGenerator<WebEvent> {
  for (const value of [
    { type: "response.created", response: { id: "root" } },
    { type: "response.output_item.added", output_index: 0, item: web },
    { type: "response.output_item.done", output_index: 0, item: web },
    { type: "response.output_item.added", output_index: 1, item: client },
    { type: "response.output_item.done", output_index: 1, item: client },
    {
      type: "response.completed",
      response: {
        id: "root",
        status: "completed",
        output: [web, client],
        usage: { input_tokens: 5, output_tokens: 6 },
      },
    },
  ])
    yield { data: JSON.stringify(value) }
}

for (const stream of [false, true])
  test.each(calls)(
    `Responses ${stream ? "stream" : "buffered"} returns mixed native client calls: %p`,
    async (client) => {
      const payload = { input: "open page", stream }
      let sends = 0
      let executes = 0
      const response = await runWithWebTools(payload, () =>
        runManagedWebRequest({
          protocol: "responses",
          payload,
          send: async () => {
            if (++sends > 1)
              throw new Error("must return the client call before continuation")
            return stream ?
                frames(client)
              : {
                  id: "root",
                  status: "completed",
                  output: [web, client],
                  usage: { input_tokens: 5, output_tokens: 6 },
                }
          },
          execute: async () => {
            executes++
            return { text: "known evidence", isError: false }
          },
        }),
      )
      let result: unknown = response
      const events: Array<Record<string, unknown>> = []
      if (isWebStream(response)) {
        for await (const event of response) {
          const value: unknown = JSON.parse(event.data ?? "{}")
          if (isRecord(value)) events.push(value)
        }
        result = events.find(
          (value) => value.type === "response.completed",
        )?.response
        expect(
          events
            .filter((value) => value.type === "response.output_item.added")
            .map((value) => value.output_index),
        ).toEqual([0, 1])
      }
      expect(sends).toBe(1)
      expect(executes).toBe(1)
      expect(result).toMatchObject({
        id: "root",
        status: "completed",
        output: [{ type: "message" }, client],
        usage: { input_tokens: 5, output_tokens: 6 },
      })
    },
  )
