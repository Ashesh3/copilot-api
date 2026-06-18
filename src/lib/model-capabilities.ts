import type { Model, ModelTokenPriceTier } from "~/services/copilot/get-models"

const ONE_MILLION_CONTEXT_TOKENS = 1_000_000
const ONE_MILLION_PROMPT_TOKENS = 900_000

export function modelHasOneMillionContext(
  model: Pick<Model, "billing" | "capabilities">,
): boolean {
  const limits = model.capabilities.limits
  if ((limits.max_context_window_tokens ?? 0) >= ONE_MILLION_CONTEXT_TOKENS) {
    return true
  }
  if ((limits.max_prompt_tokens ?? 0) >= ONE_MILLION_PROMPT_TOKENS) {
    return true
  }

  return getLongContextBillingMax(model) >= ONE_MILLION_PROMPT_TOKENS
}

function getLongContextBillingMax(model: Pick<Model, "billing">): number {
  const tokenPrices = model.billing?.token_prices
  if (!tokenPrices) return 0

  const longContext = (tokenPrices as { long_context?: unknown }).long_context
  if (!isModelTokenPriceTier(longContext)) return 0
  return longContext.context_max ?? 0
}

function isModelTokenPriceTier(value: unknown): value is ModelTokenPriceTier {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
