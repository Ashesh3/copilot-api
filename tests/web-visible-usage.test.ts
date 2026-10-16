/* eslint-disable @typescript-eslint/require-await -- Deterministic upstream transport fixtures. */
import { describe, expect, test } from "bun:test"

import type { WebProtocol } from "~/services/web/tool-context"
import type { WebEvent, WebResponse } from "~/services/web/tool-loop"

import { isRecord, runWithWebTools } from "~/services/web/tool-context"
import { isWebStream, runManagedWebRequest } from "~/services/web/tool-loop"
import { records, sumUsage } from "~/services/web/tool-output"

const invalidCounts = [
  -1,
  null,
  "10",
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  {},
  [],
]

test.each(invalidCounts.map((value) => ({ value })))(
  "an invalid first token counter $value is unknown, not measured zero",
  ({ value: invalid }) => {
    expect(sumUsage(undefined, { input_tokens: invalid })).toEqual({
      input_tokens: null,
    })
    expect(sumUsage({ input_tokens: invalid }, undefined)).toEqual({
      input_tokens: null,
    })
  },
)

test("missing usage remains missing and explicit zero remains measured", () => {
  expect(sumUsage(undefined, undefined)).toBeUndefined()
  expect(sumUsage(null, "invalid")).toBeUndefined()
  expect(sumUsage({}, {})).toEqual({})
  expect(sumUsage(undefined, { input_tokens: undefined })).toEqual({})
  expect(sumUsage({ input_tokens: 0 }, undefined)).toEqual({ input_tokens: 0 })
  expect(sumUsage({ input_tokens: 10 }, { input_tokens: undefined })).toEqual({
    input_tokens: 10,
  })
})

test("counter normalization preserves ordinary usage metadata", () => {
  expect(
    sumUsage(
      {
        input_tokens: 10,
        service_tier: "standard",
        billing: { label: "initial", rate: 0.5 },
        cache_creation: { ephemeral_5m_input_tokens: 3, source: "initial" },
      },
      {
        input_tokens: "bad",
        service_tier: "priority",
        billing: { label: null, rate: 0.25 },
        cache_creation: { ephemeral_5m_input_tokens: null, source: "latest" },
      },
    ),
  ).toEqual({
    input_tokens: 10,
    service_tier: "priority",
    billing: { label: null, rate: 0.75 },
    cache_creation: { ephemeral_5m_input_tokens: 3, source: "latest" },
  })
})

test.each([null, "invalid", [], -1].map((value) => ({ value })))(
  "invalid nested counter containers $value retain measured children",
  ({ value: invalid }) => {
    expect(
      sumUsage(
        {
          input_tokens_details: { cached_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 4 },
          prompt_tokens_details: { cached_tokens: 10 },
          completion_tokens_details: { accepted_prediction_tokens: 4 },
          cache_creation: { ephemeral_1h_input_tokens: 5 },
          server_tool_use: { web_search_requests: 2 },
        },
        {
          input_tokens_details: invalid,
          output_tokens_details: invalid,
          prompt_tokens_details: invalid,
          completion_tokens_details: invalid,
          cache_creation: invalid,
          server_tool_use: invalid,
        },
      ),
    ).toEqual({
      input_tokens_details: { cached_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 4 },
      prompt_tokens_details: { cached_tokens: 10 },
      completion_tokens_details: { accepted_prediction_tokens: 4 },
      cache_creation: { ephemeral_1h_input_tokens: 5 },
      server_tool_use: { web_search_requests: 2 },
    })
    expect(sumUsage(undefined, { cache_creation: invalid })).toEqual({
      cache_creation: null,
    })
    expect(
      sumUsage(
        { cache_creation: invalid },
        { cache_creation: { ephemeral_1h_input_tokens: 5 } },
      ),
    ).toEqual({ cache_creation: { ephemeral_1h_input_tokens: 5 } })
  },
)

test("nested request counters reject invalid values and retain safe subtotals", () => {
  expect(
    sumUsage(
      { server_tool_use: { web_search_requests: 10, web_fetch_requests: -1 } },
      {
        server_tool_use: {
          web_search_requests: Number.MAX_SAFE_INTEGER - 2,
          web_fetch_requests: 3,
        },
      },
    ),
  ).toEqual({
    server_tool_use: { web_search_requests: 10, web_fetch_requests: 3 },
  })
})

const webCall = {
  type: "function_call",
  id: "web-item",
  call_id: "web-call",
  name: "_copilot_web_search",
  arguments: '{"query":"news"}',
}

