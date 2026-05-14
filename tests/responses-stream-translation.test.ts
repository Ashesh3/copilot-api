import { expect, test } from "bun:test"

import type { AnthropicContentBlockDeltaEvent } from "../src/routes/messages/anthropic-types"
import type { ResponseReasoningTextDeltaEvent } from "../src/services/copilot/create-responses"

import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "../src/routes/messages/responses-stream-translation"

test("translates Responses reasoning_text deltas to Anthropic thinking deltas", () => {
  const state = createResponsesStreamState()
  const event: ResponseReasoningTextDeltaEvent = {
    type: "response.reasoning_text.delta",
    content_index: 0,
    delta: "raw reasoning",
    sequence_number: 1,
  }

  const translated = translateResponsesStreamEvent(event, state)

  const delta = translated.find(
    (item): item is AnthropicContentBlockDeltaEvent =>
      item.type === "content_block_delta"
      && item.delta.type === "thinking_delta",
  )
  expect(delta?.delta).toEqual({
    type: "thinking_delta",
    thinking: "raw reasoning",
  })
})
