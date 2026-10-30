import type { UpstreamHttpErrorInspection } from "~/lib/error"

import type { AnthropicErrorEvent } from "./anthropic-types"

/**
 * Messages clients such as Claude Code compact the conversation and retry
 * only when an error says the prompt is too long. Copilot reports the same
 * limit for Responses and Chat Completions models in other words, so those
 * errors are restated in the Messages wording, keeping the token counts.
 */
const PROMPT_TOO_LONG = /^prompt is too long/i
const COPILOT_PROMPT_LIMIT =
  /prompt token count of (\d+) exceeds the limit of (\d+)/i
// OpenAI's Chat Completions wording: "This model's maximum context length is
// M tokens. However, your messages resulted in N tokens."
const MAXIMUM_CONTEXT_LENGTH = /maximum context length is (\d+) tokens/i
const RESULTED_IN_TOKENS = /resulted in (\d+) tokens/i
const CONTEXT_WINDOW_EXCEEDED =
  /exceeds the context window|maximum context length/i
const CONTEXT_OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "model_max_prompt_tokens_exceeded",
])

export interface ProviderErrorFields {
  code?: unknown
  message?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toPromptTooLongMessage(
  error: ProviderErrorFields,
): string | undefined {
  if (typeof error.message !== "string") return undefined
  const message = error.message.trim()
  if (PROMPT_TOO_LONG.test(message)) return undefined
  const counts = COPILOT_PROMPT_LIMIT.exec(message)
  if (counts) {
    return `prompt is too long: ${counts[1]} tokens > ${counts[2]} maximum`
  }
  const limit = MAXIMUM_CONTEXT_LENGTH.exec(message)?.[1]
  const prompt = RESULTED_IN_TOKENS.exec(message)?.[1]
  if (limit && prompt) {
    return `prompt is too long: ${prompt} tokens > ${limit} maximum`
  }
  const overflow =
    (typeof error.code === "string" && CONTEXT_OVERFLOW_CODES.has(error.code))
    || CONTEXT_WINDOW_EXCEEDED.test(message)
  return overflow ? `prompt is too long: ${message}` : undefined
}

/** Restate a provider context overflow as an Anthropic prompt-too-long error. */
export function createPromptTooLongError(
  error: ProviderErrorFields,
): AnthropicErrorEvent | undefined {
  const message = toPromptTooLongMessage(error)
  if (!message) return undefined
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    },
  }
}

/** Read a context overflow from an upstream error body in either dialect. */
export function createUpstreamPromptTooLongError(
  inspection: UpstreamHttpErrorInspection,
): AnthropicErrorEvent | undefined {
  if (inspection.status !== 400 && inspection.status !== 413) return undefined
  if (inspection.bodyText === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(inspection.bodyText)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined
  return createPromptTooLongError(parsed.error)
}
