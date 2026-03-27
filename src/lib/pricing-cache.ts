import consola from "consola"

export interface ModelPricing {
  inputPricePerToken: number
  outputPricePerToken: number
}

/**
 * Cache of model name -> pricing data from PricePerToken API.
 */
export const pricingCache = new Map<string, ModelPricing>()

/**
 * Maps copilot-api model names to PricePerToken API identifiers.
 * Only needed when the copilot name differs from what PricePerToken uses.
 */
const MODEL_NAME_MAP: Record<string, string> = {
  // Claude models - Copilot uses shortened names
  "claude-sonnet-4.6": "claude-sonnet-4-5-20250514",
  "claude-opus-4.6": "claude-opus-4-20250514",
  "claude-opus-4.6-fast": "claude-opus-4-20250514",
  "claude-opus-4.6-1m": "claude-opus-4-20250514",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  // GPT models
  "gpt-4.1": "gpt-4.1-2025-04-14",
  "gpt-4.1-mini": "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano": "gpt-4.1-nano-2025-04-14",
  "gpt-4o": "gpt-4o-2024-08-06",
  "gpt-4o-mini": "gpt-4o-mini-2024-07-18",
  // o-series reasoning models
  "o3-mini": "o3-mini-2025-01-31",
  "o4-mini": "o4-mini-2025-04-16",
}

interface PricePerTokenModel {
  model_id: string
  input_price_per_token: number
  output_price_per_token: number
}

interface JsonRpcResponse {
  result?: {
    content?: Array<{
      type: string
      text?: string
    }>
  }
  error?: {
    code: number
    message: string
  }
}

/**
 * Fetch pricing data from PricePerToken API and populate the cache.
 * Best-effort: logs on failure, never throws.
 */
export async function refreshPricingCache(): Promise<void> {
  try {
    consola.debug("Refreshing pricing cache from PricePerToken API")

    const response = await fetch("https://api.pricepertoken.com/mcp/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "get_all_models",
          arguments: {},
        },
      }),
    })

    if (!response.ok) {
      consola.debug(
        `PricePerToken API returned ${response.status} ${response.statusText}`,
      )
      return
    }

    const data = (await response.json()) as JsonRpcResponse

    if (data.error) {
      consola.debug(
        `PricePerToken API error: ${data.error.code} ${data.error.message}`,
      )
      return
    }

    const textContent = data.result?.content?.find((c) => c.type === "text")
    if (!textContent?.text) {
      consola.debug("PricePerToken API returned no text content")
      return
    }

    const models = JSON.parse(textContent.text) as Array<PricePerTokenModel>

    pricingCache.clear()
    for (const model of models) {
      pricingCache.set(model.model_id, {
        inputPricePerToken: model.input_price_per_token,
        outputPricePerToken: model.output_price_per_token,
      })
    }

    consola.debug(`Pricing cache loaded with ${pricingCache.size} models`)
  } catch (error) {
    consola.debug(
      `Failed to refresh pricing cache: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Look up pricing for a model. Tries direct lookup, mapped name, then fuzzy match.
 */
export function getModelPricing(modelName: string): ModelPricing | undefined {
  // 1. Direct cache lookup
  const direct = pricingCache.get(modelName)
  if (direct) return direct

  // 2. Mapped name lookup
  const mappedName = MODEL_NAME_MAP[modelName]
  if (mappedName) {
    const mapped = pricingCache.get(mappedName)
    if (mapped) return mapped
  }

  // 3. Fuzzy match - find a cached key that contains the model name or vice versa
  const lowerName = modelName.toLowerCase()
  for (const [key, pricing] of pricingCache) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.includes(lowerName) || lowerName.includes(lowerKey)) {
      return pricing
    }
  }

  return undefined
}

interface CostResult {
  inputCostUsd: number
  outputCostUsd: number
}

/**
 * Calculate cost for a model given input and output token counts.
 * Returns zero costs if pricing is unavailable.
 */
export function calculateCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
): CostResult {
  const pricing = getModelPricing(modelName)
  if (!pricing) {
    return { inputCostUsd: 0, outputCostUsd: 0 }
  }

  return {
    inputCostUsd: inputTokens * pricing.inputPricePerToken,
    outputCostUsd: outputTokens * pricing.outputPricePerToken,
  }
}
