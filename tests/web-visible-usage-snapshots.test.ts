/* eslint-disable @typescript-eslint/require-await -- Deterministic upstream stream fixtures. */
import { expect, test } from "bun:test"

import type { WebEvent } from "~/services/web/tool-loop"

import { isRecord, runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

async function* frames(
  values: Array<Record<string, unknown> | string>,
): AsyncGenerator<WebEvent> {
  for (const value of values)
    yield { data: typeof value === "string" ? value : JSON.stringify(value) }
}

for (const protocol of ["messages", "chat"] as const)
  test.each([null, -1, "bad"])(
    `${protocol} client-visible snapshots retain valid same-round counts before an invalid update (%p)`,
    async (invalid) => {
      const payload = { messages: [], stream: true }
      const before =
        protocol === "messages" ?
          { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 4 }
        : {
            prompt_tokens: 10,
            completion_tokens: 4,
            completion_tokens_details: { reasoning_tokens: 2 },
          }
      const after =
        protocol === "messages" ?
          {
            input_tokens: 7,
            cache_read_input_tokens: invalid,
            output_tokens: invalid,
          }
        : {
            prompt_tokens: 7,
            completion_tokens: invalid,
            completion_tokens_details: { reasoning_tokens: invalid },
          }
      const response = await runWithWebTools(payload, () =>
        runManagedWebRequest({
          protocol,
          payload,
          send: async () =>
            protocol === "messages" ?
              frames([
                {
                  type: "message_start",
                  message: { id: "root", usage: before },
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: {
                    type: "tool_use",
                    id: "web",
                    name: "_copilot_web_search",
                    input: {},
                  },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "message_delta",
                  delta: { stop_reason: "max_tokens" },
                  usage: after,
                },
                { type: "message_stop" },
              ])
            : frames([
                {
                  id: "root",
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "web",
                            type: "function",
                            function: {
                              name: "_copilot_web_search",
                              arguments: "{",
                            },
                          },
                        ],
                      },
                      finish_reason: "length",
                    },
                  ],
                  usage: before,
                },
                { id: "root", choices: [], usage: after },
                "[DONE]",
              ]),
        }),
      )
      if (!isWebStream(response)) throw new Error("Expected stream")
      const output: Array<Record<string, unknown>> = []
      for await (const event of response) {
        if (!event.data || event.data === "[DONE]") continue
        const value: unknown = JSON.parse(event.data)
        if (isRecord(value)) output.push(value)
      }
      const usage = output.find((value) => value.usage)?.usage
      expect(usage).toEqual(
        protocol === "messages" ?
          { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 4 }
        : {
            prompt_tokens: 7,
            completion_tokens: 4,
            completion_tokens_details: { reasoning_tokens: 2 },
          },
      )
    },
  )
