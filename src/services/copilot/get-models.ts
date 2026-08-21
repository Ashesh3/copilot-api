import consola from "consola"

import { HTTPError } from "~/lib/error"
import { copilotFetch, copilotHeaders } from "~/services/copilot/copilot-client"

export const getModels = async () => {
  const response = await copilotFetch("/models", {
    headers: copilotHeaders(),
  })

  if (!response.ok) {
    consola.error("Failed to get models", `Status: ${response.status}`)
    throw new HTTPError("Failed to get models", response)
  }

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

export interface ModelVisionLimits {
  [key: string]: unknown
  max_prompt_image_size?: number
  max_prompt_images?: number
  supported_media_types?: Array<string>
}

export interface ModelLimits {
  [key: string]: unknown
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: ModelVisionLimits
}

export interface ModelSupports {
  [key: string]: unknown
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
  [key: string]: unknown
  family: string
  limits?: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface ModelTokenPriceTier {
  [key: string]: unknown
  cache_price?: number
  context_max?: number
  input_price?: number
  output_price?: number
}

export interface FlatTokenPrices {
  [key: string]: number | undefined
}

export interface TieredTokenPrices {
  [key: string]: unknown
  batch_size?: number
  default: ModelTokenPriceTier
  long_context?: ModelTokenPriceTier
}

export interface ModelBilling {
  [key: string]: unknown
  auto_discount?: number
  multiplier?: number
  restricted_to?: Array<string>
  token_prices?: FlatTokenPrices | TieredTokenPrices
}

export interface Model {
  [key: string]: unknown
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled?: boolean
  name: string
  object: string
  preview?: boolean
  supported_endpoints?: Array<string>
  vendor?: string
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
  warning_messages?: Array<string>
}
