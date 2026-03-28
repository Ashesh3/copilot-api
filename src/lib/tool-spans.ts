import * as Sentry from "@sentry/bun"

import { shouldRecordAiContent } from "./sentry"

const serializeToolOutput = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return JSON.stringify(content)
  return JSON.stringify(content ?? "")
}

/**
 * Build a map of tool_use id -> {name, input} from Anthropic assistant messages.
 */
const buildToolUseMap = (
  messages: Array<unknown>,
): Map<string, { name: string; input: unknown }> => {
  const map = new Map<string, { name: string; input: unknown }>()

  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown }
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue
    for (const block of m.content) {
      const b = block as {
        type?: string
        id?: string
        name?: string
        input?: unknown
      }
      if (b.type === "tool_use" && b.id && b.name) {
        map.set(b.id, { name: b.name, input: b.input })
      }
    }
  }

  return map
}

/**
 * Emit gen_ai.execute_tool spans for tool results found in Anthropic messages.
 * These are synthetic spans — we reconstruct tool execution from the message history.
 * Timing is approximate (zero-duration since we don't know actual execution time).
 */
export function emitAnthropicToolSpans(messages: Array<unknown>): void {
  const toolUseMap = buildToolUseMap(messages)

  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown }
    if (m.role !== "user" || !Array.isArray(m.content)) continue
    for (const block of m.content) {
      const b = block as {
        type?: string
        tool_use_id?: string
        content?: unknown
        is_error?: boolean
      }
      if (b.type !== "tool_result" || !b.tool_use_id) continue

      const toolUse = toolUseMap.get(b.tool_use_id)
      if (!toolUse) continue

      const toolOutput = serializeToolOutput(b.content)

      Sentry.startSpan(
        {
          op: "gen_ai.execute_tool",
          name: `execute_tool ${toolUse.name}`,
          attributes: {
            "gen_ai.tool.name": toolUse.name,
            ...(shouldRecordAiContent() && {
              "gen_ai.tool.input": JSON.stringify(toolUse.input),
              "gen_ai.tool.output": toolOutput.slice(0, 10000),
            }),
            ...(b.is_error && { "gen_ai.tool.error": "true" }),
          },
        },
        () => {
          // Span is zero-duration — we don't know actual execution time
        },
      )
    }
  }
}

/**
 * Emit gen_ai.execute_tool spans for tool results in ChatCompletions messages.
 */
export function emitChatCompletionsToolSpans(messages: Array<unknown>): void {
  // Build map of tool_call id -> {name, arguments} from assistant messages
  const toolCallMap = new Map<string, { name: string; arguments: string }>()

  for (const msg of messages) {
    const m = msg as {
      role?: string
      tool_calls?: Array<{
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls) {
      if (tc.id && tc.function?.name) {
        toolCallMap.set(tc.id, {
          name: tc.function.name,
          arguments: tc.function.arguments ?? "",
        })
      }
    }
  }

  // Find tool role messages and emit spans
  for (const msg of messages) {
    const m = msg as { role?: string; tool_call_id?: string; content?: string }
    if (m.role !== "tool" || !m.tool_call_id) continue

    const toolCall = toolCallMap.get(m.tool_call_id)
    if (!toolCall) continue

    Sentry.startSpan(
      {
        op: "gen_ai.execute_tool",
        name: `execute_tool ${toolCall.name}`,
        attributes: {
          "gen_ai.tool.name": toolCall.name,
          ...(shouldRecordAiContent() && {
            "gen_ai.tool.input": toolCall.arguments,
            "gen_ai.tool.output": (m.content ?? "").slice(0, 10000),
          }),
        },
      },
      () => {},
    )
  }
}

/**
 * Emit gen_ai.execute_tool spans for tool results in Responses API input.
 */
export function emitResponsesToolSpans(input: unknown): void {
  if (!Array.isArray(input)) return

  // Build map of call_id -> {name, arguments} from function_call items
  const callMap = new Map<string, { name: string; arguments: string }>()

  for (const item of input) {
    const i = item as {
      type?: string
      call_id?: string
      name?: string
      arguments?: string
    }
    if (i.type === "function_call" && i.call_id && i.name) {
      callMap.set(i.call_id, { name: i.name, arguments: i.arguments ?? "" })
    }
  }

  // Find function_call_output items and emit spans
  for (const item of input) {
    const i = item as { type?: string; call_id?: string; output?: string }
    if (i.type !== "function_call_output" || !i.call_id) continue

    const call = callMap.get(i.call_id)
    if (!call) continue

    Sentry.startSpan(
      {
        op: "gen_ai.execute_tool",
        name: `execute_tool ${call.name}`,
        attributes: {
          "gen_ai.tool.name": call.name,
          ...(shouldRecordAiContent() && {
            "gen_ai.tool.input": call.arguments,
            "gen_ai.tool.output": (i.output ?? "").slice(0, 10000),
          }),
        },
      },
      () => {},
    )
  }
}
