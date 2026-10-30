import type { WebProtocol } from "./tool-context"

import { isRecord } from "./tool-context"

/** Usage fields that count a call's prompt rather than its output. */
const INPUT_FIELDS: Record<WebProtocol, ReadonlyArray<string>> = {
  responses: ["input_tokens", "input_tokens_details"],
  messages: [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "cache_creation",
  ],
  chat: ["prompt_tokens", "prompt_tokens_details"],
}

/**
 * Droid reads a response's input and cache tokens as its context size, and
 * compacts by it. Each gateway round's prompt already holds the rounds before
 * it, so a carrier response reports the last round's input-side counters with
 * the output of every round. Request accounting keeps the per-round totals.
 */
export function droidReportedUsage(
  last: unknown,
  total: Record<string, unknown> | undefined,
  protocol: WebProtocol,
): Record<string, unknown> | undefined {
  if (!total || !isRecord(last)) return total
  const reported = { ...total }
  for (const field of INPUT_FIELDS[protocol]) {
    if (Object.hasOwn(last, field))
      reported[field] = structuredClone(last[field])
    else Reflect.deleteProperty(reported, field)
  }
  const { input_tokens: input, output_tokens: output } = reported
  if (
    protocol === "responses"
    && typeof input === "number"
    && typeof output === "number"
  )
    reported.total_tokens = input + output
  return reported
}
