import { expect, test } from "bun:test"

import type { AnthropicContentBlockDeltaEvent } from "../src/routes/messages/anthropic-types"
import type {
  ResponseCompletedEvent,
  ResponseCreatedEvent,
  ResponseErrorEvent,
  ResponseFailedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseOutputItemDoneEvent,
  ResponseReasoningTextDeltaEvent,
} from "../src/services/copilot/create-responses"

import {
  closeResponsesOpenBlocks,
  createResponsesNormalTerminalEvents,
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

  const result = translateResponsesStreamEvent(event, state)
  if (result.kind !== "events") throw new Error("Expected translated events")
  const translated = result.events

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

test("emits unsigned thinking when completed Responses reasoning has no encrypted content", () => {
  const state = createResponsesStreamState()
  const result = translateResponsesStreamEvent(
    {
      type: "response.output_item.done",
      sequence_number: 2,
      output_index: 0,
      item: {
        id: "rs_unsigned",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "visible reasoning" }],
        encrypted_content: null,
      },
    } as unknown as ResponseOutputItemDoneEvent,
    state,
  )

  if (result.kind !== "events") throw new Error("Expected events")
  expect(result.events).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "visible reasoning" },
    },
  ])
  expect(JSON.stringify(result.events)).not.toContain("signature_delta")
  expect(JSON.stringify(result.events)).not.toContain("@rs_unsigned")
})

test("emits no thinking block for empty unsigned Responses reasoning", () => {
  const state = createResponsesStreamState()
  const result = translateResponsesStreamEvent(
    {
      type: "response.output_item.done",
      sequence_number: 2,
      output_index: 0,
      item: {
        id: "rs_empty",
        type: "reasoning",
        summary: [],
        encrypted_content: null,
      },
    } as unknown as ResponseOutputItemDoneEvent,
    state,
  )

  if (result.kind !== "events") throw new Error("Expected events")
  expect(result.events).toEqual([])
  expect(state.openBlocks.size).toBe(0)
})

test("preserves Responses recommendation and Copilot usage in Anthropic events", () => {
  const state = createResponsesStreamState()
  const response = {
    id: "resp-meta",
    object: "response",
    created_at: 1,
    model: "gpt-current",
    output: [],
    output_text: "",
    status: "completed",
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    recommended_auto_tier: "balanced",
    copilot_usage: { total_nano_aiu: 456 },
  } as ResponseCreatedEvent["response"] & {
    recommended_auto_tier: "balanced"
    copilot_usage: { total_nano_aiu: number }
  }
  const created: ResponseCreatedEvent = {
    type: "response.created",
    sequence_number: 1,
    response,
  }
  const completed: ResponseCompletedEvent = {
    type: "response.completed",
    sequence_number: 2,
    response,
  }

  const createdResult = translateResponsesStreamEvent(created, state)
  if (createdResult.kind !== "events") throw new Error("Expected events")
  expect(createdResult.events).toMatchObject([
    { message: { recommended_auto_tier: "balanced" } },
  ])
  const completedResult = translateResponsesStreamEvent(completed, state)
  if (completedResult.kind !== "success") throw new Error("Expected success")
  expect([
    ...closeResponsesOpenBlocks(state),
    ...createResponsesNormalTerminalEvents(state, completedResult.response),
  ]).toMatchObject([
    { copilot_usage: { total_nano_aiu: 456 } },
    { type: "message_stop" },
  ])
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
  "preserves the upstream Responses message for Anthropic $name events",
  ({ event }) => {
    const translated = translateResponsesStreamEvent(
      event,
      createResponsesStreamState(),
    )
    if (translated.kind !== "failure") throw new Error("Expected failure")
    expect(translated.error).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message:
          event.type === "error" ?
            "responses-error-private-marker"
          : "responses-failed-private-marker",
        ...(event.type === "error" ?
          { code: "upstream_private_code", param: "private_param" }
        : {}),
      },
    })
  },
)

