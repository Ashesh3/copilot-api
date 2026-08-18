import { expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { LocalHTTPError } from "~/lib/error"
import {
  canonicalizeAnthropicBeta,
  isAnthropicBetaIdentifier,
  prepareAnthropicMessagesRequest,
  serializeAnthropicMessagesRequest,
} from "~/services/copilot/messages-contract"

function expectFixedBodyError(action: () => unknown, marker: string): void {
  try {
    action()
    throw new Error("Expected Messages body validation to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect(error).toHaveProperty("response.status", 400)
    expect(error).toHaveProperty("clientBody.type", "error")
    expect(error).toHaveProperty(
      "clientBody.error.type",
      "invalid_request_error",
    )
    expect(error).toHaveProperty(
      "clientBody.error.message",
      "The Messages request body must contain only plain JSON values.",
    )
    expect(JSON.stringify((error as LocalHTTPError).clientBody)).not.toContain(
      marker,
    )
    expect((error as Error).message).not.toContain(marker)
  }
}

test("canonicalizes beta whitespace and duplicates without renaming ids", () => {
  expect(
    canonicalizeAnthropicBeta(
      " interleaved-thinking-2025-05-14,claude-code-20250219, interleaved-thinking-2025-05-14 ",
    ),
  ).toBe("interleaved-thinking-2025-05-14,claude-code-20250219")
})

test("accepts only visible ASCII HTTP-token beta identifiers", () => {
  expect(isAnthropicBetaIdentifier("interleaved-thinking-2025-05-14")).toBe(
    true,
  )
  expect(isAnthropicBetaIdentifier("beta_feature.v2")).toBe(true)
  expect(isAnthropicBetaIdentifier("beta feature")).toBe(false)
  expect(isAnthropicBetaIdentifier("beta/version")).toBe(false)
  expect(isAnthropicBetaIdentifier("unicode-βeta")).toBe(false)
  expect(isAnthropicBetaIdentifier("latin-é")).toBe(false)
  expect(isAnthropicBetaIdentifier("beta\u007fvalue")).toBe(false)
  expect(isAnthropicBetaIdentifier("bad\u0001beta")).toBe(false)
})

test("deduplicates beta identifiers before enforcing the final byte limit", () => {
  const beta = "advanced-tool-use-2025-11-20"
  expect(canonicalizeAnthropicBeta(Array(80).fill(beta).join(","))).toBe(beta)
})

test("trims only comma-separator whitespace and rejects invalid segments", () => {
  expect(canonicalizeAnthropicBeta(" beta-one , beta-two ")).toBe(
    "beta-one,beta-two",
  )
  expect(canonicalizeAnthropicBeta("beta-one,,beta-two")).toBeUndefined()
  expect(canonicalizeAnthropicBeta("beta-one beta-two")).toBeUndefined()
  expect(canonicalizeAnthropicBeta("safe-beta,bad\u0001beta")).toBeUndefined()
  expect(canonicalizeAnthropicBeta("safe-beta,unicode-βeta")).toBeUndefined()
  expect(canonicalizeAnthropicBeta("safe-beta,latin-é")).toBeUndefined()
})

test("rejects oversized canonical beta output", () => {
  expect(
    canonicalizeAnthropicBeta(
      Array.from({ length: 180 }, (_, index) => `beta-feature-${index}`).join(
        ",",
      ),
    ),
  ).toBeUndefined()
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

test("rejects a throwing accessor without invoking or exposing it", () => {
  const marker = "PRIVATE_THROWING_GETTER"
  let reads = 0
  const payload = {
    max_tokens: 1,
    messages: [{ role: "user", content: "hello" }],
  } as Record<string, unknown>
  Object.defineProperty(payload, "model", {
    enumerable: true,
    get() {
      reads += 1
      throw new Error(marker)
    },
  })

  expectFixedBodyError(
    () =>
      prepareAnthropicMessagesRequest({
        payload: payload as AnthropicMessagesPayload,
        requireMaxTokens: true,
      }),
    marker,
  )
  expect(reads).toBe(0)
})

test("rejects a revoked proxy with a fixed body error", () => {
  const marker = "revoked proxy"
  const revocable = Proxy.revocable(
    {
      model: "claude",
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
    },
    {},
  )
  revocable.revoke()

  expectFixedBodyError(
    () =>
      prepareAnthropicMessagesRequest({
        payload: revocable.proxy as AnthropicMessagesPayload,
        requireMaxTokens: true,
      }),
    marker,
  )
})

test.each([
  ["PRIVATE_BIGINT", 1n],
  ["PRIVATE_HOST_OBJECT", new Date(0)],
] as const)(
  "rejects non-JSON value %s with a fixed body error",
  (marker, value) => {
    const payload = {
      model: "claude",
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
      future_native_field: value,
    } as AnthropicMessagesPayload

    expectFixedBodyError(
      () =>
        prepareAnthropicMessagesRequest({ payload, requireMaxTokens: true }),
      marker,
    )
    expect(payload.future_native_field).toBe(value)
  },
)

test("rejects cyclic data with a fixed body error and preserves the source", () => {
  const marker = "PRIVATE_CYCLE"
  const futureNativeField: Record<string, unknown> = { marker }
  futureNativeField.self = futureNativeField
  const payload = {
    model: "claude",
    max_tokens: 1,
    messages: [{ role: "user", content: "hello" }],
    future_native_field: futureNativeField,
  } as AnthropicMessagesPayload

  expectFixedBodyError(
    () => prepareAnthropicMessagesRequest({ payload, requireMaxTokens: true }),
    marker,
  )
  expect(futureNativeField.self).toBe(futureNativeField)
})

test("serializer rejects accessors without invoking or exposing them", () => {
  const marker = "PRIVATE_SERIALIZER_GETTER"
  let reads = 0
  const body: Record<string, unknown> = {}
  Object.defineProperty(body, "future_native_field", {
    enumerable: true,
    get() {
      reads += 1
      throw new Error(marker)
    },
  })

  expectFixedBodyError(() => serializeAnthropicMessagesRequest(body), marker)
  expect(reads).toBe(0)
})
