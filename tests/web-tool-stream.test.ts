/* eslint-disable @typescript-eslint/require-await -- Async transport fixtures intentionally resolve immediately. */
import { expect, test } from "bun:test"

import type { WebEvent, WebResponse } from "~/services/web/tool-loop"

import { runWithWebTools } from "~/services/web/tool-context"
import { runManagedWebRequest, isWebStream } from "~/services/web/tool-loop"

async function* events(
  values: Array<Record<string, unknown> | string>,
): AsyncGenerator<WebEvent> {
  for (const value of values)
    yield { data: typeof value === "string" ? value : JSON.stringify(value) }
}
async function collect(result: WebResponse) {
  if (!isWebStream(result)) throw new Error("Expected stream")
  const output: Array<Record<string, unknown> | string> = []
  for await (const event of result)
    if (event.data)
      output.push(
        event.data === "[DONE]" ?
          event.data
        : (JSON.parse(event.data) as Record<string, unknown>),
      )
  return output
}

test("Messages streams page-reading continuations with one terminal and preserved signed thinking", async () => {
  let sends = 0
  const payload = { model: "fixture", messages: [], stream: true }
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "messages",
        payload,
        send: async (next) => {
          sends++
          if (sends === 1)
            return events([
              {
                type: "message_start",
                message: {
                  id: "m1",
                  role: "assistant",
                  content: [],
                  usage: { input_tokens: 2, output_tokens: 0 },
                },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "thinking", thinking: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "thinking_delta", thinking: "think" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "signature_delta", signature: "sig" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "content_block_start",
                index: 1,
                content_block: {
                  type: "tool_use",
                  id: "t1",
                  name: "_copilot_web_search",
                  input: {},
                },
              },
              {
                type: "content_block_delta",
                index: 1,
                delta: {
                  type: "input_json_delta",
                  partial_json: '{"query":"Open https://example.com"}',
                },
              },
              { type: "content_block_stop", index: 1 },
              {
                type: "message_delta",
                delta: { stop_reason: "tool_use" },
                usage: { output_tokens: 3 },
              },
              { type: "message_stop" },
            ])
          expect(next.messages).toMatchObject([
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "think", signature: "sig" },
                {
                  type: "tool_use",
                  id: "t1",
                  input: { query: "Open https://example.com" },
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "t1", content: "PAGE" },
              ],
            },
          ])
          return events([
            {
              type: "message_start",
              message: {
                id: "m2",
                content: [],
                usage: { input_tokens: 6, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "answer" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 4 },
            },
            { type: "message_stop" },
          ])
        },
        execute: async () => ({ text: "PAGE", isError: false }),
      }),
    ),
  )
  expect(
    output.filter((v) => typeof v !== "string" && v.type === "message_start"),
  ).toHaveLength(1)
  expect(
    output.filter((v) => typeof v !== "string" && v.type === "message_stop"),
  ).toHaveLength(1)
  expect(
    output.filter((v) => typeof v !== "string" && v.type === "message_delta"),
  ).toEqual([
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 8, output_tokens: 7 },
    },
  ])
  const blocks = output.filter(
    (v) => typeof v !== "string" && v.type === "content_block_start",
  ) as Array<Record<string, unknown>>
  expect(blocks.map((v) => v.index)).toEqual([0, 1])
  expect(JSON.stringify(output)).not.toContain("PAGE")
  expect(
    blocks.every(
      (v) => (v.content_block as Record<string, unknown>).type !== "tool_use",
    ),
  ).toBe(true)
})

test("Chat classifies fragmented managed names before rejecting an unexpected mixed batch", async () => {
  const payload = {
    model: "fixture",
    messages: [],
    stream: true,
  }
  let executions = 0
  let sends = 0
  let receivedFrames = 0
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "chat",
        payload,
        send: async () => {
          sends++
          const source = events([
            {
              id: "c1",
              model: "fixture",
              choices: [
                {
                  index: 0,
                  delta: {
                    content: "checking",
                    tool_calls: [
                      {
                        index: 0,
                        id: "web",
                        function: { name: "_copilot_web_", arguments: "" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "c1",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          name: "search",
                          arguments: '{"query":"Open https://example.com"}',
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "c1",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 1,
                        id: "file",
                        function: {
                          name: "read_file",
                          arguments: '{"path":"README"}',
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
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5,
              },
            },
            "[DONE]",
          ])
          return (async function* () {
            for await (const event of source) {
              receivedFrames++
              yield event
            }
          })()
        },
        execute: async () => {
          executions++
          return { text: "PRIVATE_PAGE_EVIDENCE", isError: false }
        },
      }),
    ),
  ).catch((error: unknown) => error)
  expect(output).toMatchObject({
    response: { status: 400 },
    clientBody: { error: { code: "unsupported_web_tool_combination" } },
  })
  expect(sends).toBe(1)
  expect(executions).toBe(0)
  expect(receivedFrames).toBe(5)
})

const chunk = (tool: Record<string, unknown>) => ({
  id: "mixed",
  choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: null }],
})