test("closes Responses blocks in ascending order and only once", () => {
  const state = createResponsesStreamState()
  state.openBlocks.add(7)
  state.openBlocks.add(2)
  state.openBlocks.add(4)
  state.blockHasDelta.add(4)
  state.functionCallStateByOutputIndex.set(1, {
    blockIndex: 7,
    toolCallId: "call_7",
    name: "lookup",
    pendingArguments: [],
  })

  expect(closeResponsesOpenBlocks(state)).toEqual([
    { type: "content_block_stop", index: 2 },
    { type: "content_block_stop", index: 4 },
    { type: "content_block_stop", index: 7 },
  ])
  expect(closeResponsesOpenBlocks(state)).toEqual([])
  expect(state.blockHasDelta.size).toBe(0)
  expect(state.functionCallStateByOutputIndex.size).toBe(0)
})

test("keeps an unknown Responses event open and does not infer success", () => {
  const state = createResponsesStreamState()
  const result = translateResponsesStreamEvent(
    {
      type: "response.future_event",
      sequence_number: 9,
      future: true,
    } as never,
    state,
  )

  expect(result).toEqual({ kind: "events", events: [] })
  expect(state.terminal).toBe("open")
})

test("preserves split Responses tool id and name before argument deltas", () => {
  const state = createResponsesStreamState()
  const fragments = [
    { call_id: "call_", name: "" },
    { call_id: "7", name: "" },
  ]
  const translated = fragments.flatMap((fragment, sequenceNumber) => {
    const result = translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        sequence_number: sequenceNumber,
        output_index: 2,
        item: {
          id: "item_2",
          type: "function_call",
          status: "in_progress",
          arguments: "",
          ...fragment,
        },
      } as never,
      state,
    )
    if (result.kind !== "events") throw new Error("Expected events")
    return result.events
  })
  const earlyArgumentsResult = translateResponsesStreamEvent(
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 4,
      output_index: 2,
      item_id: "item_2",
      delta: '{"q":"docs"}',
    } satisfies ResponseFunctionCallArgumentsDeltaEvent,
    state,
  )
  if (earlyArgumentsResult.kind !== "events") throw new Error("Expected events")
  translated.push(...earlyArgumentsResult.events)
  const doneResult = translateResponsesStreamEvent(
    {
      type: "response.function_call_arguments.done",
      sequence_number: 5,
      output_index: 2,
      item_id: "item_2",
      name: "lookup",
      arguments: '{"q":"docs"}',
    },
    state,
  )
  if (doneResult.kind !== "events") throw new Error("Expected events")
  translated.push(...doneResult.events)

  expect(translated).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call_7",
        name: "lookup",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"q":"docs"}' },
    },
  ])
})

test.each(["incomplete", "failed", "eof"] as const)(
  "starts an empty-argument Responses tool before %s and closes it",
  (terminal) => {
    const state = createResponsesStreamState()
    const added = translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: {
          id: "item_empty",
          type: "function_call",
          status: "in_progress",
          call_id: "call_empty",
          name: "lookup",
          arguments: "",
        },
      } as never,
      state,
    )
    if (added.kind !== "events") throw new Error("Expected events")

    const terminalResult =
      terminal === "eof" ? undefined : (
        translateResponsesStreamEvent(
          terminal === "incomplete" ?
            ({
              type: "response.incomplete",
              sequence_number: 2,
              response: {
                id: "resp_empty",
                object: "response",
                created_at: 1,
                status: "incomplete",
                model: "gpt-4o",
                output: [],
                output_text: "",
                parallel_tool_calls: true,
                tool_choice: "auto",
                tools: [],
              },
            } as never)
          : ({
              type: "response.failed",
              sequence_number: 2,
              response: {
                id: "resp_empty",
                object: "response",
                created_at: 1,
                status: "failed",
                model: "gpt-4o",
                output: [],
                output_text: "",
                parallel_tool_calls: true,
                tool_choice: "auto",
                tools: [],
              },
            } as never),
          state,
        )
      )

    expect(added.events).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_empty",
          name: "lookup",
          input: {},
        },
      },
    ])
    let expectedKind: "failure" | "success" | undefined
    if (terminal === "incomplete") expectedKind = "success"
    else if (terminal === "failed") expectedKind = "failure"
    expect(terminalResult?.kind).toBe(expectedKind)
    expect(closeResponsesOpenBlocks(state)).toEqual([
      { type: "content_block_stop", index: 0 },
    ])
  },
)
