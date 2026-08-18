import { expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { LocalHTTPError } from "~/lib/error"
import {
  canonicalizeAnthropicBeta,
  prepareAnthropicMessagesRequest,
  serializeAnthropicMessagesRequest,
} from "~/services/copilot/messages-contract"

test("canonicalizes beta whitespace and duplicates without renaming ids", () => {
  expect(
    canonicalizeAnthropicBeta(
      " interleaved-thinking-2025-05-14,claude-code-20250219, interleaved-thinking-2025-05-14 ",
    ),
  ).toBe("interleaved-thinking-2025-05-14,claude-code-20250219")
})

test("preserves native top-level fields and removes only gateway-local keys", () => {
  const payload = {
    model: "claude-current",
    max_tokens: 512,
    messages: [{ role: "user", content: "hello" }],
    cache_control: { type: "ephemeral", ttl: "5m" },
    fallback_credit_token: "opaque",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    future_native_field: { enabled: true },
    _gateway_compaction: true,
    _json_schema: { type: "object" },
  } as AnthropicMessagesPayload
  const prepared = prepareAnthropicMessagesRequest({
    payload,
    requireMaxTokens: true,
    anthropicBeta: "claude-code-20250219",
    anthropicVersion: "2023-06-01",
    modelProviderPreference: "anthropic",
  })
  expect(prepared.body).toMatchObject({
    cache_control: { type: "ephemeral", ttl: "5m" },
    fallback_credit_token: "opaque",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    future_native_field: { enabled: true },
  })
  expect(prepared.body).not.toHaveProperty("_gateway_compaction")
  expect(prepared.body).not.toHaveProperty("_json_schema")
  expect(payload).toHaveProperty("_gateway_compaction", true)
  expect(payload).toHaveProperty("_json_schema", { type: "object" })
  expect(prepared.headers).toEqual({
    anthropicBeta: "claude-code-20250219",
    anthropicVersion: "2023-06-01",
    modelProviderPreference: "anthropic",
  })
})

test("sanitizes native header options and defaults the Anthropic version", () => {
  const prepared = prepareAnthropicMessagesRequest({
    payload: {
      model: "claude-current",
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
    },
    requireMaxTokens: true,
    anthropicBeta: "bad\nbeta",
    anthropicVersion: "bad\rversion",
    modelProviderPreference: "bad\nprovider",
  })

  expect(prepared.headers).toEqual({
    anthropicVersion: "2023-06-01",
  })
})

test("normalizes every ephemeral cache marker without mutating the source", () => {
  const body = {
    cache_control: { type: "ephemeral", ttl: "5m", scope: "global" },
    system: [
      {
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
      },
    ],
  }
  const serialized = serializeAnthropicMessagesRequest(body)
  expect(JSON.parse(serialized)).toEqual({
    cache_control: { type: "ephemeral", ttl: "5m" },
    system: [
      {
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
  })
  expect(body.cache_control).toHaveProperty("scope", "global")
})

test.each([
  ["model", { model: "", messages: [], max_tokens: 1 }],
  ["messages", { model: "claude", messages: [], max_tokens: 1 }],
  [
    "max_tokens",
    { model: "claude", messages: [{ role: "user", content: "x" }] },
  ],
] as const)("validates required inference field %s", (param, payload) => {
  try {
    prepareAnthropicMessagesRequest({
      payload: payload as unknown as AnthropicMessagesPayload,
      requireMaxTokens: true,
    })
    throw new Error(`Expected ${param} validation to fail`)
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect(error).toHaveProperty(
      "clientBody.error.message",
      `${param} is required for Messages requests.`,
    )
    expect(error).toHaveProperty(
      "clientBody.error.type",
      "invalid_request_error",
    )
    expect(error).toHaveProperty("clientBody.type", "error")
  }
})

test.each([0, -1, 1.5])(
  "rejects non-positive or non-integer inference max_tokens %#",
  (maxTokens) => {
    expect(() =>
      prepareAnthropicMessagesRequest({
        payload: {
          model: "claude",
          messages: [{ role: "user", content: "x" }],
          max_tokens: maxTokens,
        },
        requireMaxTokens: true,
      }),
    ).toThrow(LocalHTTPError)
  },
)

test("does not require max_tokens for shared non-inference preparation", () => {
  expect(
    prepareAnthropicMessagesRequest({
      payload: {
        model: "claude",
        messages: [{ role: "user", content: "x" }],
      },
      requireMaxTokens: false,
    }).body,
  ).not.toHaveProperty("max_tokens")
})
