import type { AnthropicResponse } from "~/routes/messages/anthropic-types"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"
import type {
  ResponseUsage,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import { LocalHTTPError } from "~/lib/error"

import { anthropicResponseToResponsesResult } from "./messages-bridge"

export interface CompactionSummary {
  summaryText: string
  usage: ResponseUsage | null
}

function failCompactionSummary(reason: string): never {
  const clientBody = {
    error: {
      code: "compaction_summary_failed",
      message: `Compaction summary generation did not complete: ${reason}. Keep the original conversation and retry.`,
      type: "server_error",
    },
  }
  throw new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 502 }),
    clientBody,
  )
}

function requireSummaryText(text: string): string {
  if (!text.trim()) failCompactionSummary("empty summary")
  return text
}

function extractResponsesSummary(result: Partial<ResponsesResult>): string {
  const messages = (result.output ?? []).filter(
    (item) => item.type === "message",
  )
  const finalMessages = messages.filter((item) => item.phase === "final_answer")
  const selected = finalMessages.length > 0 ? finalMessages : messages
  const text = selected
    .flatMap((item) =>
      (item.content ?? []).flatMap((block) =>
        block.type === "output_text" && typeof block.text === "string" ?
          [block.text]
        : [],
      ),
    )
    .join("\n")
  // An explicit empty final answer must not fall back to commentary text.
  if (finalMessages.length > 0 || text.trim()) return text
  return typeof result.output_text === "string" ? result.output_text : ""
}

export function responsesCompactionSummary(
  result: Partial<ResponsesResult>,
): CompactionSummary {
  if (result.error) {
    failCompactionSummary(
      result.error.message || result.error.code || "upstream error",
    )
  }
  if (result.incomplete_details) {
    failCompactionSummary(
      result.incomplete_details.reason ?? "incomplete response",
    )
  }
  // Older successful responses omit status. Reject explicit nonterminal or
  // unsuccessful outcomes while preserving that established wire form.
  if (result.status && result.status !== "completed") {
    failCompactionSummary(result.status)
  }
  if (
    result.output?.some((item) => item.status && item.status !== "completed")
  ) {
    failCompactionSummary("incomplete output")
  }
  return {
    summaryText: requireSummaryText(extractResponsesSummary(result)),
    usage: result.usage ?? null,
  }
}

export function chatCompactionSummary(
  result: Partial<ChatCompletionResponse>,
): CompactionSummary {
  const choice = result.choices?.at(0)
  const finishReason = choice?.finish_reason
  if (finishReason && finishReason !== "stop") {
    failCompactionSummary(finishReason)
  }
  const usage = result.usage
  return {
    summaryText: requireSummaryText(choice?.message.content ?? ""),
    usage:
      usage ?
        {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        }
      : null,
  }
}

export function messagesCompactionSummary(
  result: AnthropicResponse,
): CompactionSummary {
  if (
    result.stop_reason
    && !["end_turn", "stop_sequence"].includes(result.stop_reason)
  ) {
    failCompactionSummary(result.stop_reason)
  }
  return responsesCompactionSummary(
    anthropicResponseToResponsesResult(result, result.model),
  )
}
