import { describe, expect, test } from "bun:test"

import { parseResponsesBody } from "../ui/src/lib/responses-body"

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ ...data, type })}\n\n`
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
})
