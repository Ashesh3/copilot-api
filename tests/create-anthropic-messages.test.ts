import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { state } from "../src/lib/state"
import { createAnthropicMessages } from "../src/services/copilot/create-anthropic-messages"

const originalFetch = globalThis.fetch
let capturedBody: unknown

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected native Messages JSON body")
  }
  capturedBody = JSON.parse(init.body) as unknown
  return new Response(
    JSON.stringify({
      id: "msg_cache_control",
      type: "message",
      role: "assistant",
      model: "claude-opus-4.8",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  capturedBody = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
})

test("serializes native cache controls using Copilot's supported wire shape", async () => {
  const payload = {
    model: "claude-opus-4.8",
    max_tokens: 64,
    system: [
      { type: "text", text: "base" },
      {
        type: "text",
        text: "scoped",
        cache_control: { type: "ephemeral", scope: "global" },
      },
      {
        type: "text",
        text: "long lived",
        cache_control: {
          type: "ephemeral",
          ttl: "1h",
          scope: "global",
          client_hint: true,
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: {
              type: "ephemeral",
              ttl: "unsupported",
              scope: "global",
            },
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              {
                type: "text",
                text: "result",
                cache_control: {
                  type: "ephemeral",
                  ttl: "5m",
                  scope: "global",
                },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      {
        name: "run",
        input_schema: {
          type: "object",
          metadata: { type: "ephemeral", scope: "global" },
        },
        cache_control: { type: "ephemeral", scope: "global" },
      },
    ],
  } as unknown as AnthropicMessagesPayload
  const originalPayload = structuredClone(payload)

  await createAnthropicMessages(payload)

  expect(payload).toEqual(originalPayload)
  expect(capturedBody).toEqual({
    model: "claude-opus-4.8",
    max_tokens: 64,
    system: [
      { type: "text", text: "base" },
      {
        type: "text",
        text: "scoped",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "long lived",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: { type: "ephemeral" },
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              {
                type: "text",
                text: "result",
                cache_control: { type: "ephemeral", ttl: "5m" },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      {
        name: "run",
        input_schema: {
          type: "object",
          metadata: { type: "ephemeral", scope: "global" },
        },
        cache_control: { type: "ephemeral" },
      },
    ],
  })
})
