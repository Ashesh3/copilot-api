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
