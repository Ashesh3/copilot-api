import type { Context } from "hono"

import { expect, test } from "bun:test"

import type { AnthropicStreamState } from "../src/routes/messages/anthropic-types"
import type { ChatCompletionChunk } from "../src/services/copilot/create-chat-completions"

import { HTTPError, inspectHttpError } from "../src/lib/error"
import { createMessagesTerminalAdapter } from "../src/routes/messages/stream-lifecycle"
import {
  closeAnthropicOpenBlocks,
  createFallbackMessageDeltaEvents,
  translateChunkToAnthropicEvents,
} from "../src/routes/messages/stream-translation"

function createChatState(): AnthropicStreamState {
  return {
    terminal: "open",
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
}

function chatChunk(
  delta: Record<string, unknown>,
  finishReason:
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter"
    | null = null,
): ChatCompletionChunk {
  return {
    id: "chatcmpl-lifecycle",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-current",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  } as ChatCompletionChunk
}

function createRecordingMessagesAdapter(
  closeOpenBlocks: () => ReturnType<typeof closeAnthropicOpenBlocks>,
) {
  const output: Array<Record<string, unknown>> = []
  const stream = {
    aborted: false,
    closed: false,
    writeSSE(frame: { data: string }) {
      output.push(JSON.parse(frame.data) as Record<string, unknown>)
      return Promise.resolve()
    },
  }
  return {
    adapter: createMessagesTerminalAdapter({
      c: {
        req: { method: "GET", path: "/test/messages-stream" },
      } as Context,
      stream,
      closeOpenBlocks,
    }),
    output,
    stream,
  }
}

test("closes pending thinking signature and tool block before one failure", async () => {
  const state = createChatState()
  const { adapter, output } = createRecordingMessagesAdapter(() =>
    closeAnthropicOpenBlocks(state),
  )
  for (const chunk of [
    chatChunk({ reasoning_text: "thought" }),
    chatChunk({ reasoning_opaque: "opaque-signature" }),
    chatChunk({ content: "answer" }),
    chatChunk({ tool_calls: [{ index: 0, id: "call_", type: "function" }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { name: "lookup" } }] }),
    chatChunk({
      tool_calls: [{ index: 0, function: { arguments: '{"q":' } }],
    }),
  ])
    output.push(...translateChunkToAnthropicEvents(chunk, state))

  await adapter.fail({ kind: "thrown", error: new Error("private") })
  await adapter.finishSource()

  expect(output.map((event) => event.type)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "error",
  ])
  expect(output[3]).toMatchObject({
    delta: { type: "signature_delta", signature: "opaque-signature" },
  })
  expect(output[8]).toMatchObject({
    content_block: { type: "tool_use", id: "call_", name: "lookup" },
  })
  expect(output.at(-1)).toEqual({
    type: "error",
    error: {
      type: "api_error",
      message: "The Copilot Messages request failed.",
    },
  })
  expect(output.some((event) => event.type === "message_delta")).toBe(false)
  expect(output.some((event) => event.type === "message_stop")).toBe(false)
})

test("requires a real Chat finish reason before writing the success terminal", () => {
  const state = createChatState()
  translateChunkToAnthropicEvents(chatChunk({ content: "partial" }), state)
  expect(createFallbackMessageDeltaEvents(state)).toEqual([])
  expect(state.terminal).toBe("open")
  translateChunkToAnthropicEvents(chatChunk({}, "stop"), state)
  expect(
    createFallbackMessageDeltaEvents(state).map((event) => event.type),
  ).toEqual(["message_delta", "message_stop"])
  expect(createFallbackMessageDeltaEvents(state)).toEqual([])
  expect(state.terminal).toBe("succeeded")
})

test("buffers Chat argument fragments until split tool identity is complete", () => {
  const state = createChatState()
  const translated = [
    chatChunk({
      tool_calls: [{ index: 0, function: { arguments: '{"q":"docs"}' } }],
    }),
    chatChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "lookup" },
        },
      ],
    }),
  ].flatMap((chunk) => translateChunkToAnthropicEvents(chunk, state))

  expect(translated).toContainEqual({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"q":"docs"}' },
  })
})

test("preserves exact textual and binary upstream failures once", async () => {
  for (const fixture of [
    {
      body: new TextEncoder().encode("  exact text\r\n  "),
      contentType: "text/plain; charset=utf-8",
      expected: { message: "  exact text\r\n  " },
    },
    {
      body: Uint8Array.from([0, 255, 128, 65]),
      contentType: "application/octet-stream",
      expected: {
        message: "The Copilot Messages request failed.",
        body_bytes: [0, 255, 128, 65],
      },
    },
  ] as const) {
    const { adapter, output } = createRecordingMessagesAdapter(() => [])
    const error = new HTTPError(
      "private status text",
      new Response(fixture.body.slice(), {
        status: 429,
        statusText: "Private Status",
        headers: { "content-type": fixture.contentType },
      }),
    )
    await adapter.fail({
      kind: "thrown",
      error,
      inspection: await inspectHttpError(error),
    })
    await adapter.fail({ kind: "thrown", error })
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({
      type: "error",
      error: {
        type: "api_error",
        status: 429,
        content_type: fixture.contentType,
        ...fixture.expected,
      },
    })
  }
})

test("emits nothing after downstream abort", async () => {
  const state = createChatState()
  const { adapter, output, stream } = createRecordingMessagesAdapter(() =>
    closeAnthropicOpenBlocks(state),
  )
  output.push(
    ...translateChunkToAnthropicEvents(
      chatChunk({ content: "partial" }),
      state,
    ),
  )
  stream.aborted = true
  await adapter.fail({ kind: "thrown", error: new Error("late") })
  await adapter.succeed(() => Promise.resolve())
  expect(output.at(-1)?.type).toBe("content_block_delta")
})
