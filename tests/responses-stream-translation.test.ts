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
  ResponseReasoningSummaryTextDoneEvent,
} from "../src/services/copilot/create-responses"

import {
  closeResponsesOpenBlocks,
  createResponsesNormalTerminalEvents,
  createResponsesStreamState,
  type TranslatableResponsesStreamEvent,
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

test("does not repeat a done-only reasoning summary before its signature", () => {
  const state = createResponsesStreamState()
  const summary = translateResponsesStreamEvent(
    {
      type: "response.reasoning_summary_text.done",
      sequence_number: 1,
      item_id: "rs_done",
      output_index: 0,
      summary_index: 0,
      text: "visible reasoning",
    } satisfies ResponseReasoningSummaryTextDoneEvent,
    state,
  )
  const itemDone = translateResponsesStreamEvent(
    {
      type: "response.output_item.done",
      sequence_number: 2,
      output_index: 0,
      item: {
        id: "rs_done",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "visible reasoning" }],
        encrypted_content: "encrypted-state",
      },
    } as ResponseOutputItemDoneEvent,
    state,
  )

  if (summary.kind !== "events" || itemDone.kind !== "events") {
    throw new Error("Expected events")
  }
  expect([...summary.events, ...itemDone.events]).toEqual([
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
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "signature_delta",
        signature: "encrypted-state@rs_done",
      },
    },
  ])
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

test("prepends message_start when a Responses terminal arrives first", () => {
  const state = createResponsesStreamState()
  const response = {
    id: "resp_terminal_first",
    object: "response",
    created_at: 1,
    model: "gpt-current",
    output: [],
    output_text: "",
    status: "completed",
    usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  } as ResponseCompletedEvent["response"]

  const events = createResponsesNormalTerminalEvents(state, response)
  expect(events.map((event) => event.type)).toEqual([
    "message_start",
    "message_delta",
    "message_stop",
  ])
  expect(events[0]).toMatchObject({
    type: "message_start",
    message: {
      id: "resp_terminal_first",
      model: "gpt-current",
    },
  })
  expect(createResponsesNormalTerminalEvents(state, response)).toEqual([])
})

test("closes Responses text before opening thinking at the next index", () => {
  const state = createResponsesStreamState()
  const text = translateResponsesStreamEvent(
    {
      type: "response.output_text.delta",
      sequence_number: 1,
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "answer",
    },
    state,
  )
  const thinking = translateResponsesStreamEvent(
    {
      type: "response.reasoning_text.delta",
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      delta: "reconsidering",
    } as ResponseReasoningTextDeltaEvent,
    state,
  )

  if (text.kind !== "events" || thinking.kind !== "events") {
    throw new Error("Expected translated events")
  }
  expect([...text.events, ...thinking.events]).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "answer" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: "reconsidering" },
    },
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

function translatedEventsOf(
  state: ReturnType<typeof createResponsesStreamState>,
  events: Array<TranslatableResponsesStreamEvent>,
) {
  return events.flatMap((event) => {
    const result = translateResponsesStreamEvent(event, state)
    if (result.kind !== "events") throw new Error("Expected translated events")
    return result.events
  })
}

const createdResponse = {
  id: "resp_live",
  object: "response",
  created_at: 1,
  model: "gpt-current",
  output: [],
  output_text: "",
  status: "in_progress",
  usage: null,
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
} as ResponseCreatedEvent["response"]

test("turns keep-alives during hidden reasoning into empty thinking deltas", () => {
  const state = createResponsesStreamState()
  translatedEventsOf(state, [
    { type: "response.created", sequence_number: 0, response: createdResponse },
  ])

  const events = translatedEventsOf(state, [
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { id: "rs_live", type: "reasoning", summary: [] },
    },
    { type: "keepalive", sequence_number: 2 },
    { type: "keepalive", sequence_number: 3 },
    {
      type: "response.reasoning_summary_text.delta",
      sequence_number: 4,
      item_id: "rs_live",
      output_index: 0,
      summary_index: 0,
      delta: "Planning the change.",
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: {
        id: "rs_live",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Planning the change." }],
        encrypted_content: "encrypted-state",
      },
    },
  ])

  expect(events).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Planning the change." },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "signature_delta",
        signature: "encrypted-state@rs_live",
      },
    },
  ])
})

