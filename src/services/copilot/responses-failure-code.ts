import type { HttpErrorInspection } from "~/lib/error"

import {
  readContextOverflow,
  readContextOverflowText,
} from "./context-overflow"

const TOO_MANY_REQUESTS = 429
// Rate limits, timeouts and conflicts may pass; other client errors repeat.
const TRANSIENT_CLIENT_STATUSES = new Set([408, 409, 425, TOO_MANY_REQUESTS])

function isContextOverflow(inspection: HttpErrorInspection): boolean {
  if (inspection.kind === "upstream") {
    return (
      readContextOverflowText(inspection.status, inspection.bodyText)
      !== undefined
    )
  }
  if (inspection.kind === "custom-provider" && inspection.providerError) {
    return (
      readContextOverflow(inspection.status, {
        error: inspection.providerError,
      }) !== undefined
    )
  }
  return false
}

/**
 * Once the stream has started, a failure reaches the client only as
 * `response.failed`, and its code decides what Codex does. Codex retries a
 * code it does not know up to five times, compacts on
 * `context_length_exceeded`, and stops on `invalid_prompt`. A request the
 * provider refused fails the same way every time, so only rate limits and
 * server errors stay retryable, with their `retry-after`.
 */
export function classifyResponsesFailure(
  inspection: HttpErrorInspection,
): string {
  const { status } = inspection
  if (isContextOverflow(inspection)) return "context_length_exceeded"
  if (status === TOO_MANY_REQUESTS) return "rate_limit_exceeded"
  if (status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.has(status)) {
    return "invalid_prompt"
  }
  return "server_error"
}
