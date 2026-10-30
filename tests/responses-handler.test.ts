import { expect, test } from "bun:test"

import type {
  ResponsesPayload,
  ResponseUsage,
} from "../src/services/copilot/create-responses"

import { LocalHTTPError } from "../src/lib/error"
import { readChatReasoningEnvelope } from "../src/routes/responses/chat-reasoning-provenance"
import {
  assertResponsesChatFallbackTranslation,
  responsesToChatCompletions,
  streamChatCompletionsAsResponses,
  useFunctionApplyPatch,
} from "../src/routes/responses/handler"
import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

function chatStream(
  chunks: Array<Record<string, unknown> | "[DONE]">,
): AsyncIterable<{ data: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        await Promise.resolve()
        yield { data: chunk === "[DONE]" ? chunk : JSON.stringify(chunk) }
      }
    },
  }
}

test("preserves trailing Chat usage before completing a Responses stream", async () => {
  const events: Array<{ data: Record<string, unknown>; event?: string }> = []
  const stream = {
    writeSSE(message: { data: string; event?: string }) {
      events.push({
        data: JSON.parse(message.data) as Record<string, unknown>,
        ...(message.event ? { event: message.event } : {}),
      })
      return Promise.resolve()
    },
  }

  const source = chatStream([
    {
      id: "chat_trailing_usage",
      created: 1,
      model: "chat-only",
      choices: [
        {
          index: 0,
          delta: { content: "kept" },
          finish_reason: "stop",
        },
      ],
    },
    {
      id: "chat_trailing_usage",
      created: 1,
      model: "chat-only",
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    },
    "[DONE]",
  ])

  const outcome = await streamChatCompletionsAsResponses(
    stream,
    source,
    "requested-model",
  )
  const terminals = events.filter(
    (event) =>
      event.event === "response.completed"
      || event.event === "response.incomplete",
  )

  expect(outcome.terminal).toBe("response.completed")
  expect(terminals).toHaveLength(1)
  expect(terminals[0]?.data.response).toMatchObject({
    output_text: "kept",
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 3 },
    },
  })
})

test("reports trailing Chat usage before a stalled stream reaches DONE", async () => {
  const waiting = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const observed: Array<ResponseUsage | null> = []
  const eventTypes: Array<string | undefined> = []
  const source = {
    async *[Symbol.asyncIterator]() {
      yield {
        data: JSON.stringify({
          id: "chat_stalled_usage",
          choices: [
            { index: 0, delta: { content: "kept" }, finish_reason: "stop" },
          ],
        }),
      }
      yield {
        data: JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
      }
      waiting.resolve(undefined)
      await release.promise
      yield { data: "[DONE]" }
    },
  }
  const pending = streamChatCompletionsAsResponses(
    {
      writeSSE: (event) => {
        eventTypes.push(event.event)
        return Promise.resolve()
      },
    },
    source,
    {
      model: "requested-model",
      onUsage: (usage: ResponseUsage | null) => {
        observed.push(usage)
      },
    },
  )
  try {
    await waiting.promise
    expect(observed).toEqual([
      {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 3 },
      },
    ])
    expect(eventTypes).not.toContain("response.completed")
  } finally {
    release.resolve(undefined)
    await pending
  }
})

test("ignores Chat output deltas received after its finish chunk", async () => {
  const events: Array<{ data: Record<string, unknown>; event?: string }> = []
  const stream = {
    writeSSE(message: { data: string; event?: string }) {
      events.push({
        data: JSON.parse(message.data) as Record<string, unknown>,
        ...(message.event ? { event: message.event } : {}),
      })
      return Promise.resolve()
    },
  }

  const source = chatStream([
    {
      choices: [
        { index: 0, delta: { content: "before" }, finish_reason: "stop" },
      ],
    },
    {
      choices: [{ index: 0, delta: { content: "after" }, finish_reason: null }],
    },
    "[DONE]",
  ])

  await streamChatCompletionsAsResponses(stream, source, "requested-model")

  expect(JSON.stringify(events)).toContain("before")
  expect(JSON.stringify(events)).not.toContain("after")
})

