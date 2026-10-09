import type { Model } from "~/services/copilot/get-models"

import { getImageRoutingModel } from "~/lib/config"
import { state } from "~/lib/state"

export type ImageEndpoint = "/v1/images/edits" | "/v1/images/generations"

const IMAGE_ENDPOINTS: Array<ImageEndpoint> = [
  "/v1/images/generations",
  "/v1/images/edits",
]

/** Codex's built-in image tool always requests this OpenAI model. */
const CODEX_IMAGE_MODEL = "gpt-image-2"

function liveModels(): Array<Model> {
  return state.models?.data ?? []
}

function serves(model: Model, endpoint: ImageEndpoint): boolean {
  return model.supported_endpoints?.includes(endpoint) === true
}

/** Live models that advertise an Images route, in catalog order. */
export function listLiveImageModels(): Array<Model> {
  return liveModels().filter((model) =>
    IMAGE_ENDPOINTS.some((endpoint) => serves(model, endpoint)),
  )
}

function firstLiveImageModel(endpoint: ImageEndpoint): string | undefined {
  return liveModels().find((model) => serves(model, endpoint))?.id
}

/** The model automatic routing currently gives Codex's image generations. */
export function automaticImageModel(): string | null {
  return firstLiveImageModel("/v1/images/generations") ?? null
}

/**
 * The dashboard's image model serves every image request while a live catalog
 * lists it for the route. Otherwise routing is automatic: requests keep their
 * model, except that Codex's `gpt-image-2`, which Copilot does not serve,
 * resolves to the first live model that advertises the route.
 */
export function resolveImageModel(
  requested: string,
  endpoint: ImageEndpoint,
): string {
  const catalog = liveModels()
  const configured = getImageRoutingModel()
  if (
    configured
    && catalog.some(
      (model) => model.id === configured && serves(model, endpoint),
    )
  )
    return configured
  if (
    requested !== CODEX_IMAGE_MODEL
    || catalog.some((model) => model.id === requested)
  )
    return requested
  return firstLiveImageModel(endpoint) ?? requested
}
