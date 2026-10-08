import { randomUUID } from "node:crypto"

import type {
  ResponseOutputCompaction,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import type { CompactionSummary } from "./compact-summary"

import { getCompactionTriggerPrompt } from "./compact-prompt"

/**
 * Codex remote compaction v2 sends an ordinary Responses request whose input
 * ends with a `compaction_trigger` control item, and it accepts the turn only
 * when the output holds exactly one `compaction` item. Native Responses
 * upstreams interpret the trigger themselves. Messages, Chat Completions, and
 * custom providers have no equivalent control, so translated routes request
 * the gateway summary and return it as a proxy compaction item, which
 * `expandCompactionItems` restores as the summary on later turns.
 */
const COMPACTION_TRIGGER_TYPE = "compaction_trigger"

const isCompactionTrigger = (item: unknown): boolean =>
  typeof item === "object"
  && item !== null
  && (item as { type?: unknown }).type === COMPACTION_TRIGGER_TYPE

export function hasCompactionTrigger(payload: { input?: unknown }): boolean {
  return (
    Array.isArray(payload.input)
    && payload.input.some((item) => isCompactionTrigger(item))
  )
}

/**
 * Turn a translated compaction request into the gateway summary request.
 * History, instructions, and tools stay intact so the summary sees the task's
 * full context. The trigger becomes a final user turn and tool calls are
 * disabled; adapters drop `tool_choice` when no tools survive translation.
 * Requests without a trigger are returned unchanged.
 */
export function toCompactionSummaryRequest<T extends object>(source: T): T {
  const record = source as Record<string, unknown>
  if (!hasCompactionTrigger(record)) return source
  const request: Record<string, unknown> = {
    ...record,
    input: [
      ...(record.input as Array<unknown>).filter(
        (item) => !isCompactionTrigger(item),
      ),
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: getCompactionTriggerPrompt() }],
      },
    ],
    tool_choice: "none",
  }
  delete request.parallel_tool_calls
  const text = record.text
  if (typeof text === "object" && text !== null && "format" in text) {
    const { format: _format, ...rest } = text as Record<string, unknown>
    request.text = rest
  }
  return request as T
}

/** Encode a summary as the proxy-owned item `expandCompactionItems` decodes. */
export function createProxyCompactionItem(
  summaryText: string,
): ResponseOutputCompaction {
  return {
    id: `cmp_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    type: "compaction",
    encrypted_content: Buffer.from(summaryText, "utf8").toString("base64"),
  }
}

/**
 * Replace a validated summary turn with the single compaction item that Codex
 * records as its new context window. Reasoning, text, and tool items from the
 * summary turn are not part of that window, so none of them are returned.
 */
export function toRemoteCompactionResult(
  result: ResponsesResult,
  summary: CompactionSummary,
): ResponsesResult {
  return {
    ...result,
    output: [createProxyCompactionItem(summary.summaryText)],
    output_text: "",
    status: "completed",
    error: null,
    incomplete_details: null,
    usage: result.usage ?? summary.usage,
  }
}