test("Chat assembles fragmented owned names and arguments without emitting private results", async () => {
  const payload = { messages: [], stream: true }
  let sends = 0
  let executions = 0
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "chat",
        payload,
        send: async (next) => {
          if (++sends === 1)
            return events([
              chunk({
                index: 0,
                id: "web",
                type: "function",
                function: { name: "_copilot_web_", arguments: '{"query":' },
              }),
              chunk({
                index: 0,
                function: { name: "search", arguments: '"news"}' },
              }),
              {
                id: "mixed",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              },
              {
                id: "mixed",
                choices: [],
                usage: {
                  prompt_tokens: 2,
                  completion_tokens: 3,
                  total_tokens: 5,
                },
              },
              "[DONE]",
            ])
          expect(next.messages).toMatchObject([
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "web",
                  type: "function",
                  function: {
                    name: "_copilot_web_search",
                    arguments: '{"query":"news"}',
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "web",
              content: "PRIVATE_PAGE_EVIDENCE",
            },
          ])
          return events([
            {
              id: "answer",
              choices: [
                { index: 0, delta: { content: "Final " }, finish_reason: null },
              ],
            },
            {
              id: "answer",
              choices: [
                {
                  index: 0,
                  delta: { content: "answer" },
                  finish_reason: "stop",
                },
              ],
            },
            {
              id: "answer",
              choices: [],
              usage: {
                prompt_tokens: 6,
                completion_tokens: 4,
                total_tokens: 10,
              },
            },
            "[DONE]",
          ])
        },
        execute: async (call) => {
          executions++
          expect(call).toEqual({
            id: "web",
            name: "_copilot_web_search",
            input: '{"query":"news"}',
          })
          return { text: "PRIVATE_PAGE_EVIDENCE", isError: false }
        },
      }),
    ),
  )
  expect(sends).toBe(2)
  expect(executions).toBe(1)
  const values = output.filter((value) => typeof value !== "string")
  const choices = values.flatMap(
    (value) =>
      value.choices as Array<{
        delta: { content?: string }
        finish_reason?: string | null
      }>,
  )
  expect(choices.map((choice) => choice.delta.content ?? "").join("")).toBe(
    "Final answer",
  )
  expect(
    choices
      .filter((choice) => choice.finish_reason)
      .map((choice) => choice.finish_reason),
  ).toEqual(["stop"])
  expect(values.find((value) => value.usage)).toMatchObject({
    usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 },
  })
  expect(output.filter((value) => value === "[DONE]")).toHaveLength(1)
  expect(JSON.stringify(output)).not.toContain("PRIVATE_PAGE_EVIDENCE")
  expect(JSON.stringify(output)).not.toContain("tool_calls")
})

test("Chat returns fragmented caller-owned calls once without injecting a managed tool", async () => {
  const payload = {
    stream: true,
    tools: [{ type: "function", function: { name: "read_file" } }],
  }
  let executions = 0
  let sends = 0
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "chat",
        payload,
        send: async (body, managed) => {
          sends++
          expect(body.tools).toEqual(payload.tools)
          expect(managed.size).toBe(0)
          return events([
            chunk({
              index: 0,
              id: "client",
              type: "function",
              function: { name: "read_file", arguments: '{"path":' },
            }),
            chunk({ index: 0, function: { arguments: '"README"}' } }),
            {
              id: "mixed",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
            "[DONE]",
          ])
        },
        execute: async () => {
          executions++
          return { text: "must not run", isError: false }
        },
      }),
    ),
  )
  expect(sends).toBe(1)
  expect(executions).toBe(0)
  const values = output.filter((v) => typeof v !== "string")
  const calls = values.flatMap((v) =>
    (
      v.choices as Array<{
        delta: {
          tool_calls?: Array<{
            index: number
            function: { name?: string; arguments?: string }
          }>
        }
      }>
    ).flatMap((c) => c.delta.tool_calls ?? []),
  )
  expect(calls.map((c) => c.function.name ?? "").join("")).toBe("read_file")
  expect(calls.map((c) => c.function.arguments ?? "").join("")).toBe(
    '{"path":"README"}',
  )
  expect(calls.every((c) => c.index === 0)).toBe(true)
})

test("Messages preserves text and caller tool block indices without managed injection", async () => {
  const payload = {
    stream: true,
    tools: [{ name: "read_file", input_schema: {} }],
  }
  let executions = 0
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "messages",
        payload,
        send: async (body, managed) => {
          expect(body.tools).toEqual(payload.tools)
          expect(managed.size).toBe(0)
          return events([
            { type: "message_start", message: { id: "m1", content: [] } },
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "text",
                text: "Checking the file",
              },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "client",
                name: "read_file",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: {
                type: "input_json_delta",
                partial_json: '{"path":"README"}',
              },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 5 },
            },
            { type: "message_stop" },
          ])
        },
        execute: async () => {
          executions++
          return { text: "must not run", isError: false }
        },
      }),
    ),
  )
  expect(executions).toBe(0)
  const values = output.filter((v) => typeof v !== "string")
  expect(
    values.filter((v) => v.type === "content_block_start").map((v) => v.index),
  ).toEqual([0, 1])
  expect(
    values.find((v) => v.type === "content_block_delta" && v.index === 1),
  ).toMatchObject({ delta: { partial_json: '{"path":"README"}' } })
  expect(values.find((v) => v.type === "message_delta")).toMatchObject({
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 5 },
  })
})

