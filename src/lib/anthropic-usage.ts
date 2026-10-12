import type { AnthropicResponse } from "~/routes/messages/anthropic-types"

import { normalizeUsageTokenCount } from "~/lib/storage/usage-counters"

type AnthropicUsage = Partial<AnthropicResponse["usage"]> | undefined | null

/** A missing count can be inherited; an explicitly invalid count stays unknown. */
export function readAnthropicUsageTokenCount(
  value: unknown,
  previous = 0,
): number {
  return value === undefined ? previous : (
      (normalizeUsageTokenCount(value) ?? Number.NaN)
    )
}

export function hasAnthropicUsageCounts(usage: AnthropicUsage): boolean {
  return (
    usage?.input_tokens !== undefined
    || usage?.output_tokens !== undefined
    || usage?.cache_read_input_tokens !== undefined
    || usage?.cache_creation_input_tokens !== undefined
  )
}

/** Anthropic input counts exclude cache reads and writes; validate before adding. */
export function readAnthropicUsage(usage: AnthropicUsage):
  | {
      inputTokens: number
      outputTokens: number
      cachedTokens: number
      cacheCreationTokens: number
    }
  | undefined {
  if (!hasAnthropicUsageCounts(usage)) return undefined
  const cachedTokens = readAnthropicUsageTokenCount(
    usage?.cache_read_input_tokens,
  )
  const cacheCreationTokens = readAnthropicUsageTokenCount(
    usage?.cache_creation_input_tokens,
  )
  return {
    inputTokens:
      readAnthropicUsageTokenCount(usage?.input_tokens)
      + cachedTokens
      + cacheCreationTokens,
    outputTokens: readAnthropicUsageTokenCount(usage?.output_tokens),
    cachedTokens,
    cacheCreationTokens,
  }
}
