import { expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import type { ResponsesResult } from "../src/services/copilot/create-responses"

import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "../src/routes/messages/responses-translation"

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

test("maps raw Responses reasoning content into Anthropic thinking", () => {
  const response: ResponsesResult = {
    id: "resp_reasoning_content",
    object: "response",
    created_at: 1,
    model: "gpt-5.3-codex",
    output_text: "done",
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    output: [
      {
        id: "rs_1",
        type: "reasoning",
        summary: [],
        content: [
          { type: "reasoning_text", text: "raw " },
          { type: "reasoning_text", text: "thinking" },
        ],
        encrypted_content: "encrypted-reasoning",
      },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    ],
  }

  const anthropic = translateResponsesResultToAnthropic(response)

  expect(anthropic.content[0]).toEqual({
    type: "thinking",
    thinking: "raw thinking",
    signature: "encrypted-reasoning@rs_1",
  })
})
