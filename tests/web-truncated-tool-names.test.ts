/* eslint-disable @typescript-eslint/require-await -- Deterministic asynchronous protocol fixtures. */
import { expect, test } from "bun:test"

import type { WebEvent } from "~/services/web/tool-loop"

import { isRecord, runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"
import { records } from "~/services/web/tool-output"

for (const stream of [false, true])
  test(`Chat ${stream ? "stream" : "buffered"} retains truncation after private search when only the owned name is partial`, async () => {
    const payload = { messages: [], stream }
    let sends = 0
    let executes = 0
    const outcome = await runWithWebTools(payload, async () => {
      const result = await runManagedWebRequest({
        protocol: "chat",
        payload,
        send: async () => {
          const first = ++sends === 1
          const call = {
            id: "call",
            type: "function",
            function: {
              name: first ? "_copilot_web_search" : "_copilot_web_se",
              arguments: first ? '{"query":"news"}' : "{",
            },
          }
          const finish = first ? "tool_calls" : "length"
          const usage = { prompt_tokens: 2, completion_tokens: 3 }
          if (!stream)
            return {
              id: "root",
              choices: [
                {
                  index: 0,
                  finish_reason: finish,
                  message: { role: "assistant", tool_calls: [call] },
                },
              ],
              usage,
            }
          return (async function* (): AsyncGenerator<WebEvent> {
            yield {
              data: JSON.stringify({
                id: "root",
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ ...call, index: 0 }] },
                    finish_reason: finish,
                  },
                ],
                usage,
              }),
            }
            yield { data: "[DONE]" }
          })()
        },
        execute: async () => {
          executes++
          return { text: "private result", isError: false }
        },
      })
      if (!isWebStream(result)) return result
      const events: Array<unknown> = []
      for await (const event of result)
        if (event.data && event.data !== "[DONE]")
          events.push(JSON.parse(event.data) as unknown)
      return events
    }).catch((error: unknown) => error)
    expect(outcome).not.toBeInstanceOf(Error)
    expect(JSON.stringify(outcome)).toContain('"length"')
    expect(JSON.stringify(outcome)).not.toContain("_copilot_web_")
    expect(executes).toBe(1)
    expect(sends).toBe(2)
  })

for (const stream of [false, true])
  test.each([
    { name: "_copilot_web_se", declared: false },
    { name: "", declared: false },
    { name: "_copilot_web_se", declared: true },
  ])(
    `Chat ${stream ? "stream" : "buffered"} truncation removes only unowned managed-name fragments: %p`,
    async ({ name, declared }) => {
      const payload = {
        messages: [],
        stream,
        ...(declared ?
          { tools: [{ type: "function", function: { name, parameters: {} } }] }
        : {}),
      }
      const call = {
        id: "call",
        type: "function",
        function: { name, arguments: "" },
      }
      let sends = 0
      let executes = 0
      const response = await runWithWebTools(payload, () =>
        runManagedWebRequest({
          protocol: "chat",
          payload,
          send: async () => {
            sends++
            if (!stream)
              return {
                id: "root",
                choices: [
                  {
                    index: 0,
                    finish_reason: "length",
                    message: { role: "assistant", tool_calls: [call] },
                  },
                ],
              }
            return (async function* (): AsyncGenerator<WebEvent> {
              yield {
                data: JSON.stringify({
                  id: "root",
                  choices: [
                    {
                      index: 0,
                      delta: { tool_calls: [{ ...call, index: 0 }] },
                      finish_reason: "length",
                    },
                  ],
                }),
              }
              yield { data: "[DONE]" }
            })()
          },
          execute: async () => {
            executes++
            return { text: "forbidden", isError: false }
          },
        }),
      )
      const returnedCalls: Array<Record<string, unknown>> = []
      if (isWebStream(response)) {
        for await (const event of response) {
          if (!event.data || event.data === "[DONE]") continue
          const value = JSON.parse(event.data) as Record<string, unknown>
          for (const choice of records(value.choices))
            if (isRecord(choice.delta))
              returnedCalls.push(...records(choice.delta.tool_calls))
        }
      } else {
        for (const choice of records(response.choices))
          if (isRecord(choice.message))
            returnedCalls.push(...records(choice.message.tool_calls))
      }
      expect(sends).toBe(1)
      expect(executes).toBe(0)
      expect(returnedCalls).toEqual(
        declared ? [{ ...call, ...(stream ? { index: 0 } : {}) }] : [],
      )
    },
  )
