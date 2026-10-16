/* eslint-disable @typescript-eslint/require-await -- Deterministic async transport fixtures. */
import { expect, test } from "bun:test"

import type { WebEvent, WebResponse } from "~/services/web/tool-loop"

import { runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"
import { records } from "~/services/web/tool-output"

const webCall = {
  type: "function_call",
  id: "web-item",
  call_id: "web-call",
  name: "_copilot_web_search",
  arguments: '{"query":"Open https://example.com"}',
}
const clientCall = {
  type: "function_call",
  id: "client-item",
  call_id: "client-call",
  name: "read_file",
  arguments: '{"path":"README"}',
}
async function* events(
  values: Array<Record<string, unknown> | string>,
): AsyncGenerator<WebEvent> {
  for (const value of values)
    yield { data: typeof value === "string" ? value : JSON.stringify(value) }
}
async function collect(response: WebResponse) {
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

test.each(["incomplete", "failed"])(
  "buffered Responses %s never executes an unfulfilled managed call",
  async (status) => {
    const payload = {
      model: "fixture",
      input: "open page",
      tools: [{ type: "function", name: "read_file", parameters: {} }],
    }
    let executions = 0
    let sends = 0
    const result = await runWithWebTools(payload, () =>
      runManagedWebRequest({
        protocol: "responses",
        payload,
        send: async () => {
          sends++
          return {
            id: "terminal",
            status,
            incomplete_details: { reason: "max_output_tokens" },
            error: status === "failed" ? { message: "failed upstream" } : null,
            usage: { input_tokens: 5, output_tokens: 8 },
            output: [webCall, clientCall],
          }
        },
        execute: async () => {
          executions++
          return { text: "must not execute", isError: false }
        },
      }),
    ).catch((error: unknown) => error)
    expect(executions).toBe(0)
    expect(sends).toBe(1)
    expect(result).toMatchObject({
      id: "terminal",
      status,
      output: [clientCall],
      incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 5, output_tokens: 8 },
    })
  },
)

test("Messages retains explicit serial-tool policy after managed web continuation", async () => {
  const payload = {
    model: "fixture",
    messages: [],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  }
  let sends = 0
  await runWithWebTools(payload, () =>
    runManagedWebRequest({
      protocol: "messages",
      payload,
      send: async (next) => {
        if (++sends === 1)
          return {
            content: [
              {
                type: "tool_use",
                id: "web",
                name: "_copilot_web_search",
                input: { query: "news" },
              },
            ],
            stop_reason: "tool_use",
          }
        expect(next.tool_choice).toEqual({
          type: "auto",
          disable_parallel_tool_use: true,
        })
        return {
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
        }
      },
      execute: async () => ({ text: "remote", isError: false }),
    }),
  )
  expect(sends).toBe(2)
})

test("Responses emits held managed and client items in output-index order", async () => {
  const payload = {
    input: "open",
    stream: true,
    tools: [{ type: "function", name: "read_file", parameters: {} }],
  }
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "responses",
        payload,
        send: async () =>
          events([
            {
              type: "response.created",
              response: { id: "r1" },
              sequence_number: 0,
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: webCall,
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: webCall,
            },
            {
              type: "response.output_item.added",
              output_index: 1,
              item: { ...clientCall, arguments: "" },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "client-item",
              delta: clientCall.arguments,
            },
            {
              type: "response.output_item.done",
              output_index: 1,
              item: clientCall,
            },
            {
              type: "response.completed",
              response: {
                id: "r1",
                status: "completed",
                output: [webCall, clientCall],
              },
            },
          ]),
        execute: async () => ({ text: "PAGE", isError: false }),
      }),
    ),
  )
  const values = output.filter((value) => typeof value !== "string")
  expect(
    values
      .filter((value) => value.type === "response.output_item.added")
      .map((value) => value.output_index),
  ).toEqual([0, 1])
  const start = values.findIndex(
    (value) =>
      value.type === "response.output_item.added" && value.output_index === 1,
  )
  expect(
    values.findIndex((value) => value.item_id === "client-item"),
  ).toBeGreaterThan(start)
  expect(
    values.find((value) => value.type === "response.completed"),
  ).toMatchObject({ response: { output: [{ type: "message" }, clientCall] } })
})

