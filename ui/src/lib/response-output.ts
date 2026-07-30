import type { ParsedResponsesBody } from "./responses-body"

export type ResponseOutputDescription =
  | { kind: "assistant"; message: null }
  | { kind: "tool-only" | "error" | "partial" | "empty"; message: string }

export function describeResponseOutput(
  parsed: ParsedResponsesBody,
): ResponseOutputDescription {
  if (parsed.assistantText) return { kind: "assistant", message: null }

  if (parsed.toolCalls.length > 0) {
    const count = parsed.toolCalls.length
    return {
      kind: "tool-only",
      message: `The model returned ${count} tool ${count === 1 ? "call" : "calls"} and no assistant message.`,
    }
  }

  if (parsed.errorMessage) {
    return { kind: "error", message: parsed.errorMessage }
  }

  if (parsed.isPartial) {
    return {
      kind: "partial",
      message:
        "The capture ended before a final assistant output event was received.",
    }
  }

  return {
    kind: "empty",
    message:
      "The completed response contained no assistant message, tool call, refusal, or error.",
  }
}
