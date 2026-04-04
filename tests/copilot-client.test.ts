import { describe, expect, test } from "bun:test"

import {
  addPromptCaching,
  isDeterministic400,
} from "~/services/copilot/copilot-client"

describe("addPromptCaching", () => {
  test("adds cache control to the last non-user message", () => {
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "user-1" },
      { role: "assistant", content: "assistant-1" },
      { role: "user", content: "user-2" },
    ]

    addPromptCaching(messages)

    expect(
      (messages[2] as Record<string, unknown>).copilot_cache_control,
    ).toEqual({ type: "ephemeral" })
    expect(
      (messages[3] as Record<string, unknown>).copilot_cache_control,
    ).toBeUndefined()
  })

  test("skips reasoning-only assistant messages for checkpoint placement", () => {
    const messages = [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: null,
        reasoning_text: "thinking",
        reasoning_opaque: "signature",
      },
      { role: "user", content: "latest-user" },
    ]

    addPromptCaching(messages)

    expect(
      (messages[0] as Record<string, unknown>).copilot_cache_control,
    ).toEqual({ type: "ephemeral" })
    expect(
      (messages[1] as Record<string, unknown>).copilot_cache_control,
    ).toBeUndefined()
  })

  test("adds cache control to the last tool definition", () => {
    const messages = [{ role: "user", content: "hello" }]
    const tools = [
      { type: "function", function: { name: "one", parameters: {} } },
      { type: "function", function: { name: "two", parameters: {} } },
    ]

    addPromptCaching(messages, tools)

    expect((tools[1] as Record<string, unknown>).copilot_cache_control).toEqual(
      { type: "ephemeral" },
    )
    expect(
      (tools[0] as Record<string, unknown>).copilot_cache_control,
    ).toBeUndefined()
  })
})

describe("isDeterministic400", () => {
  test("should detect Invalid signature error", () => {
    const body =
      '{"error":{"message":"messages.1.content.0: Invalid `signature` in `thinking` block","code":"invalid_request_body"}}'
    expect(isDeterministic400(body)).toBe(true)
  })

  test("should detect plain Invalid signature text", () => {
    expect(isDeterministic400("Invalid signature in thinking block")).toBe(true)
  })

  test("should detect model_not_supported error", () => {
    const body =
      '{"error":{"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}}'
    expect(isDeterministic400(body)).toBe(true)
  })

  test("should detect messages must be non-empty error", () => {
    const body = '{"error":{"message":"messages must be non-empty","code":""}}'
    expect(isDeterministic400(body)).toBe(true)
  })

  test("should detect invalid_request_body error", () => {
    const body =
      '{"error":{"message":"some validation error","code":"invalid_request_body"}}'
    expect(isDeterministic400(body)).toBe(true)
  })

  test("should NOT flag transient 400 errors", () => {
    const body =
      '{"error":{"message":"rate limit exceeded","code":"rate_limit"}}'
    expect(isDeterministic400(body)).toBe(false)
  })

  test("should handle empty body", () => {
    expect(isDeterministic400("")).toBe(false)
  })

  test("should flag generic 'Bad Request' body as deterministic", () => {
    expect(isDeterministic400("Bad Request")).toBe(true)
    expect(isDeterministic400("Bad Request\n")).toBe(true)
  })

  test("should NOT flag 'Bad Request' embedded in other error messages", () => {
    const body = '{"error":"Bad Request: rate limit exceeded"}'
    expect(isDeterministic400(body)).toBe(false)
  })
})
