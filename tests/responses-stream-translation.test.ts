import { expect, test } from "bun:test"

import type { AnthropicContentBlockDeltaEvent } from "../src/routes/messages/anthropic-types"
import type {
  ResponseErrorEvent,
  ResponseFailedEvent,
  ResponseReasoningTextDeltaEvent,
} from "../src/services/copilot/create-responses"

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

test.each([
  {
    name: "response.failed",
    event: {
      type: "response.failed",
      sequence_number: 1,
      response: {
        id: "resp_failed",
        object: "response",
        created_at: 1,
        model: "gpt-current",
        output: [],
        output_text: "",
        status: "failed",
        usage: null,
        error: { message: "responses-failed-private-marker" },
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: true,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
      },
    } satisfies ResponseFailedEvent,
  },
  {
    name: "error",
    event: {
      type: "error",
      code: "upstream_private_code",
      message: "responses-error-private-marker",
      param: "private_param",
      sequence_number: 1,
    } satisfies ResponseErrorEvent,
  },
])(
  "uses a fixed safe Anthropic message for upstream $name events",
  ({ event }) => {
    const translated = translateResponsesStreamEvent(
      event,
      createResponsesStreamState(),
    )
    const output = JSON.stringify(translated)

    expect(translated.at(-1)).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Upstream Responses stream failed.",
      },
    })
    expect(output).not.toContain("private")
    expect(output).not.toContain("upstream_private_code")
  },
)