function responseFor(
  protocol: WebProtocol,
  first: boolean,
  usage: unknown,
): Record<string, unknown> {
  const common = {
    id: first ? "first" : "second",
    model: "fixture",
    ...(usage === undefined ? {} : { usage }),
  }
  if (protocol === "messages")
    return {
      ...common,
      type: "message",
      role: "assistant",
      stop_reason: first ? "tool_use" : "end_turn",
      stop_sequence: null,
      content:
        first ?
          [
            {
              type: "tool_use",
              id: "web-call",
              name: webCall.name,
              input: { query: "news" },
            },
          ]
        : [{ type: "text", text: "answer" }],
    }
  if (protocol === "responses")
    return {
      ...common,
      object: "response",
      status: "completed",
      output:
        first ?
          [webCall]
        : [
            {
              type: "message",
              id: "answer",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "answer", annotations: [] },
              ],
            },
          ],
    }
  return {
    ...common,
    object: "chat.completion",
    created: 1,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: first ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: first ? null : "answer",
          ...(first ?
            {
              tool_calls: [
                {
                  id: "web-call",
                  type: "function",
                  function: {
                    name: webCall.name,
                    arguments: webCall.arguments,
                  },
                },
              ],
            }
          : {}),
        },
      },
    ],
  }
}

async function* streamFor(
  protocol: WebProtocol,
  response: Record<string, unknown>,
): AsyncGenerator<WebEvent> {
  const event = (value: Record<string, unknown>) => ({
    data: JSON.stringify(value),
  })
  if (protocol === "messages") {
    yield event({
      type: "message_start",
      message: { ...response, content: [], stop_reason: null },
    })
    for (const [index, block] of records(response.content).entries()) {
      yield event({ type: "content_block_start", index, content_block: block })
      yield event({ type: "content_block_stop", index })
    }
    yield event({
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      ...(isRecord(response.usage) ?
        { usage: { output_tokens: response.usage.output_tokens } }
      : {}),
    })
    yield event({ type: "message_stop" })
  } else if (protocol === "responses") {
    yield event({
      type: "response.created",
      response: { id: response.id, status: "in_progress", output: [] },
    })
    for (const [index, item] of records(response.output).entries()) {
      yield event({
        type: "response.output_item.added",
        output_index: index,
        item,
      })
      yield event({
        type: "response.output_item.done",
        output_index: index,
        item,
      })
    }
    yield event({ type: "response.completed", response })
  } else {
    const choice = records(response.choices)[0]
    const message = isRecord(choice.message) ? choice.message : {}
    yield event({
      id: response.id,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            ...message,
            ...(message.tool_calls ?
              {
                tool_calls: records(message.tool_calls).map((call, index) => ({
                  ...call,
                  index,
                })),
              }
            : {}),
          },
          finish_reason: choice.finish_reason,
        },
      ],
    })
    if (response.usage !== undefined)
      yield event({
        id: response.id,
        object: "chat.completion.chunk",
        choices: [],
        usage: response.usage,
      })
    yield { data: "[DONE]" }
  }
}

async function visibleUsage(
  protocol: WebProtocol,
  stream: boolean,
  rounds: [unknown, unknown],
): Promise<unknown> {
  const payload = { model: "fixture", messages: [], input: "news", stream }
  let sends = 0
  const result = await runWithWebTools(payload, () =>
    runManagedWebRequest({
      protocol,
      payload,
      send: async (): Promise<WebResponse> => {
        const first = ++sends === 1
        const response = responseFor(
          protocol,
          first,
          first ? rounds[0] : rounds[1],
        )
        return stream ? streamFor(protocol, response) : response
      },
      execute: async () => ({ text: "remote result", isError: false }),
    }),
  )
  let usage: unknown
  expect(isWebStream(result)).toBe(stream)
  if (isWebStream(result)) {
    for await (const event of result) {
      if (!event.data || event.data === "[DONE]") continue
      const value = JSON.parse(event.data) as Record<string, unknown>
      if (value.type === "response.completed" && isRecord(value.response))
        usage = value.response.usage
      else if (
        value.type === "message_delta"
        || (protocol === "chat" && value.usage)
      )
        usage = value.usage
    }
  } else usage = result.usage
  expect(sends).toBe(2)
  return usage
}

