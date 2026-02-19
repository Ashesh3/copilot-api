import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/retry-fetch"
import { state } from "~/lib/state"

export const getModels = async () => {
  const url = `${copilotBaseUrl(state)}/models`
  const response = await fetchWithRetry(url, {
    headers: copilotHeaders(state),
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
      `Failed to get models from ${url}\n`
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

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  max_thinking_budget?: number
  min_thinking_budget?: number
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  structured_outputs?: boolean
  vision?: boolean
  adaptive_thinking?: boolean
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
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
  supported_endpoints?: Array<string>
}
