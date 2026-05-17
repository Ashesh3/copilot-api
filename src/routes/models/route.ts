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

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const visibleModels =
      state.models?.data.filter((model) => isModelVisible(model)) ?? []

    // Copilot models
    const copilotModels = visibleModels.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(), // No date available from source
      owned_by: model.vendor,
      display_name: model.name,
    }))

    // Virtual models for reasoning effort variants (e.g. "claude-sonnet-4.6:high")
    const virtualModels = generateVirtualModels(visibleModels)
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
