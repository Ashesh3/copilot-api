import type { ParsedResponsesBody } from "./responses-body"

export type ResponseOutputDescription =
  | {
      errorMessage: string | null
      kind: "assistant"
      message: null
    }
  | {
      errorMessage: string | null
      kind: "tool-only" | "partial" | "empty"
      message: string
    }
  | {
      errorMessage: string
      kind: "error"
      message: null
    }

export function describeResponseOutput(
  parsed: ParsedResponsesBody,
): ResponseOutputDescription {
  const errorMessage = parsed.errorMessage
  if (parsed.assistantText) {
    return { errorMessage, kind: "assistant", message: null }
  }

  if (parsed.toolCalls.length > 0) {
    const count = parsed.toolCalls.length
    return {
      errorMessage,
      kind: "tool-only",
      message: `The model returned ${count} tool ${count === 1 ? "call" : "calls"} and no assistant message.`,
    }
  }

  if (errorMessage) {
    return { errorMessage, kind: "error", message: null }
  }

  if (parsed.isPartial) {
    return {
      errorMessage,
      kind: "partial",
      message:
        "The capture ended before a final assistant output event was received.",
    }
  }

  return {
    errorMessage,
    kind: "empty",
    message:
      "The completed response contained no assistant message, tool call, refusal, or error.",
  }
}