test("fills a keep-alive thinking block when reasoning has no summary", () => {
  const state = createResponsesStreamState()
  const events = translatedEventsOf(state, [
    { type: "response.created", sequence_number: 0, response: createdResponse },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { id: "rs_quiet", type: "reasoning", summary: [] },
    },
    { type: "keepalive", sequence_number: 2 },
    {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item: {
        id: "rs_quiet",
        type: "reasoning",
        summary: [],
        encrypted_content: "quiet-state",
      },
    },
  ])

  expect(events.slice(1)).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Thinking..." },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "quiet-state@rs_quiet" },
    },
  ])
})

test("relays keep-alives outside reasoning as pings", () => {
  const state = createResponsesStreamState()
  const beforeStart = translatedEventsOf(state, [
    { type: "keepalive", sequence_number: 0 },
  ])
  const afterStart = translatedEventsOf(state, [
    { type: "response.created", sequence_number: 1, response: createdResponse },
    { type: "keepalive", sequence_number: 2 },
  ])

  expect(beforeStart).toEqual([{ type: "ping" }])
  expect(afterStart.map((event) => event.type)).toEqual([
    "message_start",
    "ping",
  ])
  expect(state.openBlocks.size).toBe(0)
})

test("separates streamed reasoning summary parts", () => {
  const state = createResponsesStreamState()
  const events = translatedEventsOf(state, [
    {
      type: "response.reasoning_summary_text.delta",
      sequence_number: 1,
      item_id: "rs_parts",
      output_index: 0,
      summary_index: 0,
      delta: "First part ends here.",
    },
    {
      type: "response.reasoning_summary_text.delta",
      sequence_number: 2,
      item_id: "rs_parts",
      output_index: 0,
      summary_index: 1,
      delta: "**Second part**",
    },
    {
      type: "response.reasoning_summary_text.done",
      sequence_number: 3,
      item_id: "rs_parts",
      output_index: 0,
      summary_index: 1,
      text: "**Second part**",
    },
    {
      type: "response.reasoning_summary_text.done",
      sequence_number: 4,
      item_id: "rs_parts",
      output_index: 0,
      summary_index: 2,
      text: "Third part arrived only as done.",
    },
  ])

  expect(
    events.flatMap((event) =>
      (
        event.type === "content_block_delta"
        && event.delta.type === "thinking_delta"
      ) ?
        [event.delta.thinking]
      : [],
    ),
  ).toEqual([
    "First part ends here.",
    "\n\n**Second part**",
    "\n\nThird part arrived only as done.",
  ])
})

test("shows a streamed refusal as text", () => {
  const state = createResponsesStreamState()
  const events = translatedEventsOf(state, [
    { type: "response.created", sequence_number: 0, response: createdResponse },
    {
      type: "response.refusal.delta",
      sequence_number: 1,
      item_id: "msg_refusal",
      output_index: 0,
      content_index: 0,
      delta: "I can't help with that.",
    },
    {
      type: "response.refusal.done",
      sequence_number: 2,
      item_id: "msg_refusal",
      output_index: 0,
      content_index: 0,
      refusal: "I can't help with that.",
    },
  ])

  expect(events.slice(1)).toEqual([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "I can't help with that." },
    },
  ])
})

test("restates a Responses context overflow failure as prompt-too-long", () => {
  const state = createResponsesStreamState()
  const result = translateResponsesStreamEvent(
    {
      type: "response.failed",
      sequence_number: 1,
      response: {
        ...createdResponse,
        status: "failed",
        error: {
          code: "context_length_exceeded",
          message:
            "Your input exceeds the context window of this model. Please reduce your input and try again.",
        },
      },
    },
    state,
  )

  if (result.kind !== "failure") throw new Error("Expected a failure")
  expect(result.error).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "prompt is too long: Your input exceeds the context window of this model. Please reduce your input and try again.",
      code: "context_length_exceeded",
    },
  })
})
