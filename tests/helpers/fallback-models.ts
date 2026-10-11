import type { ModelsResponse } from "~/services/copilot/get-models"

/** Advertised chat models for fallback tests without an upstream transport. */
export function fallbackModels(ids: ReadonlyArray<string>): ModelsResponse {
  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      name: id,
      object: "model",
      version: "fixture",
      capabilities: {
        family: "fixture",
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    })),
  }
}
