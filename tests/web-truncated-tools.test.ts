/* eslint-disable @typescript-eslint/require-await -- Deterministic asynchronous protocol fixtures. */
import { expect, test } from "bun:test"

import type { ObservedRequestUsage } from "~/lib/request-usage"
import type { WebProtocol } from "~/services/web/tool-context"
import type { WebEvent, WebResponse } from "~/services/web/tool-loop"

import { runWithRequestUsageObserver } from "~/lib/request-usage"
import { isRecord, runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"
import { records } from "~/services/web/tool-output"

type Protocol = Extract<WebProtocol, "messages" | "chat">
const text = { type: "text", text: "partial answer" }
const thinking = {
  type: "thinking",
  thinking: "reasoning",
  signature: "signed",
}
const owned = {
  type: "tool_use",
  id: "web",
  name: "_copilot_web_search",
  input: { query: "news" },
}
const client = {
  type: "tool_use",
  id: "client",
  name: "read_file",
  input: { path: "README" },
}
const chatOwned = {
  type: "function",
  id: "web",
  function: { name: "_copilot_web_search", arguments: '{"query":' },
}
const chatClient = {
  type: "function",
  id: "client",
  function: { name: "read_file", arguments: '{"path":' },
}

async function* frames(
  values: Array<Record<string, unknown> | string>,
): AsyncGenerator<WebEvent> {
  for (const value of values)
    yield { data: typeof value === "string" ? value : JSON.stringify(value) }
}

function buffered(
  protocol: Protocol,
  complete = false,
): Record<string, unknown> {
  return protocol === "messages" ?
      {
        id: "m1",
        content: [text, thinking, owned, client],
        stop_reason: complete ? "tool_use" : "max_tokens",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      }
    : {
        id: "c1",
        choices: [
          {
            index: 0,
            finish_reason: complete ? "tool_calls" : "length",
            message: {
              role: "assistant",
              content: "partial answer",
              encrypted_content: "encrypted",
              tool_calls: [chatOwned, chatClient],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }
}

function streamed(
  protocol: Protocol,
  round = 0,
  malformed = true,
): AsyncIterable<WebEvent> {
  if (protocol === "messages")
    return frames([
      {
        type: "message_start",
        message: {
          id: `m${round}`,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: text },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: thinking },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { ...owned, input: {} },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: {
          type: "input_json_delta",
          partial_json: malformed ? '{"query":' : '{"query":"news"}',
        },
      },
      { type: "content_block_stop", index: 2 },
      {
        type: "content_block_start",
        index: 3,
        content_block: { ...client, input: {} },
      },
      {
        type: "content_block_delta",
        index: 3,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
      { type: "content_block_stop", index: 3 },
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ])
  return frames([
    {
      id: `c${round}`,
      choices: [
        {
          index: 0,
          delta: {
            content: "partial answer",
            encrypted_content: "encrypted",
            tool_calls: [
              { ...chatOwned, index: 0 },
              { ...chatClient, index: 1 },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: `c${round}`,
      choices: [{ index: 0, delta: {}, finish_reason: "length" }],
    },
    {
      id: `c${round}`,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    },
    "[DONE]",
  ])
}

async function collect(
  response: WebResponse,
): Promise<Array<Record<string, unknown> | string>> {
  if (!isWebStream(response)) throw new Error("Expected stream")
  const output: Array<Record<string, unknown> | string> = []
  for await (const event of response)
    if (event.data)
      output.push(
        event.data === "[DONE]" ?
          event.data
        : (JSON.parse(event.data) as Record<string, unknown>),
      )
  return output
}

test.each<Protocol>(["messages", "chat"])(
  "buffered %s preserves truncation without executing managed calls",
  async (protocol) => {
    const payload = {
      messages: [],
      tools:
        protocol === "messages" ?
          [{ name: "read_file", input_schema: {} }]
        : [
            {
              type: "function",
              function: { name: "read_file", parameters: {} },
            },
          ],
    }
    let sends = 0
    let executes = 0
    const response = await runWithWebTools(payload, () =>
      runManagedWebRequest({
        protocol,
        payload,
        send: async () => {
          sends++
          return buffered(protocol)
        },
        execute: async () => {
          executes++
          return { text: "must not run", isError: false }
        },
      }),
    )
    expect(sends).toBe(1)
    expect(executes).toBe(0)
    expect(JSON.stringify(response)).not.toContain("_copilot_web_search")
    if (protocol === "messages")
      expect(response).toEqual({
        ...buffered(protocol),
        content: [text, thinking, client],
      })
    else
      expect(response).toMatchObject({
        choices: [
          {
            finish_reason: "length",
            message: {
              content: "partial answer",
              encrypted_content: "encrypted",
              tool_calls: [chatClient],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
  },
)

test.each<Protocol>(["messages", "chat"])(
  "streaming %s preserves truncation, partial client calls, and measured usage",
  async (protocol) => {
    let sends = 0
    let executes = 0
    const checkpoints: Array<ObservedRequestUsage> = []
    const payload = { messages: [], stream: true }
    const output = await runWithRequestUsageObserver(
      (value) => checkpoints.push(value),
      () =>
        runWithWebTools(payload, async () =>
          collect(
            await runManagedWebRequest({
              protocol,
              payload,
              send: async () => {
                sends++
                return streamed(protocol)
              },
              execute: async () => {
                executes++
                return { text: "must not run", isError: false }
              },
            }),
          ),
        ),
    ).catch((error: unknown) => error)
    expect(output).not.toBeInstanceOf(Error)
    expect(sends).toBe(1)
    expect(executes).toBe(0)
    expect(JSON.stringify(output)).not.toContain("_copilot_web_search")
    if (!Array.isArray(output)) throw new Error("Expected output events")
    const values = output.filter((value) => isRecord(value))
    if (protocol === "messages") {
      expect(
        values.filter((value) => value.type === "message_stop"),
      ).toHaveLength(1)
      expect(
        values.find((value) => value.type === "message_delta"),
      ).toMatchObject({
        delta: { stop_reason: "max_tokens" },
        usage: { input_tokens: 10, output_tokens: 4 },
      })
      expect(
        values
          .filter((value) => value.type === "content_block_start")
          .map((value) => value.index),
      ).toEqual([0, 1, 2])
      expect(
        values.find(
          (value) => value.type === "content_block_delta" && value.index === 2,
        ),
      ).toMatchObject({ delta: { partial_json: '{"path":' } })
    } else {
      expect(output.filter((value) => value === "[DONE]")).toHaveLength(1)
      const choices = values.flatMap((value) => records(value.choices))
      expect(choices.filter((choice) => choice.finish_reason)).toMatchObject([
        { finish_reason: "length" },
      ])
      expect(
        choices.flatMap((choice) =>
          isRecord(choice.delta) ? records(choice.delta.tool_calls) : [],
        ),
      ).toEqual([{ ...chatClient, index: 0 }])
      expect(values.find((value) => value.usage)).toMatchObject({
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    }
    expect(checkpoints.at(-1)).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
    })
  },
)

test("Messages token-limit outcome wins even if managed JSON is valid but client JSON is unfinished", async () => {
  const payload = { messages: [], stream: true }
  let executes = 0
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "messages",
        payload,
        send: async () => streamed("messages", 0, false),
        execute: async () => {
          executes++
          return { text: "forbidden", isError: false }
        },
      }),
    ),
  ).catch((error: unknown) => error)
  expect(output).not.toBeInstanceOf(Error)
  expect(executes).toBe(0)
  expect(JSON.stringify(output)).toContain("max_tokens")
})

test.each<Protocol>(["messages", "chat"])(
  "%s truncation after a completed managed round keeps cumulative usage",
  async (protocol) => {
    const payload = { messages: [], stream: true }
    let sends = 0
    let executes = 0
    const output = await runWithWebTools(payload, async () =>
      collect(
        await runManagedWebRequest({
          protocol,
          payload,
          send: async () => {
            if (++sends > 1) return streamed(protocol, sends)
            return protocol === "messages" ?
                frames([
                  {
                    type: "message_start",
                    message: {
                      id: "first",
                      usage: { input_tokens: 2, output_tokens: 0 },
                    },
                  },
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: owned,
                  },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "message_delta",
                    delta: { stop_reason: "tool_use" },
                    usage: { output_tokens: 3 },
                  },
                  { type: "message_stop" },
                ])
              : frames([
                  {
                    id: "first",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              ...chatOwned,
                              index: 0,
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
                    id: "first",
                    choices: [],
                    usage: { prompt_tokens: 2, completion_tokens: 3 },
                  },
                  "[DONE]",
                ])
          },
          execute: async () => {
            executes++
            return { text: "known evidence", isError: false }
          },
        }),
      ),
    ).catch((error: unknown) => error)
    expect(output).not.toBeInstanceOf(Error)
    expect(sends).toBe(2)
    expect(executes).toBe(1)
    if (!Array.isArray(output)) throw new Error("Expected event list")
    const values = output.filter((value) => isRecord(value))
    const terminal = values.find((value) =>
      protocol === "messages" ?
        value.type === "message_delta"
      : isRecord(value.usage),
    )
    expect(terminal).toMatchObject({
      usage:
        protocol === "messages" ?
          { input_tokens: 12, output_tokens: 7 }
        : { prompt_tokens: 12, completion_tokens: 7 },
    })
  },
)
