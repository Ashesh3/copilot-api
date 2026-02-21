import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { generateVirtualModels } from "~/lib/model-suffix"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    // Copilot models
    const copilotModels =
      state.models?.data.map((model) => ({
        id: model.id,
        object: "model",
        type: "model",
        created: 0, // No date available from source
        created_at: new Date(0).toISOString(), // No date available from source
        owned_by: model.vendor,
        display_name: model.name,
      })) ?? []

    // Virtual models for reasoning effort variants (e.g. "claude-sonnet-4.6:high")
    const virtualModels =
      state.models ? generateVirtualModels(state.models.data) : []

    return c.json({
      object: "list",
      data: [...copilotModels, ...virtualModels],
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
