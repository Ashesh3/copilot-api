import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { getCustomProviderModels } from "~/lib/custom-providers"
import { forwardError } from "~/lib/error"
import { generateVirtualModels } from "~/lib/model-suffix"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

function isModelVisible(model: Model): boolean {
  return model.model_picker_enabled || model.policy?.state === "enabled"
}

function getCopilotModelIds(models: Array<{ id: string }>): Set<string> {
  return new Set(models.map((model) => model.id))
}

function supportedEndpointsForClient(model: {
  supported_endpoints?: Array<string>
}): Array<string> | undefined {
  const endpoints = model.supported_endpoints
  if (!endpoints) return undefined
  if (!endpoints.includes("/responses")) return endpoints
  return [...new Set([...endpoints, "ws:/responses"])]
}

function toCopilotModelListing(model: Model) {
  const supportedEndpoints = supportedEndpointsForClient(model)
  return {
    id: model.id,
    object: "model",
    type: "model",
    created: 0, // No date available from source
    created_at: new Date(0).toISOString(), // No date available from source
    owned_by: model.vendor,
    display_name: model.name,
    name: model.name,
    vendor: model.vendor,
    version: model.version,
    preview: model.preview,
    capabilities: model.capabilities,
    ...(model.policy ? { policy: model.policy } : {}),
    ...(model.billing ? { billing: model.billing } : {}),
    ...(model.model_picker_category ?
      { model_picker_category: model.model_picker_category }
    : {}),
    ...(model.model_picker_price_category ?
      { model_picker_price_category: model.model_picker_price_category }
    : {}),
    ...(model.custom_model !== undefined ?
      { custom_model: model.custom_model }
    : {}),
    ...(model.issues ? { issues: model.issues } : {}),
    ...(model.warning_messages ?
      { warning_messages: model.warning_messages }
    : {}),
    ...(supportedEndpoints ? { supported_endpoints: supportedEndpoints } : {}),
  }
}

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const visibleModels =
      state.models?.data.filter((model) => isModelVisible(model)) ?? []

    // Copilot models
    const copilotModels = visibleModels.map((model) =>
      toCopilotModelListing(model),
    )

    // Virtual models for reasoning effort variants (e.g. "claude-sonnet-4.6:high")
    const virtualModels = generateVirtualModels(visibleModels).map((model) => {
      const supportedEndpoints = supportedEndpointsForClient(model)
      return {
        ...model,
        ...(supportedEndpoints ?
          { supported_endpoints: supportedEndpoints }
        : {}),
      }
    })
    const copilotModelIds = getCopilotModelIds([
      ...copilotModels,
      ...virtualModels,
    ])
    const customModels = getCustomProviderModels().filter(
      (model) => model.alias || !copilotModelIds.has(model.id),
    )

    return c.json({
      object: "list",
      data: [...copilotModels, ...virtualModels, ...customModels],
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
