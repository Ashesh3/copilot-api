/* eslint-disable @typescript-eslint/require-await -- Deterministic async upstream fixtures. */
import { expect, test } from "bun:test"

import type { ObservedRequestUsage } from "~/lib/request-usage"
import type { ManagedWebRequest, WebEvent } from "~/services/web/tool-loop"

import { runWithRequestUsageObserver } from "~/lib/request-usage"
import { runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

async function* frames(
  values: Array<Record<string, unknown> | string>,
): AsyncGenerator<WebEvent> {
  for (const value of values)
    yield { data: typeof value === "string" ? value : JSON.stringify(value) }
}

async function consume(
  options: ManagedWebRequest,
  checkpoints: Array<ObservedRequestUsage>,
) {
  const response = await runWithRequestUsageObserver(
    (usage) => checkpoints.push(usage),
    () => runWithWebTools(options.payload, () => runManagedWebRequest(options)),
  )
  if (!isWebStream(response)) throw new Error("Expected managed stream")
  // Deliberately outside both creator scopes, as with transport stream callbacks.
  for await (const _event of response) {
    /* drain */
  }
}

const webBlock = {
  type: "tool_use",
  id: "call",
  name: "_copilot_web_search",
  input: { query: "news" },
}
const messagesFirst = [
  {
    type: "message_start",
    message: { id: "m1", usage: { input_tokens: 10, output_tokens: 0 } },
  },
  { type: "content_block_start", index: 0, content_block: webBlock },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 4 },
  },
  { type: "message_stop" },
]

test("suppressed second Messages start publishes new input before source failure", async () => {
  const checkpoints: Array<ObservedRequestUsage> = []
  let sends = 0
  expect(
    await consume(
      {
        protocol: "messages",
        payload: { messages: [], stream: true },
        send: async () =>
          ++sends === 1 ?
            frames(messagesFirst)
          : (async function* () {
              yield* frames([
                {
                  type: "message_start",
                  message: {
                    id: "m2",
                    usage: {
                      input_tokens: 20,
                      cache_read_input_tokens: 3,
                      output_tokens: 0,
                    },
                  },
                },
              ])
              throw new Error("downstream closed")
            })(),
        execute: async () => ({ text: "remote", isError: false }),
      },
      checkpoints,
    ).catch((error: unknown) => error),
  ).toEqual(new Error("downstream closed"))
  expect(checkpoints.at(-1)).toMatchObject({ inputTokens: 33, outputTokens: 4 })
})

test("usage is checkpointed before malformed Messages tool arguments throw", async () => {
  const checkpoints: Array<ObservedRequestUsage> = []
  expect(
    await consume(
      {
        protocol: "messages",
        payload: { messages: [], stream: true },
        send: async () =>
          frames([
            ...messagesFirst.slice(0, 2),
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "{" },
            },
            ...messagesFirst.slice(2),
          ]),
        execute: async () => {
          throw new Error("must not execute malformed arguments")
        },
      },
      checkpoints,
    ).catch((error: unknown) =>
      error instanceof Error ? error.message : error,
    ),
  ).toBe("Malformed tool arguments.")
  expect(checkpoints.at(-1)).toMatchObject({ inputTokens: 10, outputTokens: 4 })
})

test("Chat trailing usage-only frame is checkpointed before executing the helper", async () => {
  const checkpoints: Array<ObservedRequestUsage> = []
  const failure = new Error("helper interrupted")
  expect(
    await consume(
      {
        protocol: "chat",
        payload: { messages: [], stream: true },
        send: async () =>
          frames([
            {
              id: "c1",
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
                          arguments: '{"query":"news"}',
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
            {
              id: "c1",
              choices: [],
              usage: { prompt_tokens: 9, completion_tokens: 3 },
            },
            "[DONE]",
          ]),
        execute: async () => {
          expect(checkpoints.at(-1)).toMatchObject({
            inputTokens: 9,
            outputTokens: 3,
          })
          throw failure
        },
      },
      checkpoints,
    ).catch((error: unknown) => error),
  ).toBe(failure)
  expect(checkpoints.at(-1)).toMatchObject({ inputTokens: 9, outputTokens: 3 })
})

test.each([
  { type: "response.failed", status: undefined },
  { type: "response.completed", status: "failed" },
])("failed Responses never add their own usage: %p", async (terminal) => {
  const checkpoints: Array<ObservedRequestUsage> = []
  let sends = 0
  const call = {
    type: "function_call",
    id: "web",
    call_id: "web",
    name: "_copilot_web_search",
    arguments: '{"query":"news"}',
  }
  await consume(
    {
      protocol: "responses",
      payload: { input: "open page", stream: true },
      send: async () => {
        const first = ++sends === 1
        return frames([
          {
            type: "response.created",
            response: {
              id: `r${sends}`,
              usage: { input_tokens: 999, output_tokens: 999 },
            },
          },
          ...(first ?
            [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: call,
              },
            ]
          : []),
          {
            type: first ? "response.completed" : terminal.type,
            response: {
              id: `r${sends}`,
              status: first ? "completed" : terminal.status,
              output: first ? [call] : [],
              usage: {
                input_tokens: first ? 10 : 20,
                output_tokens: first ? 4 : 6,
              },
            },
          },
        ])
      },
      execute: async () => ({ text: "remote", isError: false }),
    },
    checkpoints,
  )
  expect(checkpoints.at(-1)).toMatchObject({ inputTokens: 10, outputTokens: 4 })
})
