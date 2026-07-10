import { describe, expect, test } from "bun:test"

import { parseResponsesBody } from "../ui/src/lib/responses-body"

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

// Compact fixtures intentionally keep the parser's capture variants together.
// eslint-disable-next-line max-lines-per-function
describe("Responses debug body parser", () => {
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
    expect(parsed?.toolCallCount).toBe(1)
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

    expect(parseResponsesBody(raw)?.toolCallCount).toBe(1)
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
    expect(parsed?.toolCallCount).toBe(1)
    expect(parsed?.status).toBe("in_progress")
    expect(parsed?.isPartial).toBe(true)
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
    expect(parsed?.toolCallCount).toBe(1)
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
