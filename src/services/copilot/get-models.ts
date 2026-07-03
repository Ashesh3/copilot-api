import consola from "consola"

import { HTTPError } from "~/lib/error"
import {
  MODELS_API_VERSION,
  copilotFetch,
  copilotHeaders,
} from "~/services/copilot/copilot-client"

export const getModels = async () => {
  const response = await copilotFetch("/models", {
    headers: {
      ...copilotHeaders(),
      "X-GitHub-Api-Version": MODELS_API_VERSION,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    let errorDetails: string
    try {
      const parsed: unknown = JSON.parse(errorBody)
      errorDetails = JSON.stringify(parsed, null, 2)
    } catch {
      errorDetails = errorBody || "(empty response)"
    }
    consola.error(
      `Failed to get models from /models\n`
        + `Status: ${response.status} ${response.statusText}\n`
        + `Response: ${errorDetails}`,
    )
    throw new HTTPError(
      `Failed to get models: ${response.status} ${response.statusText}`,
      response,
    )
  }

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

export interface ModelVisionLimits {
  max_prompt_image_size?: number
  max_prompt_images?: number
  supported_media_types?: Array<string>
}

export interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: ModelVisionLimits
}

export interface ModelSupports {
  max_thinking_budget?: number
  min_thinking_budget?: number
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  structured_outputs?: boolean
  vision?: boolean
  adaptive_thinking?: boolean
  reasoning_effort?: Array<string>
}

export interface ModelCapabilities {
  family: string
  limits?: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface ModelTokenPriceTier {
  cache_price?: number
  context_max?: number
  input_price?: number
  output_price?: number
}

export interface FlatTokenPrices {
  [key: string]: number | undefined
}

export interface TieredTokenPrices {
  batch_size?: number
  default: ModelTokenPriceTier
  long_context?: ModelTokenPriceTier
}

export interface ModelBilling {
  multiplier?: number
  restricted_to?: Array<string>
  token_prices?: FlatTokenPrices | TieredTokenPrices
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  billing?: ModelBilling
  custom_model?: boolean
  issues?: Array<unknown>
  model_picker_category?: string
  model_picker_price_category?: string
  supported_endpoints?: Array<string>
  warning_messages?: Array<string>
}