test("keeps non-apply_patch custom tools unchanged on the native responses path", () => {
  const payload = {
    model: "gpt-4o",
    input: "Hello",
    tools: [
      {
        type: "custom",
        name: "run_sql",
        description: "Execute a SQL query",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ],
  } as ResponsesPayload

  useFunctionApplyPatch(payload)

  expect(payload.tools).toEqual([
    {
      type: "custom",
      name: "run_sql",
      description: "Execute a SQL query",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  ])
})

test("rejects custom tool semantics in chat completions fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: "Hello",
    tools: [
      {
        type: "custom",
        name: "run_sql",
        description: "Execute a SQL query",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ],
  } as ResponsesPayload

  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
})

test("preserves custom tool calls and results for compaction fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_custom",
        name: "exec",
        input: "run canonical command",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_custom",
        output: "canonical result",
      },
    ],
  } as ResponsesPayload

  const result = responsesToChatCompletions(payload, {
    preserveCustomToolContext: true,
  })

  expect(result.messages).toEqual([
    {
      role: "assistant",
      content: "[Custom tool call call_custom: exec(run canonical command)]",
    },
    {
      role: "user",
      content: "[Custom tool result call_custom: canonical result]",
    },
  ])
})

test("rejects ordinary computer output but preserves it for compaction", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "computer_call_output",
        call_id: "call_computer",
        output: "canonical computer result",
      },
    ],
  } as ResponsesPayload

  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
  expect(
    responsesToChatCompletions(payload, { preserveCustomToolContext: true })
      .messages,
  ).toEqual([
    {
      role: "user",
      content:
        "[Computer tool result call_computer: canonical computer result]",
    },
  ])
})

test("maps Responses parallel tools reasoning and user controls to Chat", () => {
  const result = responsesToChatCompletions({
    model: "gpt-4o",
    input: "hello",
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ],
    parallel_tool_calls: false,
    reasoning: { effort: "high" },
    user: "user-safe",
  })

  expect(result.parallel_tool_calls).toBe(false)
  expect(result.reasoning_effort).toBe("high")
  expect(result.user).toBe("user-safe")
})

test("rejects malformed function calls before Chat fallback conversion", () => {
  expect(() =>
    responsesToChatCompletions({
      model: "chat-only",
      input: [{ type: "function_call", call_id: "call_1", name: "lookup" }],
    } as ResponsesPayload),
  ).toThrow(LocalHTTPError)
})

test("rejects unknown and malformed tools before Chat fallback conversion", () => {
  for (const tool of [
    { type: "future_private_tool", secret: "private" },
    {
      type: "function",
      name: "lookup",
      parameters: "private-schema",
      strict: false,
    },
  ]) {
    expect(() =>
      responsesToChatCompletions({
        model: "chat-only",
        input: "hello",
        tools: [tool],
      } as ResponsesPayload),
    ).toThrow(LocalHTTPError)
  }
})

test("compaction fallback still rejects unrelated lossy Responses state", () => {
  expect(() =>
    assertResponsesChatFallbackTranslation(
      {
        model: "gpt-4o",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_custom",
            name: "exec",
            input: "run",
          },
        ],
        tools: [{ type: "namespace", name: "private_namespace" }],
      },
      true,
    ),
  ).toThrow(LocalHTTPError)
})

test("compaction fallback rejects unknown future input items", () => {
  expect(() =>
    assertResponsesChatFallbackTranslation(
      {
        model: "gpt-4o",
        input: [{ type: "future_SECRET_item", value: "private" }],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
      },
      true,
    ),
  ).toThrow(LocalHTTPError)
})

test("rejects ordinary custom tool history in chat completions fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_ordinary_custom",
        name: "exec",
        input: "ordinary command",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_ordinary_custom",
        output: "ordinary result",
      },
    ],
  } as ResponsesPayload

  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
})

