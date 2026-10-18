/* eslint-disable @typescript-eslint/require-await -- Deterministic transport fixtures. */
import { expect, test } from "bun:test"

import type { WebProtocol } from "~/services/web/tool-context"
import type { WebEvent } from "~/services/web/tool-loop"

import { runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

const owned = {
  id: "web",
  name: "_copilot_web_search",
  arguments: '{"query":"news"}',
}
const caller = { id: "caller", name: "get_weather", arguments: "{}" }

function response(protocol: WebProtocol, names = [owned], failed = false) {
  if (protocol === "messages")
    return {
      id: "msg_root",
      stop_reason: failed ? "max_tokens" : "tool_use",
      content: names.map((c) => ({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: JSON.parse(c.arguments) as unknown,
      })),
      usage: { input_tokens: 2, output_tokens: 3 },
    }
  if (protocol === "responses")
    return {
      id: "resp_root",
      status: failed ? "incomplete" : "completed",
      output: names.map((c) => ({
        type: "function_call",
        id: `fc_${c.id}`,
        call_id: c.id,
        name: c.name,
        arguments: c.arguments,
      })),
      usage: { input_tokens: 2, output_tokens: 3 },
    }
  return {
    id: "chat_root",
    choices: [
      {
        index: 0,
        finish_reason: failed ? "length" : "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: names.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
  }
}

async function* frames(
  protocol: WebProtocol,
  names = [owned],
  failed = false,
): AsyncGenerator<WebEvent> {
  const result = response(protocol, names, failed)
  const values: Array<Record<string, unknown>> = []
  if (protocol === "responses") {
    values.push({ type: "response.created", response: { id: result.id } })
    for (const [index, item] of (result.output ?? []).entries()) {
      values.push(
        {
          type: "response.output_item.added",
          output_index: index,
          item,
        },
        { type: "response.output_item.done", output_index: index, item },
      )
    }
    values.push({
      type: failed ? "response.incomplete" : "response.completed",
      response: result,
    })
  } else if (protocol === "messages") {
    values.push({ type: "message_start", message: { id: result.id } })
    for (const [index, block] of (result.content ?? []).entries()) {
      values.push(
        { type: "content_block_start", index, content_block: block },
        { type: "content_block_stop", index },
      )
    }
    values.push(
      {
        type: "message_delta",
        delta: { stop_reason: failed ? "max_tokens" : "tool_use" },
        usage: result.usage,
      },
      { type: "message_stop" },
    )
  } else {
    const finishReason = failed ? "length" : "tool_calls"
    for (const [index, call] of names.entries())
      values.push({
        id: result.id,
        choices: [
          {
            index: 0,
            finish_reason: index === names.length - 1 ? finishReason : null,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                },
              ],
            },
          },
        ],
        usage: result.usage,
      })
  }
  for (const value of values) yield { data: JSON.stringify(value) }
  if (protocol === "chat") yield { data: "[DONE]" }
}

for (const protocol of ["chat", "messages", "responses"] as const)
  for (const stream of [false, true]) {
    test(`${protocol} ${stream ? "stream" : "buffered"} cancellation after helper completion emits no evidence or continuation`, async () => {
      const controller = new AbortController()
      const sent: Array<string> = []
      let sends = 0
      const payload = { model: "fixture", stream }
      const work = runWithWebTools(payload, async () => {
        const result = await runManagedWebRequest({
          protocol,
          payload,
          signal: controller.signal,
          send: async () => {
            sends++
            return stream ? frames(protocol) : response(protocol)
          },
          execute: async () => {
            controller.abort(new DOMException("cancelled", "AbortError"))
            return { text: "PRIVATE_PAGE_RESULT", isError: false }
          },
        })
        if (isWebStream(result))
          for await (const event of result) sent.push(event.data ?? "")
      })
      expect(await work.catch((error: unknown) => error)).toMatchObject({
        name: "AbortError",
      })
      expect(sends).toBe(1)
      expect(sent.join("")).not.toContain("PRIVATE_PAGE_RESULT")
      expect(sent.join("")).not.toContain("web_result_")
      expect(sent.join("")).not.toContain("response.completed")
    })

    test.each([false, true])(
      `${protocol} ${stream ? "stream" : "buffered"} rejects unexpected mixed calls before execution, client first=%j`,
      async (clientFirst) => {
        let executes = 0
        let sends = 0
        const emitted: Array<string> = []
        const payload = { model: "fixture", stream }
        const names = clientFirst ? [caller, owned] : [owned, caller]
        const work = runWithWebTools(payload, async () => {
          const result = await runManagedWebRequest({
            protocol,
            payload,
            send: async () => {
              sends++
              return stream ?
                  frames(protocol, names)
                : response(protocol, names)
            },
            execute: async () => {
              executes++
              return { text: "PRIVATE_RESULT", isError: false }
            },
          })
          if (isWebStream(result))
            for await (const event of result) emitted.push(event.data ?? "")
        })
        expect(await work.catch((error: unknown) => error)).toMatchObject({
          clientBody: { error: { code: "unsupported_web_tool_combination" } },
        })
        expect(executes).toBe(0)
        expect(sends).toBe(1)
        expect(emitted.join("")).not.toContain("get_weather")
      },
    )

    test.each([false, true])(
      `${protocol} ${stream ? "stream" : "buffered"} does not hand off client calls after a private search round, failed=%j`,
      async (failed) => {
        let sends = 0
        let executes = 0
        const emitted: Array<string> = []
        const payload = { model: "fixture", stream }
        const work = runWithWebTools(payload, async () => {
          const result = await runManagedWebRequest({
            protocol,
            payload,
            send: async () => {
              const names = ++sends === 1 ? [owned] : [caller]
              return stream ?
                  frames(protocol, names, failed && sends > 1)
                : response(protocol, names, failed && sends > 1)
            },
            execute: async () => {
              executes++
              return { text: "PRIVATE_RESULT", isError: false }
            },
          })
          if (isWebStream(result))
            for await (const event of result) emitted.push(event.data ?? "")
        })
        expect(await work.catch((error: unknown) => error)).toMatchObject({
          clientBody: { error: { code: "unsupported_web_tool_combination" } },
        })
        expect(executes).toBe(1)
        expect(sends).toBe(2)
        expect(emitted.join("")).not.toContain("get_weather")
        expect(emitted.join("")).not.toContain('"call_id":"caller"')
      },
    )
  }
