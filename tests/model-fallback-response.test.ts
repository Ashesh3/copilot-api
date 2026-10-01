import { expect, test } from "bun:test"

import { inspectModelFallbackResponse } from "~/lib/model-fallback-response"

test.each([
  {
    endpoint: "/v1/messages",
    body: { type: "message", stop_reason: "refusal", content: [] },
    reason: "refusal",
  },
  {
    endpoint: "/responses",
    body: {
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [],
    },
    reason: "content_filter",
  },
])(
  "recognizes only the buffered $reason envelope and preserves its bytes",
  async ({ endpoint, body, reason }) => {
    const bytes = ` \r\n${JSON.stringify(body)}\r\n`
    const response = new Response(bytes, {
      headers: { "content-type": "application/json; charset=utf-8" },
    })
    expect(await inspectModelFallbackResponse(response, endpoint)).toEqual({
      reason,
      successful: false,
    })
    expect(await response.text()).toBe(bytes)
  },
)

test.each([
  {
    endpoint: "/v1/messages",
    body: {
      type: "message",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "refusal content_filter" }],
    },
    successful: true,
  },
  {
    endpoint: "/v1/messages",
    body: { type: "message", stop_reason: "max_tokens", content: [] },
    successful: true,
  },
  {
    endpoint: "/v1/messages",
    body: { type: "message", stop_reason: null, content: [] },
    successful: false,
  },
  {
    endpoint: "/v1/messages",
    body: { type: "message", stop_reason: "end_turn" },
    successful: false,
  },
  {
    endpoint: "/v1/messages",
    body: {
      type: "error",
      stop_reason: "refusal",
      error: { type: "api_error" },
    },
    successful: false,
  },
  {
    endpoint: "/responses",
    body: {
      object: "response",
      status: "completed",
      output: [],
      output_text: "content_filter",
    },
    successful: true,
  },
  {
    endpoint: "/responses",
    body: { object: "response", output: [] },
    successful: true,
  },
  {
    endpoint: "/responses",
    body: {
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    },
    successful: false,
  },
  {
    endpoint: "/responses",
    body: {
      object: "response",
      status: "failed",
      error: { code: "content_filter" },
      output: [],
    },
    successful: false,
  },
  {
    endpoint: "/responses",
    body: { object: "response", status: "in_progress", output: [] },
    successful: false,
  },
])(
  "does not switch on non-refusal $endpoint outcome %#",
  async ({ endpoint, body, successful }) => {
    expect(
      await inspectModelFallbackResponse(Response.json(body), endpoint),
    ).toEqual({ successful })
  },
)

test("leaves streamed events and other protocols unread", async () => {
  let pulls = 0
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls++
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "content-type": "text/event-stream" } },
  )
  expect(await inspectModelFallbackResponse(response, "/responses")).toEqual({
    successful: true,
  })
  expect(pulls).toBe(0)
  expect(response.bodyUsed).toBe(false)
  await response.body?.cancel()
  const other = Response.json({ type: "message", stop_reason: "refusal" })
  expect(
    await inspectModelFallbackResponse(other, "/chat/completions"),
  ).toEqual({ successful: true })
  expect(other.bodyUsed).toBe(false)
})

test("malformed JSON is left to the endpoint parser and cannot establish a route", async () => {
  const response = new Response("{broken", {
    headers: { "content-type": "application/json" },
  })
  expect(await inspectModelFallbackResponse(response, "/v1/messages")).toEqual({
    successful: false,
  })
  expect(await response.text()).toBe("{broken")
})
