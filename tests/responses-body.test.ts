import { describe, expect, test } from "bun:test"

import { parseResponsesBody } from "../ui/src/lib/responses-body"

/* eslint-disable max-lines -- protocol variants intentionally share fixtures */

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ ...data, type })}\n\n`
}

function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  extra: Record<string, unknown> = {},
): string {
  return `data: ${JSON.stringify({
    id: "msg_chat_1",
    object: "chat.completion.chunk",
    created: 1_783_698_410,
    model: "claude-opus-4.8",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...extra,
  })}\n\u200B\n`
}

function anthropicSse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ ...data, type })}\n\n`
}

// Compact fixtures intentionally keep the parser's capture variants together.
// eslint-disable-next-line max-lines-per-function
describe("Responses debug body parser", () => {
  test("assembles Anthropic Messages text deltas and exposes every event", () => {
    const raw = [
      anthropicSse("message_start", {
        message: {
          content: [],
          id: "msg_011CdpQ27rZpAoXmmLG7xR5S",
          model: "claude-opus-5",
          role: "assistant",
          stop_reason: null,
          type: "message",
          usage: {
            cache_creation_input_tokens: 305_438,
            cache_read_input_tokens: 0,
            input_tokens: 2,
            output_tokens: 6,
          },
        },
      }),
      anthropicSse("content_block_start", {
        content_block: { text: "", type: "text" },
        index: 0,
      }),
      anthropicSse("content_block_delta", {
        delta: { text: "Let me verify ", type: "text_delta" },
        index: 0,
      }),
      anthropicSse("content_block_delta", {
        delta: { text: "rather than assume.", type: "text_delta" },
        index: 0,
      }),
      anthropicSse("content_block_stop", { index: 0 }),
      anthropicSse("message_delta", {
        copilot_usage: { total_nano_aiu: 191_627_250_000 },
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          cache_creation_input_tokens: 305_438,
          cache_read_input_tokens: 0,
          input_tokens: 2,
          output_tokens: 14,
        },
      }),
      anthropicSse("message_stop", {}),
      "data: [DONE]\n\n",
    ].join("")

    const parsed = parseResponsesBody(raw)

    expect(parsed?.assistantText).toBe("Let me verify rather than assume.")
    expect(parsed?.reasoningText).toBe("")
    expect(parsed?.status).toBe("completed")
    expect(parsed?.response).toMatchObject({
      id: "msg_011CdpQ27rZpAoXmmLG7xR5S",
      model: "claude-opus-5",
      object: "message",
      status: "completed",
      stop_reason: "end_turn",
    })
    expect(parsed?.usage).toEqual({
      cache_creation_input_tokens: 305_438,
      cache_read_input_tokens: 0,
      input_tokens: 2,
      input_tokens_details: {
        cache_write_tokens: 305_438,
        cached_tokens: 0,
      },
      output_tokens: 14,
    })
    expect(parsed?.copilotUsage?.total_nano_aiu).toBe(191_627_250_000)
    expect(parsed?.events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
      "done",
    ])
    expect(parsed?.isPartial).toBe(false)
  })

  test("separates Anthropic thinking deltas from assistant output", () => {
    const raw = [
      anthropicSse("message_start", {
        message: {
          content: [],
          id: "msg_thinking",
          model: "claude-opus-5",
          role: "assistant",
          type: "message",
          usage: { input_tokens: 8, output_tokens: 1 },
        },
      }),
      anthropicSse("content_block_start", {
        content_block: { signature: "", thinking: "", type: "thinking" },
        index: 0,
      }),
      anthropicSse("content_block_delta", {
        delta: { thinking: "Checked the ", type: "thinking_delta" },
        index: 0,
      }),
      anthropicSse("content_block_delta", {
        delta: { thinking: "current state.", type: "thinking_delta" },
        index: 0,
      }),
      anthropicSse("content_block_delta", {
        delta: { signature: "opaque", type: "signature_delta" },
        index: 0,
      }),
      anthropicSse("content_block_stop", { index: 0 }),
      anthropicSse("content_block_start", {
        content_block: { text: "", type: "text" },
        index: 1,
      }),
      anthropicSse("content_block_delta", {
        delta: { text: "Final answer", type: "text_delta" },
        index: 1,
      }),
      anthropicSse("content_block_stop", { index: 1 }),
      anthropicSse("message_stop", {}),
    ].join("")

    const parsed = parseResponsesBody(raw)

    expect(parsed?.reasoningText).toBe("Checked the current state.")
    expect(parsed?.assistantText).toBe("Final answer")
  })

  test("assembles Anthropic tool-use input JSON without mixing it into text", () => {
    const raw = [
      anthropicSse("message_start", {
        message: {
          content: [],
          id: "msg_tool",
          model: "claude-opus-5",
          role: "assistant",
          type: "message",
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      }),
      anthropicSse("content_block_start", {
        content_block: {
          caller: { type: "direct" },
          id: "toolu_01QwzGAu4ouYQdhoHNJJJVv5",
          input: {},
          name: "Bash",
          type: "tool_use",
        },
        index: 1,
      }),
      anthropicSse("content_block_delta", {
        delta: { partial_json: '{"command":"git ', type: "input_json_delta" },
        index: 1,
      }),
      anthropicSse("content_block_delta", {
        delta: { partial_json: 'status"}', type: "input_json_delta" },
        index: 1,
      }),
      anthropicSse("content_block_stop", { index: 1 }),
      anthropicSse("message_delta", {
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 12 },
      }),
      anthropicSse("message_stop", {}),
      "data: [DONE]\n\n",
    ].join("")

    const parsed = parseResponsesBody(raw)

    expect(parsed?.assistantText).toBe("")
    expect(parsed?.toolCalls).toEqual([
      {
        arguments: '{"command":"git status"}',
        argumentsJson: { command: "git status" },
        callId: "toolu_01QwzGAu4ouYQdhoHNJJJVv5",
        id: null,
        name: "Bash",
        outputIndex: 1,
      },
    ])
    expect(parsed?.response?.tool_call_count).toBe(1)
    expect(parsed?.response?.finish_reason).toBe("tool_use")
  })

  test("parses a direct Anthropic Messages response", () => {
    const parsed = parseResponsesBody(
      JSON.stringify({
        content: [
          { thinking: "Checked the state.", type: "thinking" },
          { text: "First paragraph.", type: "text" },
          {
            id: "toolu_direct",
            input: { path: "README.md" },
            name: "Read",
            type: "tool_use",
          },
          { text: "Second paragraph.", type: "text" },
        ],
        id: "msg_direct",
        model: "claude-opus-5",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: {
          cache_read_input_tokens: 100,
          input_tokens: 20,
          output_tokens: 15,
        },
      }),
    )

    expect(parsed?.assistantText).toBe("First paragraph.\n\nSecond paragraph.")
    expect(parsed?.reasoningText).toBe("Checked the state.")
    expect(parsed?.status).toBe("completed")
    expect(parsed?.toolCalls).toEqual([
      {
        arguments: '{"path":"README.md"}',
        argumentsJson: { path: "README.md" },
        callId: "toolu_direct",
        id: null,
        name: "Read",
        outputIndex: 2,
      },
    ])
  })

  test("retains Anthropic text before a terminal stream error", () => {
    const raw = [
      anthropicSse("message_start", {
        message: {
          content: [],
          id: "msg_error",
          model: "claude-opus-5",
          role: "assistant",
          type: "message",
          usage: { input_tokens: 4, output_tokens: 1 },
        },
      }),
      anthropicSse("content_block_start", {
        content_block: { text: "", type: "text" },
        index: 0,
      }),
      anthropicSse("content_block_delta", {
        delta: { text: "Partial answer", type: "text_delta" },
        index: 0,
      }),
      anthropicSse("error", {
        error: { message: "Generation failed", type: "api_error" },
      }),
    ].join("")

    const parsed = parseResponsesBody(raw)

    expect(parsed?.assistantText).toBe("Partial answer")
    expect(parsed?.errorMessage).toBe("Generation failed")
    expect(parsed?.status).toBe("error")
    expect(parsed?.response?.status).toBe("error")
    expect(parsed?.isPartial).toBe(false)
  })

  test("does not claim Chat Completions with an Anthropic-like event label", () => {
    const raw = [
      anthropicSse("message_start", {
        message: {
          content: [],
          id: "msg_mislabeled",
          model: "gpt-test",
          role: "assistant",
          type: "message",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      `data: ${JSON.stringify({
        id: "chat_mislabeled",
        object: "chat.completion.chunk",
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: { content: "Chat answer", role: "assistant" },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      "data: [DONE]",
      "",
      "",
    ].join("\n")

    const parsed = parseResponsesBody(raw)

    expect(parsed?.assistantText).toBe("Chat answer")
    expect(parsed?.response?.object).toBe("chat.completion.chunk")
  })

  test("preserves Anthropic stop sequence and direct Copilot usage", () => {
    const stream = [
      anthropicSse("message_start", {
        message: {
          content: [],
          id: "msg_stop_sequence",
          model: "claude-opus-5",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      }),
      anthropicSse("message_delta", {
        delta: { stop_reason: "stop_sequence", stop_sequence: "END" },
        usage: { output_tokens: 2 },
      }),
      anthropicSse("message_stop", {}),
    ].join("")
    const direct = parseResponsesBody(
      JSON.stringify({
        content: [{ text: "Answer", type: "text" }],
        copilot_usage: { total_nano_aiu: 42 },
        id: "msg_direct_usage",
        model: "claude-opus-5",
        role: "assistant",
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    )

    expect(parseResponsesBody(stream)?.response?.stop_sequence).toBe("END")
    expect(direct?.copilotUsage?.total_nano_aiu).toBe(42)
  })

  test("assembles a completed stream from its authoritative response", () => {
    const response = {
      id: "resp_1",
      model: "gpt-test",
      object: "response",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checked the state." }],
        },
        {
          type: "message",
          status: "completed",
          content: [
            { type: "output_text", text: "Final answer", annotations: [] },
          ],
        },
        { type: "function_call", call_id: "call_1", arguments: "{}" },
      ],
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    }
    const raw = [
      sse("response.output_text.delta", {
        delta: "Final ",
        item_id: "msg_1",
        output_index: 1,
        content_index: 0,
        sequence_number: 1,
      }),
      sse("response.output_text.done", {
        text: "Final answer",
        item_id: "msg_1",
        output_index: 1,
        content_index: 0,
        sequence_number: 2,
      }),
      sse("response.completed", {
        response,
        copilot_usage: {
          token_details: [{ token_type: "input", token_count: 10 }],
          total_nano_aiu: 42,
        },
        sequence_number: 3,
      }),
    ].join("")

    const parsed = parseResponsesBody(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.assistantText).toBe("Final answer")
    expect(parsed?.reasoningText).toBe("Checked the state.")
    expect(parsed?.toolCalls.length).toBe(1)
    expect(parsed?.status).toBe("completed")
    expect(parsed?.isPartial).toBe(false)
    expect(parsed?.events).toHaveLength(3)
    expect(parsed?.usage).toEqual(response.usage)
    expect(parsed?.copilotUsage?.total_nano_aiu).toBe(42)
  })

  test("uses done text without duplicating preceding deltas", () => {
    const raw = [
      sse("response.output_text.delta", {
        delta: "Hello ",
        item_id: "encrypted_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
      }),
      sse("response.output_text.delta", {
        delta: "world",
        item_id: "encrypted_2",
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
      }),
      sse("response.output_text.done", {
        text: "Hello world",
        item_id: "encrypted_3",
        output_index: 0,
        content_index: 0,
        sequence_number: 3,
      }),
    ].join("")

    expect(parseResponsesBody(raw)?.assistantText).toBe("Hello world")
  })

  test("parses a data-only terminal event and infers its event type", () => {
    const raw = `data: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 9,
      response: {
        id: "resp_2",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Done" }],
          },
        ],
      },
    })}`

    const parsed = parseResponsesBody(raw)
    expect(parsed?.assistantText).toBe("Done")
    expect(parsed?.events[0]?.type).toBe("response.completed")
    expect(parsed?.isPartial).toBe(false)
  })

  test("tolerates copied zero-width separators and a truncated tail", () => {
    const raw = [
      "json",
      "",
      "event: response.in_progress",
      `data: ${JSON.stringify({
        type: "response.in_progress",
        sequence_number: 1,
        response: {
          id: "resp_3",
          object: "response",
          status: "in_progress",
          output: [],
        },
      })}`,
      "\u200B",
      "event: response.output_text.delta",
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_1",
        delta: "Working",
      })}`,
      "\u200B",
      "event: response.reasoning_summar",
    ].join("\n")

    const parsed = parseResponsesBody(raw)
    expect(parsed?.assistantText).toBe("Working")
    expect(parsed?.isPartial).toBe(true)
    expect(parsed?.events).toHaveLength(2)
  })

  test("supports a direct non-streaming response object", () => {
    const parsed = parseResponsesBody(
      JSON.stringify({
        id: "resp_4",
        object: "response",
        status: "completed",
        output_text: "Direct answer",
      }),
    )

    expect(parsed?.assistantText).toBe("Direct answer")
    expect(parsed?.status).toBe("completed")
    expect(parsed?.isPartial).toBe(false)
  })

  test("shows direct and streamed refusals as assistant output", () => {
    const direct = parseResponsesBody(
      JSON.stringify({
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "I cannot help with that." }],
          },
        ],
      }),
    )
    const streamed = parseResponsesBody(
      sse("response.refusal.done", {
        refusal: "Request refused.",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
      }),
    )

    expect(direct?.assistantText).toBe("I cannot help with that.")
    expect(streamed?.assistantText).toBe("Request refused.")
  })

  test("counts tool calls added after an early partial response snapshot", () => {
    const raw = [
      sse("response.in_progress", {
        response: {
          id: "resp_partial",
          object: "response",
          status: "in_progress",
          output: [],
        },
        sequence_number: 1,
      }),
      sse("response.output_item.added", {
        item: { type: "function_call", call_id: "call_late" },
        output_index: 0,
        sequence_number: 2,
      }),
    ].join("")

    expect(parseResponsesBody(raw)?.toolCalls.length).toBe(1)
  })

  test("reconstructs one authoritative Responses tool call without duplication", () => {
    const functionCall = {
      id: "fc_1",
      call_id: "call_1",
      type: "function_call",
      name: "lookup",
      arguments: '{"id":7}',
    }
    const raw = [
      sse("response.output_item.added", {
        item: { ...functionCall, arguments: "" },
        output_index: 0,
      }),
      sse("response.function_call_arguments.delta", {
        item_id: "fc_1",
        output_index: 0,
        delta: '{"id":',
      }),
      sse("response.function_call_arguments.delta", {
        item_id: "fc_1",
        output_index: 0,
        delta: "7}",
      }),
      sse("response.function_call_arguments.done", {
        item_id: "fc_1",
        output_index: 0,
        arguments: '{"id":7}',
      }),
      sse("response.completed", {
        response: {
          object: "response",
          status: "completed",
          output: [functionCall],
        },
      }),
    ].join("")

    const parsed = parseResponsesBody(raw)
    expect(parsed?.assistantText).toBe("")
    expect(parsed?.toolCalls).toEqual([
      {
        arguments: '{"id":7}',
        argumentsJson: { id: 7 },
        callId: "call_1",
        id: "fc_1",
        name: "lookup",
        outputIndex: 0,
      },
    ])
  })

  test("preserves malformed authoritative Responses tool arguments", () => {
    const raw = sse("response.output_item.done", {
      item: {
        id: "fc_bad",
        call_id: "call_bad",
        type: "function_call",
        name: "lookup",
        arguments: '{"id":',
      },
      output_index: 0,
    })

    expect(parseResponsesBody(raw)?.toolCalls).toEqual([
      {
        arguments: '{"id":',
        argumentsJson: null,
        callId: "call_bad",
        id: "fc_bad",
        name: "lookup",
        outputIndex: 0,
      },
    ])
  })

  test("uses top-level metadata from a done-only Responses argument event", () => {
    const parsed = parseResponsesBody(
      sse("response.function_call_arguments.done", {
        item_id: "fc_done",
        output_index: 0,
        name: "lookup",
        arguments: '{"id":3}',
      }),
    )

    expect(parsed?.toolCalls).toEqual([
      {
        arguments: '{"id":3}',
        argumentsJson: { id: 3 },
        callId: null,
        id: "fc_done",
        name: "lookup",
        outputIndex: 0,
      },
    ])
  })

  test("lets output_item.done correct metadata matched by stable id", () => {
    const raw = [
      sse("response.output_item.added", {
        item: {
          id: "fc_stable",
          call_id: "call_wrong",
          type: "function_call",
          name: "wrong_name",
          arguments: "",
        },
        output_index: 0,
      }),
      sse("response.output_item.done", {
        item: {
          id: "fc_stable",
          call_id: "call_final",
          type: "function_call",
          name: "lookup",
          arguments: "{}",
        },
        output_index: 0,
      }),
    ].join("")

    expect(parseResponsesBody(raw)?.toolCalls[0]).toMatchObject({
      callId: "call_final",
      id: "fc_stable",
      name: "lookup",
    })
  })

  test("lets a terminal response correct metadata matched by stable call id", () => {
    const raw = [
      sse("response.output_item.added", {
        item: {
          id: "fc_wrong",
          call_id: "call_stable",
          type: "function_call",
          name: "wrong_name",
          arguments: "",
        },
        output_index: 0,
      }),
      sse("response.completed", {
        response: {
          object: "response",
          status: "completed",
          output: [
            {
              id: "fc_final",
              call_id: "call_stable",
              type: "function_call",
              name: "lookup",
              arguments: "{}",
            },
          ],
        },
      }),
    ].join("")

    expect(parseResponsesBody(raw)?.toolCalls[0]).toMatchObject({
      callId: "call_stable",
      id: "fc_final",
      name: "lookup",
    })
  })

  test("preserves payloads for admitted non-function Responses tools", () => {
    const cases = [
      {
        item: {
          id: "computer_1",
          type: "computer_call",
          action: { type: "click", x: 12, y: 34 },
          status: "completed",
        },
        name: "computer_call",
        payload: { action: { type: "click", x: 12, y: 34 } },
      },
      {
        item: {
          id: "custom_1",
          type: "custom_tool_call",
          name: "shell",
          input: "pwd",
        },
        name: "shell",
        payload: { input: "pwd" },
      },
      {
        item: {
          id: "file_1",
          type: "file_search_call",
          queries: ["incident"],
          results: [{ file_id: "file_a", score: 0.9 }],
        },
        name: "file_search_call",
        payload: {
          queries: ["incident"],
          results: [{ file_id: "file_a", score: 0.9 }],
        },
      },
      {
        item: {
          id: "mcp_1",
          type: "mcp_call",
          name: "lookup",
          arguments: '{"id":1}',
          server_label: "inventory",
          error: null,
        },
        name: "lookup",
        payload: {
          arguments: '{"id":1}',
          server_label: "inventory",
          error: null,
        },
      },
      {
        item: {
          id: "web_1",
          type: "web_search_call",
          action: { type: "search", query: "status" },
          output_index: 99,
        },
        name: "web_search_call",
        payload: { action: { type: "search", query: "status" } },
      },
    ]

    for (const [outputIndex, entry] of cases.entries()) {
      const parsed = parseResponsesBody(
        sse("response.output_item.done", {
          item: entry.item,
          output_index: outputIndex,
        }),
      )
      expect(parsed?.toolCalls[0]).toMatchObject({
        arguments: JSON.stringify(entry.payload),
        argumentsJson: entry.payload,
        name: entry.name,
      })
    }
  })

  test("uses an explicit empty payload for a non-function Responses tool", () => {
    const parsed = parseResponsesBody(
      sse("response.output_item.done", {
        item: { id: "web_empty", type: "web_search_call" },
        output_index: 0,
      }),
    )

    expect(parsed?.toolCalls[0]).toMatchObject({
      arguments: "{}",
      argumentsJson: {},
      name: "web_search_call",
    })
  })

  test("keeps conflicting stable Responses calls at one output index separate", () => {
    const raw = [
      sse("response.output_item.done", {
        item: {
          id: "fc_first",
          call_id: "call_first",
          type: "function_call",
          name: "first",
          arguments: "{}",
        },
        output_index: 0,
      }),
      sse("response.output_item.done", {
        item: {
          id: "fc_second",
          call_id: "call_second",
          type: "function_call",
          name: "second",
          arguments: "{}",
        },
        output_index: 0,
      }),
    ].join("")

    expect(parseResponsesBody(raw)?.toolCalls).toEqual([
      {
        arguments: "{}",
        argumentsJson: {},
        callId: "call_first",
        id: "fc_first",
        name: "first",
        outputIndex: 0,
      },
      {
        arguments: "{}",
        argumentsJson: {},
        callId: "call_second",
        id: "fc_second",
        name: "second",
        outputIndex: 0,
      },
    ])
  })

  test("does not invent tool calls from ordinary output text events", () => {
    const parsed = parseResponsesBody(
      sse("response.output_text.done", {
        text: "Final answer",
        output_index: 0,
        content_index: 0,
      }),
    )

    expect(parsed?.assistantText).toBe("Final answer")
    expect(parsed?.errorMessage).toBeNull()
    expect(parsed?.toolCalls).toEqual([])
  })

  test("normalizes a response.failed error without a response snapshot", () => {
    const parsed = parseResponsesBody(
      sse("response.failed", {
        error: { code: "server_error", message: "Generation failed" },
      }),
    )

    expect(parsed?.errorMessage).toBe("Generation failed")
    expect(parsed?.status).toBe("failed")
    expect(parsed?.isPartial).toBe(false)
  })

  test("normalizes a top-level Responses error event", () => {
    const parsed = parseResponsesBody(
      sse("error", {
        code: "server_error",
        message: "Generation failed",
        param: null,
        sequence_number: 4,
      }),
    )

    expect(parsed?.errorMessage).toBe("Generation failed")
    expect(parsed?.status).toBe("error")
    expect(parsed?.isPartial).toBe(false)
    expect(parsed?.events).toHaveLength(1)
    expect(parsed?.events[0]?.type).toBe("error")
  })

  test("retains output captured before a top-level Responses error", () => {
    const raw = [
      sse("response.output_text.delta", {
        delta: "Partial answer",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
      }),
      sse("error", {
        code: "server_error",
        message: "Stream failed",
        param: null,
        sequence_number: 2,
      }),
    ].join("")

    const parsed = parseResponsesBody(raw)
    expect(parsed?.assistantText).toBe("Partial answer")
    expect(parsed?.errorMessage).toBe("Stream failed")
    expect(parsed?.status).toBe("error")
    expect(parsed?.isPartial).toBe(false)
  })

  test("separates multiple event-only assistant output parts", () => {
    const raw = [
      sse("response.output_text.done", {
        text: "First message",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
      }),
      sse("response.output_text.done", {
        text: "Second message",
        output_index: 1,
        content_index: 0,
        sequence_number: 2,
      }),
    ].join("")

    expect(parseResponsesBody(raw)?.assistantText).toBe(
      "First message\n\nSecond message",
    )
  })

  test("does not claim ordinary JSON as a Responses body", () => {
    expect(parseResponsesBody('{"ok":true,"result":"hello"}')).toBeNull()
    expect(
      parseResponsesBody('{"error":{"message":"ordinary error"}}'),
    ).toBeNull()
    expect(parseResponsesBody('{"output":[]}')).toBeNull()
    expect(
      parseResponsesBody(
        '{"output":[{"type":"message","content":[]}],"output_text":""}',
      ),
    ).toBeNull()
    expect(
      parseResponsesBody('{"id":"job_1","status":"completed","result":{}}'),
    ).toBeNull()
    expect(parseResponsesBody("not json or SSE")).toBeNull()
  })

  test("assembles Chat Completions reasoning and output deltas", () => {
    const raw = [
      chatChunk({ content: null, role: "assistant", reasoning_text: "I" }),
      chatChunk({ content: null, reasoning_text: " reviewed the incident." }),
      chatChunk({ content: "## Finding\n\nThe deployment " }),
      chatChunk({ content: "is healthy." }),
      chatChunk({}, "stop", {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          total_tokens: 125,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      }),
      "data: [DONE]\n\n",
    ].join("")

    const parsed = parseResponsesBody(raw)
    expect(parsed?.assistantText).toBe(
      "## Finding\n\nThe deployment is healthy.",
    )
    expect(parsed?.reasoningText).toBe("I reviewed the incident.")
    expect(parsed?.status).toBe("completed")
    expect(parsed?.response?.finish_reason).toBe("stop")
    expect(parsed?.isPartial).toBe(false)
    expect(parsed?.response?.model).toBe("claude-opus-4.8")
    expect(parsed?.usage).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 125,
    })
    expect(parsed?.events).toHaveLength(6)
  })

  test("recognizes object-less Claude Chat Completions chunks", () => {
    const raw = [
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              content: null,
              role: "assistant",
              reasoning_text: "I'm being dispatched ",
            },
          },
        ],
        created: 1_783_698_410,
        id: "msg_011CctdwFMYuCcVvdZBmXDzy",
        model: "claude-opus-4.8",
      })}`,
      "\u200B",
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { content: null, reasoning_text: "as a reviewer agent." },
          },
        ],
        created: 1_783_698_411,
        id: "msg_011CctdwFMYuCcVvdZBmXDzy",
        model: "claude-opus-4.8",
      })}`,
    ].join("\n")

    const parsed = parseResponsesBody(raw)
    expect(parsed?.reasoningText).toBe(
      "I'm being dispatched as a reviewer agent.",
    )
    expect(parsed?.response?.model).toBe("claude-opus-4.8")
    expect(parsed?.assistantText).toBe("")
    expect(parsed?.isPartial).toBe(true)
  })

  test("assembles Chat Completions tool calls and partial captures", () => {
    const raw = [
      `data: ${JSON.stringify({
        id: "msg_chat_2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"id":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}`,
      "\u200B",
      `data: ${JSON.stringify({
        id: "msg_chat_2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "1}" } }],
            },
            finish_reason: null,
          },
        ],
      })}`,
    ].join("\n")

    const parsed = parseResponsesBody(raw)
    expect(parsed?.toolCalls.length).toBe(1)
    expect(parsed?.status).toBe("in_progress")
    expect(parsed?.isPartial).toBe(true)
  })

  test("assembles Chat Completions tool call fragments", () => {
    const raw = [
      `data: ${JSON.stringify({
        id: "msg_chat_2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_chat",
                  type: "function",
                  function: { name: "lookup", arguments: '{"id":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}`,
      "\u200B",
      `data: ${JSON.stringify({
        id: "msg_chat_2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "9}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      })}`,
    ].join("\n")

    const parsed = parseResponsesBody(raw)
    expect(parsed?.toolCalls).toEqual([
      {
        arguments: '{"id":9}',
        argumentsJson: { id: 9 },
        callId: null,
        id: "call_chat",
        name: "lookup",
        outputIndex: 0,
      },
    ])
    expect(parsed?.status).toBe("completed")
    expect(parsed?.isPartial).toBe(false)
  })

  test("concatenates fragmented Chat tool-call metadata", () => {
    const raw = [
      chatChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_",
            call_id: "provider_",
            function: { name: "look", arguments: "{" },
          },
        ],
      }),
      chatChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "chat",
              call_id: "id",
              function: { name: "up", arguments: "}" },
            },
          ],
        },
        "tool_calls",
      ),
    ].join("")

    expect(parseResponsesBody(raw)?.toolCalls).toEqual([
      {
        arguments: "{}",
        argumentsJson: {},
        callId: "provider_id",
        id: "call_chat",
        name: "lookup",
        outputIndex: 0,
      },
    ])
  })

  test("lets a Chat message replace partial tool-call metadata", () => {
    const partial = chatChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_wrong",
          call_id: "provider_wrong",
          function: { name: "wrong_name", arguments: '{"wrong":' },
        },
      ],
    })
    const terminal = `data: ${JSON.stringify({
      id: "chatcmpl_final",
      object: "chat.completion",
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: "call_final",
                call_id: "provider_final",
                function: { name: "lookup", arguments: '{"id":7}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\n`

    expect(parseResponsesBody(`${partial}${terminal}`)?.toolCalls).toEqual([
      {
        arguments: '{"id":7}',
        argumentsJson: { id: 7 },
        callId: "provider_final",
        id: "call_final",
        name: "lookup",
        outputIndex: 0,
      },
    ])
  })

  test("orders Chat tool calls by choice then tool index", () => {
    const raw = [
      `data: ${JSON.stringify({
        id: "chat_order",
        object: "chat.completion.chunk",
        model: "gpt-test",
        choices: [
          {
            index: 1,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "choice_1_tool_1",
                  function: { name: "late", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chat_order",
        object: "chat.completion.chunk",
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 2,
                  id: "choice_0_tool_2",
                  function: { name: "middle", arguments: "{}" },
                },
                {
                  index: 0,
                  id: "choice_0_tool_0",
                  function: { name: "first", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })}\n\n`,
    ].join("")

    expect(parseResponsesBody(raw)?.toolCalls.map((call) => call.id)).toEqual([
      "choice_0_tool_0",
      "choice_0_tool_2",
      "choice_1_tool_1",
    ])
  })

  test("assembles non-streaming Chat Completions responses", () => {
    const parsed = parseResponsesBody(
      JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        created: 1,
        model: "claude-opus-4.8",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Final answer",
              reasoning_text: "Private reasoning",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
        },
      }),
    )

    expect(parsed?.assistantText).toBe("Final answer")
    expect(parsed?.reasoningText).toBe("Private reasoning")
    expect(parsed?.toolCalls.length).toBe(1)
    expect(parsed?.status).toBe("completed")
    expect(parsed?.response?.finish_reason).toBe("tool_calls")
    expect(parsed?.isPartial).toBe(false)
  })

  test("keeps Chat Completions metadata across a usage-only final chunk", () => {
    const raw = [
      chatChunk({ role: "assistant", content: "Answer" }),
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
        },
        copilot_usage: { completion_tokens: 2 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")

    const parsed = parseResponsesBody(raw)
    expect(parsed?.response?.id).toBe("msg_chat_1")
    expect(parsed?.response?.model).toBe("claude-opus-4.8")
    expect(parsed?.assistantText).toBe("Answer")
    expect(parsed?.usage?.total_tokens).toBe(7)
    expect(parsed?.copilotUsage?.completion_tokens).toBe(2)
    expect(parsed?.isPartial).toBe(false)
  })
})