test.each(["response.incomplete", "response.failed"])(
  "%s hides unexecuted gateway calls and preserves ordered client calls",
  async (terminal) => {
    let executions = 0
    const payload = {
      input: "open",
      stream: true,
      tools: [{ type: "function", name: "read_file", parameters: {} }],
    }
    const output = await runWithWebTools(payload, async () =>
      collect(
        await runManagedWebRequest({
          protocol: "responses",
          payload,
          send: async () =>
            events([
              { type: "response.created", response: { id: "r1" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...webCall, arguments: '{"query":' },
              },
              {
                type: "response.output_item.added",
                output_index: 1,
                item: { ...clientCall, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                item_id: "client-item",
                delta: clientCall.arguments,
              },
              {
                type: "response.output_item.done",
                output_index: 1,
                item: clientCall,
              },
              {
                type: terminal,
                response: {
                  id: "r1",
                  status: terminal.slice(9),
                  output: [{ ...webCall, arguments: '{"query":' }, clientCall],
                  incomplete_details: { reason: "max_output_tokens" },
                },
              },
            ]),
          execute: async () => {
            executions++
            return { text: "forbidden", isError: false }
          },
        }),
      ),
    )
    expect(executions).toBe(0)
    expect(JSON.stringify(output)).not.toContain("_copilot_web_search")
    const values = output.filter((value) => typeof value !== "string")
    expect(values.find((value) => value.type === terminal)).toMatchObject({
      response: {
        output: [clientCall],
        incomplete_details: { reason: "max_output_tokens" },
      },
    })
    expect(
      values
        .filter((value) => value.type === "response.output_item.added")
        .map((value) => value.output_index),
    ).toEqual([0])
  },
)

test("Chat custom-only streams stay transparent rather than becoming empty functions", async () => {
  const payload = {
    messages: [],
    stream: true,
    tools: [
      { type: "custom", custom: { name: "shell", format: { type: "text" } } },
    ],
  }
  const frames = [
    {
      id: "chat",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "shell-call",
                type: "custom",
                custom: { name: "shell", input: "echo " },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chat",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, custom: { input: "hello" } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
    "[DONE]",
  ]
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "chat",
        payload,
        send: async () => events(frames),
      }),
    ),
  )
  expect(output).toEqual(frames)
})

test("Chat preserves encrypted reasoning and custom call shape alongside managed work", async () => {
  const payload = {
    messages: [],
    stream: true,
    tools: [
      { type: "custom", custom: { name: "shell", format: { type: "text" } } },
    ],
  }
  let sends = 0
  const output = await runWithWebTools(payload, async () =>
    collect(
      await runManagedWebRequest({
        protocol: "chat",
        payload,
        send: async (next) => {
          sends++
          if (sends === 1)
            return events([
              {
                id: "c1",
                choices: [
                  {
                    index: 0,
                    delta: {
                      encrypted_content: "signed-encrypted-state",
                      reasoning_opaque: "signed-opaque-state",
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
              "[DONE]",
            ])
          expect(records(next.messages).at(0)).toMatchObject({
            encrypted_content: "signed-encrypted-state",
            reasoning_opaque: "signed-opaque-state",
          })
          return events([
            {
              id: "c2",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "shell-call",
                        type: "custom",
                        custom: { name: "shell", input: "echo " },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "c2",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [{ index: 0, custom: { input: "hello" } }],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
            "[DONE]",
          ])
        },
        execute: async () => ({ text: "REMOTE", isError: false }),
      }),
    ),
  )
  expect(sends).toBe(2)
  const calls = output
    .filter((value) => typeof value !== "string")
    .flatMap((value) => records(value.choices))
    .flatMap((choice) =>
      records((choice.delta as Record<string, unknown>).tool_calls),
    )
  expect(calls).toEqual([
    {
      index: 0,
      id: "shell-call",
      type: "custom",
      custom: { name: "shell", input: "echo hello" },
    },
  ])
})
