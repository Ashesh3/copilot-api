import { expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { translateAnthropicMessagesToResponsesPayload } from "../src/routes/messages/responses-translation"

test("keeps Anthropics max_tokens when translating to Responses payload", () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 64,
  }

  const translated = translateAnthropicMessagesToResponsesPayload(payload)

  expect(translated.max_output_tokens).toBe(64)
})

test("derives safety and cache fields from Claude JSON metadata.user_id", () => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 64,
    metadata: {
      user_id: JSON.stringify({
        device_id: "device-123",
        account_uuid: "account-456",
        session_id: "session-789",
      }),
    },
  }

  const translated = translateAnthropicMessagesToResponsesPayload(payload)

  expect(translated.safety_identifier).toBe("account-456")
  expect(translated.prompt_cache_key).toBe("session-789")
})
