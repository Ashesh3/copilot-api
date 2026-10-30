import { randomUUID } from "node:crypto"

import {
  inspectHttpError,
  isHTTPError,
  type UpstreamHttpErrorInspection,
} from "~/lib/error"
import { readContextOverflowText } from "~/services/copilot/context-overflow"

/**
 * Codex compacts when a response fails with `context_length_exceeded`: it
 * marks the context window full so the next turn compacts first, and its
 * compaction drops the oldest history and retries. It reads any other 400 as
 * a request error and repeats the same oversized turn. Codex requests are
 * answered in that contract when Copilot refuses a prompt over the limit.
 *
 * Droid compacts and retries a turn whose error has OpenAI's
 * `context_length_exceeded` code or a message it knows as an overflow.
 * Copilot's own refusal, "prompt token count of N exceeds the limit of M"
 * with code `model_max_prompt_tokens_exceeded`, is neither, so Droid would
 * end the turn with an error. Droid requests get OpenAI's error instead.
 */

// Every Codex Responses request carries these client metadata keys.
const CODEX_CLIENT_METADATA_KEYS = [
  "x-codex-installation-id",
  "x-codex-turn-metadata",
  "x-codex-window-id",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function isCodexResponsesRequest(
  payload: Record<string, unknown>,
): boolean {
  const metadata = parseRecord(payload.client_metadata)
  return (
    metadata !== undefined
    && CODEX_CLIENT_METADATA_KEYS.some((key) => Object.hasOwn(metadata, key))
  )
}

export interface UpstreamContextOverflow {
  readonly inspection: UpstreamHttpErrorInspection
  readonly message: string
}

/** Copilot's refusal of a prompt over the model's limit, if `error` is one. */
export async function readUpstreamContextOverflow(
  error: unknown,
): Promise<UpstreamContextOverflow | undefined> {
  if (!isHTTPError(error)) return undefined
  const inspection = await inspectHttpError(error)
  if (inspection.kind !== "upstream") return undefined
  const overflow = readContextOverflowText(
    inspection.status,
    inspection.bodyText,
  )
  return overflow && { inspection, message: overflow.message }
}

const CONTEXT_OVERFLOW_MESSAGE =
  "Your input exceeds the context window of this model."

/** OpenAI's HTTP error for input over the model's context window. */
export function createContextOverflowErrorBody(message: string): {
  error: Record<string, string>
} {
  return {
    error: {
      message: message || CONTEXT_OVERFLOW_MESSAGE,
      type: "invalid_request_error",
      param: "input",
      code: "context_length_exceeded",
    },
  }
}

export function createContextOverflowFailedEvent(options: {
  message: string
  model?: string
}): Record<string, unknown> {
  return {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: `resp_${randomUUID().replaceAll("-", "")}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      ...(options.model ? { model: options.model } : {}),
      status: "failed",
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "context_length_exceeded",
        message: options.message || CONTEXT_OVERFLOW_MESSAGE,
      },
      incomplete_details: null,
    },
  }
}