test("Responses retains terminal output and reindexes continued text after a page read", async () => {
  let sends = 0
  const payload = { model: "fixture", input: "open page", stream: true }
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "responses",
        payload,
        send: async () => {
          sends++
          if (sends === 1) {
            const item = {
              id: "f1",
              type: "function_call",
              call_id: "tool1",
              name: "_copilot_web_search",
              arguments: '{"query":"Open https://example.com"}',
            }
            return events([
              { type: "response.created", response: { id: "r1" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "f1",
                delta: item.arguments,
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.completed",
                response: {
                  id: "r1",
                  status: "completed",
                  output: [item],
                  usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
                },
              },
            ])
          }
          const item = {
            id: "text1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          }
          return events([
            { type: "response.created", response: { id: "r2" } },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, content: [] },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              item_id: "text1",
              content_index: 0,
              delta: "answer",
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: "r2",
                status: "completed",
                output: [item],
                usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
              },
            },
          ])
        },
        execute: async () => ({ text: "PAGE", isError: false }),
      }),
    ),
  )
  const values = output.filter((v) => typeof v !== "string")
  expect(values.filter((v) => v.type === "response.created")).toHaveLength(1)
  const final = values.find((v) => v.type === "response.completed")
  expect(final).toMatchObject({
    response: {
      id: "r1",
      output: [{ type: "message", id: "text1" }],
      usage: { total_tokens: 15 },
    },
  })
  expect(
    values.find(
      (v) => v.type === "response.output_text.delta" && v.delta === "answer",
    ),
  ).toHaveProperty("output_index", 0)
  expect(
    values.find(
      (v) =>
        v.type === "response.output_text.delta"
        && String(v.delta).includes("PAGE"),
    ),
  ).toBeUndefined()
  expect(JSON.stringify(values)).not.toContain("web_result_")
})

test.each(["response.incomplete", "response.failed"])(
  "Responses %s after page reading preserves the root id, aggregate usage, and prior output",
  async (terminal) => {
    let sends = 0
    const payload = { stream: true, input: "open page" }
    const output = await runWithWebTools(payload, async () =>
      collect(
        await runManagedWebRequest({
          protocol: "responses",
          payload,
          send: () => {
            const first = ++sends === 1
            const id = first ? "r1" : "r2"
            const call = {
              id: "f",
              type: "function_call",
              call_id: "call",
              name: "_copilot_web_search",
              arguments: '{"query":"Open https://example.com"}',
            }
            return Promise.resolve(
              events([
                {
                  type: "response.created",
                  sequence_number: 0,
                  response: { id },
                },
                ...(first ?
                  [
                    {
                      type: "response.output_item.added",
                      sequence_number: 1,
                      output_index: 0,
                      item: call,
                    },
                  ]
                : []),
                {
                  type: first ? "response.completed" : terminal,
                  sequence_number: 2,
                  response: {
                    id,
                    status: first ? "completed" : terminal.slice(9),
                    output: first ? [call] : [],
                    usage: {
                      input_tokens: first ? 2 : 6,
                      output_tokens: first ? 3 : 12,
                      total_tokens: first ? 5 : 18,
                    },
                    incomplete_details: { reason: "max_output_tokens" },
                  },
                },
              ]),
            )
          },
          execute: async () => ({ text: "PAGE", isError: false }),
        }),
      ),
    )
    const values = output.filter((v) => typeof v !== "string")
    const final = values.find((v) => v.type === terminal)
    expect(final).toMatchObject({
      response: {
        id: "r1",
        output: [],
        usage: { total_tokens: 23 },
        incomplete_details: { reason: "max_output_tokens" },
      },
    })
    expect((final?.response as Record<string, unknown>).output_text).toBe("")
    const sequences = values.map((v) => Number(v.sequence_number))
    expect(
      sequences.every(
        (value, index) => index === 0 || value > sequences[index - 1],
      ),
    ).toBe(true)
  },
)

test("unterminated streams do not execute page reading or announce success", async () => {
  let executed = false
  const payload = { stream: true }
  const result = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "messages",
        payload,
        send: async () =>
          events([
            { type: "message_start", message: { id: "m" } },
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "incomplete",
                name: "_copilot_web_search",
                input: {},
              },
            },
          ]),
        execute: async () => {
          executed = true
          return { text: "", isError: false }
        },
      }),
    ),
  ).catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
  expect(String(result)).toContain("Upstream stream ended")
  expect(executed).toBe(false)
})
