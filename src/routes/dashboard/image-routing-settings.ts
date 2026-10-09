import type { Context } from "hono"

import {
  getImageRoutingModel,
  isValidImageRoutingModel,
  setImageRoutingModel,
} from "~/lib/config"
import { automaticImageModel, listLiveImageModels } from "~/lib/image-routing"

export interface ImageModelOption {
  endpoints: Array<string>
  id: string
  name: string
}

export interface ImageRoutingSettings {
  imageModels: Array<ImageModelOption>
  imageRoutingAutomaticModel: string | null
  imageRoutingModel: string | null
}

export function getImageRoutingSettings(): ImageRoutingSettings {
  return {
    imageModels: listLiveImageModels().map((model) => ({
      endpoints: (model.supported_endpoints ?? []).filter((endpoint) =>
        endpoint.startsWith("/v1/images/"),
      ),
      id: model.id,
      name: model.name,
    })),
    imageRoutingAutomaticModel: automaticImageModel(),
    imageRoutingModel: getImageRoutingModel(),
  }
}

export async function handleSetImageRouting(c: Context) {
  const body: unknown = await c.req.json().catch(() => null)
  if (
    !body
    || typeof body !== "object"
    || Array.isArray(body)
    || !("model" in body)
  )
    return c.json({ error: "Expected a JSON object with a model" }, 400)
  const raw = body.model
  if (raw !== null && !isValidImageRoutingModel(raw))
    return c.json(
      {
        error:
          "model must be null or a string of at most 256 characters without control characters",
      },
      400,
    )

  const model = raw?.trim() || null
  if (model !== null) {
    const live = listLiveImageModels()
    if (live.length > 0 && !live.some((entry) => entry.id === model))
      return c.json({ error: `${model} is not a live image model` }, 400)
  }

  const saved = await setImageRoutingModel(model)
  // This request still reads the configuration snapshot it started with.
  return c.json({ ...getImageRoutingSettings(), imageRoutingModel: saved })
}
