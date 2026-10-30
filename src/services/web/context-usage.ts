import type { PreparedManagedWebTools, WebProtocol } from "./tool-context"

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

/** A dialect's total, followed by the input and output counters it adds. */
const TOTALS: Partial<Record<WebProtocol, readonly [string, string, string]>> =
  {
    responses: ["total_tokens", "input_tokens", "output_tokens"],
    chat: ["total_tokens", "prompt_tokens", "completion_tokens"],
  }

/**
 * Codex and Droid read a response's input tokens as the size of their
 * context, and compact by it. Each gateway round's prompt already holds the
 * rounds before it, so such a response reports the last round's input-side
 * counters with the output of every round. Request accounting still counts
 * every round.
 */
export function lastRoundContextUsage(
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
  const totals = TOTALS[protocol]
  if (totals) {
    const [sum, input, output] = totals
    const inputCount = reported[input]
    const outputCount = reported[output]
    if (typeof inputCount === "number" && typeof outputCount === "number")
      reported[sum] = inputCount + outputCount
  }
  return reported
}

/**
 * Whether the client speaks Responses, such as Codex, over any upstream
 * protocol. It reads usage the way Codex does.
 */
export function servesResponsesClient(
  prepared: PreparedManagedWebTools,
): boolean {
  return prepared.context?.clientProtocol === "responses"
}
