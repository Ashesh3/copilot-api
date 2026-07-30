import { describe, expect, test } from "bun:test"

import type { ParsedResponsesBody } from "../ui/src/lib/responses-body"

import { describeResponseOutput } from "../ui/src/lib/response-output"

const completedResponse: ParsedResponsesBody = {
  assistantText: "",
  copilotUsage: null,
  errorMessage: null,
  events: [],
  isPartial: false,
  reasoningText: "",
  response: { object: "response", status: "completed" },
  status: "completed",
  toolCalls: [],
  usage: null,
}

describe("response output descriptions", () => {
  test("identifies an assistant message", () => {
    expect(
      describeResponseOutput({
        ...completedResponse,
        assistantText: "Final answer",
      }),
    ).toEqual({ kind: "assistant", message: null })
  })

  test("describes a tool-only response", () => {
    expect(
      describeResponseOutput({
        ...completedResponse,
        toolCalls: [
          {
            arguments: "{}",
            argumentsJson: {},
            callId: "call_1",
            id: "item_1",
            name: "lookup",
            outputIndex: 0,
          },
        ],
      }),
    ).toEqual({
      kind: "tool-only",
      message: "The model returned 1 tool call and no assistant message.",
    })
  })

  test("prefers an error over a partial-capture description", () => {
    expect(
      describeResponseOutput({
        ...completedResponse,
        errorMessage: "Quota exceeded",
        isPartial: true,
        status: "error",
      }),
    ).toEqual({ kind: "error", message: "Quota exceeded" })
  })

  test("describes a partial capture without final output", () => {
    expect(
      describeResponseOutput({
        ...completedResponse,
        isPartial: true,
        status: "in_progress",
      }),
    ).toEqual({
      kind: "partial",
      message:
        "The capture ended before a final assistant output event was received.",
    })
  })

  test("describes a completed response with no output", () => {
    expect(describeResponseOutput(completedResponse)).toEqual({
      kind: "empty",
      message:
        "The response completed without an assistant message, tool call, refusal, or error.",
    })
  })
})
