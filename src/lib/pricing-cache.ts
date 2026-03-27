import consola from "consola"

export interface ModelPricing {
  inputPricePerToken: number
  outputPricePerToken: number
}

/**
 * Cache of model slug -> pricing data from PricePerToken API.
 */
export const pricingCache = new Map<string, ModelPricing>()

/**
 * Maps copilot-api model names to PricePerToken API slugs.
 */
const MODEL_NAME_MAP: Record<string, string> = {
  "claude-sonnet-4.6": "anthropic-claude-sonnet-4.6",
  "claude-opus-4.6": "anthropic-claude-opus-4.6",
  "claude-opus-4.6-fast": "anthropic-claude-opus-4.6",
  "claude-opus-4.6-1m": "anthropic-claude-opus-4.6",
  "claude-sonnet-4": "anthropic-claude-sonnet-4",
  "claude-sonnet-4.5": "anthropic-claude-sonnet-4.5",
  "claude-opus-4": "anthropic-claude-opus-4",
  "claude-opus-4.5": "anthropic-claude-opus-4.5",
  "claude-haiku-4.5": "anthropic-claude-haiku-4.5",
  "claude-haiku-3.5": "anthropic-claude-3.5-haiku",
  "claude-3.5-haiku": "anthropic-claude-3.5-haiku",
}

interface PricePerTokenModel {
  slug: string
  author_name: string
  model_name: string
  input_per_1m: number
  output_per_1m: number
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
    const response = await fetch("https://api.pricepertoken.com/mcp/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
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
      pricingCache.set(model.slug, {
        inputPricePerToken: model.input_per_1m / 1_000_000,
        outputPricePerToken: model.output_per_1m / 1_000_000,
      })
    }

    consola.info(`Pricing cache loaded: ${pricingCache.size} models`)
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
  const direct = pricingCache.get(modelName)
  if (direct) return direct

  const mappedName = MODEL_NAME_MAP[modelName]
  if (mappedName) {
    const mapped = pricingCache.get(mappedName)
    if (mapped) return mapped
  }

  // Fuzzy match
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