test("rejects a lossy Responses to Chat fallback before conversion", () => {
  expect(() =>
    responsesToChatCompletions({
      model: "chat-only",
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-encrypted-state",
          summary: [],
        },
      ],
    }),
  ).toThrow(LocalHTTPError)

  try {
    responsesToChatCompletions({
      model: "chat-only",
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-encrypted-state",
          summary: [],
        },
      ],
    })
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect((error as LocalHTTPError).clientBody).toEqual({
      error: {
        code: "endpoint_translation_unsupported",
        message:
          "The selected Copilot model cannot accept this request without losing required protocol data.",
        param: "opaque_reasoning",
        type: "invalid_request_error",
      },
    })
  }
})

function collectEvents(): {
  events: Array<Record<string, unknown>>
  stream: { writeSSE: (message: { data: string }) => Promise<void> }
} {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    stream: {
      writeSSE(message) {
        events.push(JSON.parse(message.data) as Record<string, unknown>)
        return Promise.resolve()
      },
    },
  }
}

function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "chat_reasoning",
    created: 1,
    model: "chat-only",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

test("streams Chat reasoning live and binds its state to the upstream model", async () => {
  const { events, stream } = collectEvents()

  await streamChatCompletionsAsResponses(
    stream,
    chatStream([
      chatChunk({ role: "assistant", reasoning_text: "Weighing " }),
      chatChunk({ reasoning_text: "the options." }),
      chatChunk({ content: "Use the cache.", reasoning_opaque: "partial" }),
      chatChunk({ reasoning_opaque: "complete" }, "stop"),
      "[DONE]",
    ]),
    { model: "client-model", reasoningModel: "chat-only" },
  )

  expect(events.map((event) => event.type)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.delta",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ])
  expect(events.map((event) => event.sequence_number)).toEqual(
    events.map((_, index) => index),
  )
  const response = events.at(-1)?.response as {
    model: string
    output: Array<Record<string, unknown>>
  }
  expect(response.model).toBe("client-model")
  expect(response.output.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
  ])
  expect(response.output[0]).toMatchObject({
    id: "rs_resp_chat_reasoning",
    summary: [{ type: "summary_text", text: "Weighing the options." }],
  })
  expect(events[10]).toMatchObject({ item: response.output[0] })
  expect(
    readChatReasoningEnvelope(response.output[0].encrypted_content),
  ).toEqual({ model: "chat-only", reasoning_opaque: "complete" })
})

test("completes Chat reasoning before the output it produced", async () => {
  const { events, stream } = collectEvents()

  await streamChatCompletionsAsResponses(
    stream,
    chatStream([
      chatChunk({ role: "assistant", content: "Answer." }),
      chatChunk({ reasoning_opaque: "late-state" }, "stop"),
      "[DONE]",
    ]),
    "chat-only",
  )

  const done = events.filter(
    (event) => event.type === "response.output_item.done",
  )
  expect(done.map((event) => [event.output_index, event.item])).toEqual([
    [1, expect.objectContaining({ type: "reasoning", summary: [] }) as unknown],
    [0, expect.objectContaining({ type: "message" }) as unknown],
  ])
  const response = events.at(-1)?.response as {
    output: Array<Record<string, unknown>>
  }
  expect(response.output.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
  ])
  expect(
    readChatReasoningEnvelope(response.output[0].encrypted_content),
  ).toEqual({ model: "chat-only", reasoning_opaque: "late-state" })
})

test("opens the Chat text part before its first delta and closes it", async () => {
  const { events, stream } = collectEvents()

  await streamChatCompletionsAsResponses(
    stream,
    chatStream([
      chatChunk({ role: "assistant", content: "Hel" }),
      chatChunk({ content: "lo" }, "stop"),
      "[DONE]",
    ]),
    "chat-only",
  )

  expect(events.map((event) => event.type)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ])
  const part = { item_id: "msg_cc_001", output_index: 0, content_index: 0 }
  expect(events[2]).toMatchObject({
    ...part,
    part: { type: "output_text", text: "", annotations: [] },
  })
  expect(events[6]).toMatchObject({
    ...part,
    part: { type: "output_text", text: "Hello", annotations: [] },
  })
})