function countsFor(
  protocol: WebProtocol,
  count: unknown,
): Record<string, unknown> {
  if (protocol === "messages")
    return {
      input_tokens: count,
      output_tokens: 0,
      cache_read_input_tokens: count,
      cache_creation_input_tokens: count,
      cache_creation: {
        ephemeral_5m_input_tokens: count,
        ephemeral_1h_input_tokens: 0,
      },
      service_tier: "standard",
    }
  if (protocol === "responses")
    return {
      input_tokens: count,
      output_tokens: 0,
      total_tokens: count,
      input_tokens_details: { cached_tokens: count },
      output_tokens_details: { reasoning_tokens: 0 },
    }
  return {
    prompt_tokens: count,
    completion_tokens: 0,
    total_tokens: count,
    prompt_tokens_details: { cached_tokens: count },
    completion_tokens_details: {
      accepted_prediction_tokens: count,
      rejected_prediction_tokens: 0,
    },
  }
}

const counterCases = [
  { name: "negative increment", first: 10, next: -1, want: 10 },
  { name: "null increment", first: 10, next: null, want: 10 },
  { name: "string increment", first: 10, next: "10", want: 10 },
  { name: "fractional increment", first: 10, next: 1.5, want: 10 },
  {
    name: "saturated increment",
    first: 10,
    next: Number.MAX_SAFE_INTEGER,
    want: 10,
  },
  {
    name: "addition overflow",
    first: 10,
    next: Number.MAX_SAFE_INTEGER - 2,
    want: 10,
  },
  { name: "invalid then measured", first: -1, next: 4, want: 4 },
  { name: "string then measured", first: "10", next: 4, want: 4 },
  { name: "all invalid", first: -1, next: null, want: null },
  { name: "explicit zero", first: 0, next: 0, want: 0 },
  { name: "invalid then zero", first: -1, next: 0, want: 0 },
  { name: "valid addition", first: 10, next: 4, want: 14 },
]

for (const protocol of ["messages", "responses", "chat"] as const)
  for (const stream of [false, true])
    describe(`${protocol} ${stream ? "stream terminal" : "buffered response"} usage`, () => {
      test.each(counterCases)(
        "$name retains only known counters",
        async ({ first, next, want }) => {
          const usage = await visibleUsage(protocol, stream, [
            countsFor(protocol, first),
            countsFor(protocol, next),
          ])
          if (!isRecord(usage)) throw new Error("Expected visible usage")
          if (protocol === "messages") {
            expect(usage.input_tokens).toBe(want)
            expect(usage.output_tokens).toBe(0)
            expect(usage.cache_read_input_tokens).toBe(want)
            expect(usage.cache_creation_input_tokens).toBe(want)
            expect(usage.cache_creation).toEqual({
              ephemeral_5m_input_tokens: want,
              ephemeral_1h_input_tokens: 0,
            })
            expect(usage.service_tier).toBe("standard")
          } else if (protocol === "responses") {
            expect(usage.input_tokens).toBe(want)
            expect(usage.output_tokens).toBe(0)
            expect(usage.total_tokens).toBe(want)
            expect(usage.input_tokens_details).toEqual({ cached_tokens: want })
            expect(usage.output_tokens_details).toEqual({ reasoning_tokens: 0 })
          } else {
            expect(usage.prompt_tokens).toBe(want)
            expect(usage.completion_tokens).toBe(0)
            expect(usage.total_tokens).toBe(want)
            expect(usage.prompt_tokens_details).toEqual({ cached_tokens: want })
            expect(usage.completion_tokens_details).toEqual({
              accepted_prediction_tokens: want,
              rejected_prediction_tokens: 0,
            })
          }
        },
      )
      test("missing continuation usage preserves measured input", async () => {
        const first =
          protocol === "chat" ?
            { prompt_tokens: 10, completion_tokens: 0 }
          : { input_tokens: 10, output_tokens: 0 }
        expect(
          await visibleUsage(protocol, stream, [first, undefined]),
        ).toEqual(first)
      })
      test("missing input is not invented from measured output", async () => {
        const count =
          protocol === "chat" ? "completion_tokens" : "output_tokens"
        expect(
          await visibleUsage(protocol, stream, [
            { [count]: 4 },
            { [count]: 6 },
          ]),
        ).toEqual({ [count]: 10 })
      })
      test("absent usage does not become a measured zero", async () => {
        const usage = await visibleUsage(protocol, stream, [
          undefined,
          undefined,
        ])
        expect(usage ?? {}).toEqual({})
      })
    })
