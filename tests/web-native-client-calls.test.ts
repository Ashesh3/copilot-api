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
const hostedWeb = {
  type: "web_search_call",
  id: "ws_hosted",
  status: "completed",
  action: { type: "search", query: "news" },
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
  search: Record<string, unknown> = web,
): AsyncGenerator<WebEvent> {
  for (const value of [
    { type: "response.created", response: { id: "root" } },
    { type: "response.output_item.added", output_index: 0, item: search },
    { type: "response.output_item.done", output_index: 0, item: search },
    { type: "response.output_item.added", output_index: 1, item: client },
    { type: "response.output_item.done", output_index: 1, item: client },
    {
      type: "response.completed",
      response: {
        id: "root",
        status: "completed",
        output: [search, client],
        usage: { input_tokens: 5, output_tokens: 6 },
      },
    },
  ])
    yield { data: JSON.stringify(value) }
}

for (const stream of [false, true])
  test.each(calls)(
    `Responses ${stream ? "stream" : "buffered"} rejects unexpected native client calls beside managed search: %p`,
    async (client) => {
      const payload = { input: "open page", stream }
      let sends = 0
      let executes = 0
      const outcome = await runWithWebTools(payload, async () => {
        const response = await runManagedWebRequest({
          protocol: "responses",
          nativeResponses: true,
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
        })
        if (isWebStream(response)) {
          for await (const _event of response) {
            /* consume until the mixed batch is classified */
          }
        }
        return response
      }).catch((error: unknown) => error)
      expect(sends).toBe(1)
      expect(executes).toBe(0)
      expect(outcome).toMatchObject({
        response: { status: 400 },
        clientBody: { error: { code: "unsupported_web_tool_combination" } },
      })
    },
  )

for (const stream of [false, true])
  test.each(calls)(
    `Responses ${stream ? "stream" : "buffered"} preserves hosted search beside native client calls: %p`,
    async (client) => {
      const clientTool =
        client.type === "computer_call" ?
          { type: "computer", display_width: 1024, display_height: 768 }
        : { type: "apply_patch" }
      const payload = {
        input: "open page",
        stream,
        tools: [{ type: "web_search" }, clientTool],
      }
      let sends = 0
      let executes = 0
      const response = await runWithWebTools(payload, () =>
        runManagedWebRequest({
          protocol: "responses",
          nativeResponses: true,
          payload,
          send: async (body, managed) => {
            sends++
            expect(body.tools).toEqual(payload.tools)
            expect(managed.size).toBe(0)
            return stream ?
                frames(client, hostedWeb)
              : {
                  id: "root",
                  status: "completed",
                  output: [hostedWeb, client],
                  usage: { input_tokens: 5, output_tokens: 6 },
                }
          },
          execute: async () => {
            executes++
            return { text: "must remain native", isError: false }
          },
        }),
      )
      let result: unknown = response
      const output: Array<Record<string, unknown>> = []
      if (isWebStream(response)) {
        for await (const event of response) {
          const value: unknown = JSON.parse(event.data ?? "{}")
          if (isRecord(value)) output.push(value)
        }
        result = output.find(
          (value) => value.type === "response.completed",
        )?.response
        expect(
          output
            .filter((value) => value.type === "response.output_item.added")
            .map((value) => value.output_index),
        ).toEqual([0, 1])
      }
      expect(sends).toBe(1)
      expect(executes).toBe(0)
      expect(result).toMatchObject({
        id: "root",
        status: "completed",
        output: [hostedWeb, client],
        usage: { input_tokens: 5, output_tokens: 6 },
      })
    },
  )
