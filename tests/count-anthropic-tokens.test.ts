import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { RoutingAffinity } from "../src/lib/routing-affinity"
import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import {
  getRoutingAffinity,
  runWithRoutingAffinity,
} from "../src/lib/routing-affinity"
import { state } from "../src/lib/state"
import { countAnthropicTokens } from "../src/services/copilot/count-anthropic-tokens"

const originalFetch = globalThis.fetch
let capturedBody: unknown
let capturedHeaders: Headers | undefined
let capturedPath: string | undefined
let capturedRoutingAffinity: RoutingAffinity | undefined
let capturedSignal: AbortSignal | null | undefined
let queuedResponse: Response

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected native count-tokens JSON body")
  }
  capturedBody = JSON.parse(init.body) as unknown
  capturedHeaders = new Headers(init.headers)
  capturedPath = new URL(url instanceof Request ? url.url : url).pathname
  capturedRoutingAffinity = getRoutingAffinity()
  capturedSignal = init.signal
  return queuedResponse
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
  capturedHeaders = undefined
  capturedPath = undefined
  capturedRoutingAffinity = undefined
  capturedSignal = undefined
  queuedResponse = Response.json({ input_tokens: 42 })
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
})

test("posts the exact native count-tokens body with request context", async () => {
  const controller = new AbortController()
  const affinity: RoutingAffinity = {
    key: "count-service-session",
    source: "claude_metadata",
  }
  const payload = {
    model: "claude-current",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
            cache_control: {
              type: "ephemeral",
              ttl: "5m",
              scope: "private",
            },
          },
        ],
      },
    ],
    system: [
      {
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral", ttl: "1h", scope: "private" },
      },
    ],
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        input_schema: {
          type: "object",
          properties: {},
          metadata: { retained: true },
        },
        cache_control: { type: "ephemeral", client_hint: true },
      },
    ],
    tool_choice: { type: "tool", name: "lookup" },
    stream: true,
    temperature: 0.4,
    top_p: 0.8,
    thinking: { type: "enabled", budget_tokens: 1000 },
    output_config: { effort: "high" },
    cache_control: { type: "ephemeral" },
    fallback_credit_token: "opaque",
    future_native_field: { enabled: true },
  } as unknown as AnthropicMessagesPayload
  const originalPayload = structuredClone(payload)

  const result = await runWithRoutingAffinity(
    affinity,
    async () =>
      await countAnthropicTokens(payload, {
        anthropicBeta: " beta-one, beta-two, beta-one ",
        anthropicVersion: " 2024-01-01 ",
        modelProviderPreference: " anthropic ",
        signal: controller.signal,
      }),
  )

  expect(result).toEqual({ input_tokens: 42 })
  expect(payload).toEqual(originalPayload)
  expect(capturedPath).toBe("/v1/messages/count_tokens")
  expect(capturedBody).toEqual({
    model: "claude-current",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        ],
      },
    ],
    system: [
      {
        type: "text",
        text: "stable",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        input_schema: {
          type: "object",
          properties: {},
          metadata: { retained: true },
        },
        cache_control: { type: "ephemeral" },
      },
    ],
    tool_choice: { type: "tool", name: "lookup" },
  })
  expect(capturedHeaders?.get("anthropic-beta")).toBe("beta-one,beta-two")
  expect(capturedHeaders?.get("anthropic-version")).toBe("2024-01-01")
  expect(capturedHeaders?.get("x-model-provider-preference")).toBe("anthropic")
  expect(capturedHeaders?.get("copilot-vision-request")).toBe("true")
  expect(capturedHeaders?.get("x-initiator")).toBe("user")
  expect(capturedRoutingAffinity).toEqual(affinity)
  expect(capturedSignal).toBe(controller.signal)
})

test("does not require max_tokens", async () => {
  const result = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  })

  expect(result).toEqual({ input_tokens: 42 })
  expect(capturedBody).toEqual({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  })
})

test("returns only the validated token count field", async () => {
  queuedResponse = Response.json({
    input_tokens: 42,
    private_upstream_metadata: "do-not-forward",
  })

  const result = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  })

  expect(result).toEqual({ input_tokens: 42 })
})

test("throws the upstream HTTP error instead of fabricating one token", async () => {
  queuedResponse = Response.json(
    { type: "error", error: { type: "invalid_request_error", message: "bad" } },
    { status: 400 },
  )

  const error = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  }).catch((caught: unknown) => caught)

  expect(error).toHaveProperty("response.status", 400)
})

test.each([
  ["missing", {}],
  ["negative", { input_tokens: -1 }],
  ["fractional", { input_tokens: 1.5 }],
  ["string", { input_tokens: "42" }],
] as const)("rejects a %s upstream token count", async (_name, body) => {
  queuedResponse = Response.json(body)

  const error = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  }).catch((caught: unknown) => caught)

  expect(error).toHaveProperty(
    "message",
    "Invalid token count response from upstream",
  )
  expect(error).toHaveProperty("response.status", 502)
})

test("rejects invalid JSON from a successful upstream response", async () => {
  queuedResponse = new Response("not-json", { status: 200 })

  const error = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
  }).catch((caught: unknown) => caught)

  expect(error).toHaveProperty(
    "message",
    "Invalid token count response from upstream",
  )
  expect(error).toHaveProperty("response.status", 502)
})
