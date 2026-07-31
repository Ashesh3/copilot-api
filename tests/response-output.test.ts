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
    ).toEqual({ errorMessage: null, kind: "assistant", message: null })
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
      errorMessage: null,
      kind: "tool-only",
      message: "The model returned 1 tool call and no assistant message.",
    })
  })

  test("describes a terminal error without primary output", () => {
    expect(
      describeResponseOutput({
        ...completedResponse,
        errorMessage: "Quota exceeded",
        isPartial: true,
        status: "error",
      }),
    ).toEqual({
      errorMessage: "Quota exceeded",
      kind: "error",
      message: null,
    })
  })

  test("retains a terminal error alongside assistant output", () => {
    expect(
      describeResponseOutput({
        ...completedResponse,
        assistantText: "Partial answer",
        errorMessage: "Stream failed",
        status: "error",
      }),
    ).toEqual({
      errorMessage: "Stream failed",
      kind: "assistant",
      message: null,
    })
  })

  test("retains a terminal error alongside tool-call output", () => {
    expect(
      describeResponseOutput({
        ...completedResponse,
        errorMessage: "Stream failed",
        status: "error",
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
      errorMessage: "Stream failed",
      kind: "tool-only",
      message: "The model returned 1 tool call and no assistant message.",
    })
  })

  test("describes a partial capture without final output", () => {
    expect(
      describeResponseOutput({
        ...completedResponse,
        isPartial: true,
        status: "in_progress",
      }),
    ).toEqual({
      errorMessage: null,
      kind: "partial",
      message:
        "The capture ended before a final assistant output event was received.",
    })
  })

  test("describes a completed response with no output", () => {
    expect(describeResponseOutput(completedResponse)).toEqual({
      errorMessage: null,
      kind: "empty",
      message:
        "The completed response contained no assistant message, tool call, refusal, or error.",
    })
  })
})
