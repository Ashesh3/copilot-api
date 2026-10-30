/* eslint-disable @typescript-eslint/require-await -- Async transport fixtures intentionally resolve immediately. */
import { describe, expect, test } from "bun:test"

import type { ObservedRequestUsage } from "~/lib/request-usage"
import type { WebEvent } from "~/services/web/tool-loop"

import { runWithRequestUsageObserver } from "~/lib/request-usage"
import { droidReportedUsage } from "~/services/web/droid-web-usage"
import { runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"

type JsonRecord = Record<string, unknown>

describe("Droid's reported usage", () => {
  test("Responses: last round's input, every round's output", () => {
    expect(
      droidReportedUsage(
        {
          input_tokens: 104,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 109,
        },
        {
          input_tokens: 204,
          input_tokens_details: { cached_tokens: 190 },
          output_tokens: 35,
          output_tokens_details: { reasoning_tokens: 22 },
          total_tokens: 239,
        },
        "responses",
      ),
    ).toEqual({
      input_tokens: 104,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 35,
      output_tokens_details: { reasoning_tokens: 22 },
      total_tokens: 139,
    })
  })

  test("Messages: last round's input and cache counters", () => {
    expect(
      droidReportedUsage(
        {
          input_tokens: 10,
          cache_read_input_tokens: 980,
          cache_creation_input_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 50 },
          output_tokens: 5,
        },
        {
          input_tokens: 30,
          cache_read_input_tokens: 1880,
          cache_creation_input_tokens: 130,
          cache_creation: { ephemeral_5m_input_tokens: 130 },
          output_tokens: 35,
          server_tool_use: { web_search_requests: 0 },
        },
        "messages",
      ),
    ).toEqual({
      input_tokens: 10,
      cache_read_input_tokens: 980,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 50 },
      output_tokens: 35,
      server_tool_use: { web_search_requests: 0 },
    })
  })

  test("keeps no stale input counter and keeps totals it cannot improve", () => {
    expect(
      droidReportedUsage(
        { input_tokens: 10, output_tokens: 5 },
        { input_tokens: 30, cache_read_input_tokens: 900, output_tokens: 35 },
        "messages",
      ),
    ).toEqual({ input_tokens: 10, output_tokens: 35 })
    const total = { input_tokens: 30, output_tokens: 35 }
    expect(droidReportedUsage(undefined, total, "messages")).toBe(total)
    expect(droidReportedUsage({}, undefined, "responses")).toBeUndefined()
  })
})

async function* events(values: Array<JsonRecord>): AsyncGenerator<WebEvent> {
  for (const [index, value] of values.entries())
    yield {
      event: String(value.type),
      data: JSON.stringify({ ...value, sequence_number: index }),
    }
}

test("an incomplete continuation reports Droid's context from its own input", async () => {
  const payload = {
    model: "gpt-fixture",
    input: "Find bun 1.4",
    tools: [
      {
        type: "function",
        name: "WebSearch",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
  }
  const search = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_ws",
    name: "WebSearch",
    arguments: '{"query":"bun 1.4"}',
  }
  const checkpoints: Array<ObservedRequestUsage> = []
  let sends = 0
  const frames: Array<JsonRecord> = []
  await runWithRequestUsageObserver(
    (usage) => checkpoints.push(usage),
    async () => {
      const result = await runWithWebTools(
        payload,
        () =>
          runManagedWebRequest({
            protocol: "responses",
            nativeResponses: true,
            payload,
            send: async () => {
              sends++
              if (sends === 1)
                return events([
                  { type: "response.created", response: { id: "r1" } },
                  {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: search,
                  },
                  {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: search,
                  },
                  {
                    type: "response.completed",
                    response: {
                      id: "r1",
                      status: "completed",
                      output: [search],
                      usage: { input_tokens: 100, output_tokens: 10 },
                    },
                  },
                ])
              return events([
                { type: "response.created", response: { id: "r2" } },
                {
                  type: "response.incomplete",
                  response: {
                    id: "r2",
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                    output: [],
                    usage: { input_tokens: 130, output_tokens: 64 },
                  },
                },
              ])
            },
            execute: async () => ({ text: "Results", isError: false }),
          }),
        { droid: true, protocol: "responses" },
      )
      if (!isWebStream(result)) throw new Error("Expected a stream")
      for await (const event of result)
        if (event.data) frames.push(JSON.parse(event.data) as JsonRecord)
    },
  )
  const incomplete = frames.find(
    (frame) => frame.type === "response.incomplete",
  )
  expect((incomplete?.response as JsonRecord).usage).toEqual({
    input_tokens: 130,
    output_tokens: 74,
    total_tokens: 204,
  })
  // Accounting still counts both rounds' prompts.
  expect(checkpoints.at(-1)).toMatchObject({
    inputTokens: 230,
    outputTokens: 74,
  })
})