/**
 * Codex applies text and summary deltas to the message or reasoning item it
 * saw added last, and any `output_item.done` ends that item.
 */
function deltasOutsideActiveItem(
  events: Array<Record<string, unknown>>,
): Array<string> {
  let active: string | undefined
  const misplaced: Array<string> = []
  for (const event of events) {
    const item = event.item as { id?: string; type?: string } | undefined
    if (event.type === "response.output_item.added") {
      if (item?.type === "message" || item?.type === "reasoning") {
        active = item.id
      }
    } else if (event.type === "response.output_item.done") {
      active = undefined
    } else if (
      (event.type === "response.output_text.delta"
        || event.type === "response.reasoning_summary_part.added"
        || event.type === "response.reasoning_summary_text.delta")
      && event.item_id !== active
    ) {
      misplaced.push(`${event.type} ${JSON.stringify(event.delta)}`)
    }
  }
  return misplaced
}

test("holds Chat reasoning state that arrives after the text started", async () => {
  const { events, stream } = collectEvents()

  await streamChatCompletionsAsResponses(
    stream,
    chatStream([
      chatChunk({ role: "assistant", content: "Hello" }),
      chatChunk({
        content: " world",
        reasoning_opaque: "late-signature",
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "shell", arguments: "{}" },
          },
        ],
      }),
      chatChunk({}, "tool_calls"),
      "[DONE]",
    ]),
    "chat-only",
  )

  expect(deltasOutsideActiveItem(events)).toEqual([])
  const added = events.filter(
    (event) => event.type === "response.output_item.added",
  )
  expect(
    added.map((event) => [
      event.output_index,
      (event.item as { type: string }).type,
    ]),
  ).toEqual([
    [0, "message"],
    [1, "function_call"],
    [2, "reasoning"],
  ])
  const reasoningAdded = events.indexOf(added[2])
  expect(events[reasoningAdded + 1]).toMatchObject({
    type: "response.output_item.done",
    output_index: 2,
  })
  const response = events.at(-1)?.response as {
    output: Array<Record<string, unknown>>
  }
  expect(response.output.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
    "function_call",
  ])
  expect(
    readChatReasoningEnvelope(response.output[0].encrypted_content),
  ).toEqual({ model: "chat-only", reasoning_opaque: "late-signature" })
})

test("holds interleaved Chat thinking once the answer started", async () => {
  const { events, stream } = collectEvents()

  await streamChatCompletionsAsResponses(
    stream,
    chatStream([
      chatChunk({ role: "assistant", reasoning_text: "First thought." }),
      chatChunk({ content: "Answer part." }),
      chatChunk({
        reasoning_text: " Second thought.",
        reasoning_opaque: "sig",
      }),
      chatChunk({ content: " More." }),
      chatChunk({}, "stop"),
      "[DONE]",
    ]),
    "chat-only",
  )

  expect(deltasOutsideActiveItem(events)).toEqual([])
  expect(
    events
      .filter((event) => event.type === "response.reasoning_summary_text.delta")
      .map((event) => event.delta),
  ).toEqual(["First thought."])
  expect(
    events.find(
      (event) => event.type === "response.reasoning_summary_text.done",
    ),
  ).toMatchObject({ text: "First thought. Second thought." })
  const response = events.at(-1)?.response as {
    output: Array<Record<string, unknown>>
  }
  expect(response.output[0]).toMatchObject({
    type: "reasoning",
    summary: [{ type: "summary_text", text: "First thought. Second thought." }],
  })
  expect(
    readChatReasoningEnvelope(response.output[0].encrypted_content),
  ).toEqual({ model: "chat-only", reasoning_opaque: "sig" })
  expect(response.output[1]).toMatchObject({
    type: "message",
    content: [{ type: "output_text", text: "Answer part. More." }],
  })
})
