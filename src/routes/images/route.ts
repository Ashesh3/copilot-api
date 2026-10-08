import { Hono, type Context } from "hono"

import {
  createInvalidJsonBodyError,
  createInvalidRequestError,
  forwardError,
} from "~/lib/error"
import {
  dispatchNativeCopilotRequest,
  isNonBlankString,
  isRecord,
  readJsonRequestModel,
} from "~/lib/native-passthrough"
import { readRequestJson } from "~/lib/request-json"
import { state } from "~/lib/state"

export const imageRoutes = new Hono()

type ImageEndpoint = "/v1/images/edits" | "/v1/images/generations"

interface ImageRequest {
  body: string | Uint8Array<ArrayBuffer>
  contentType: string
  model: string
  requestedModel: string
}

/** Codex's built-in image tool always requests this OpenAI model. */
const CODEX_IMAGE_MODEL = "gpt-image-2"

/**
 * Copilot does not serve `gpt-image-2`. While no live catalog lists it, the
 * name resolves to the first live model that advertises the requested route.
 * Every other name, including unavailable Copilot image models, is unchanged.
 */
function resolveImageModel(model: string, endpoint: ImageEndpoint): string {
  if (model !== CODEX_IMAGE_MODEL) return model
  const catalog = state.models?.data ?? []
  if (catalog.some((entry) => entry.id === model)) return model
  return (
    catalog.find((entry) => entry.supported_endpoints?.includes(endpoint))?.id
    ?? model
  )
}

async function readJsonImageRequest(
  c: Context,
  endpoint: ImageEndpoint,
): Promise<ImageRequest> {
  const parsed = await readRequestJson(() => c.req.json<unknown>())
  if (!parsed.ok) throw createInvalidJsonBodyError()
  const value = parsed.value
  const requestedModel = readJsonRequestModel(value)
  const model = resolveImageModel(requestedModel, endpoint)
  // Assigning in place keeps every other field and the key order.
  if (model !== requestedModel && isRecord(value)) value.model = model
  return {
    body: JSON.stringify(value),
    contentType: "application/json",
    model,
    requestedModel,
  }
}

async function readMultipartEdit(
  c: Context,
  contentType: string,
): Promise<ImageRequest> {
  // Copy the uploaded bytes before parsing consumes the body.
  const body = new Uint8Array(await c.req.raw.clone().arrayBuffer())
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    throw createInvalidRequestError(
      "The multipart request body could not be parsed.",
      "body",
    )
  }
  const requestedModel = form.get("model")
  if (!isNonBlankString(requestedModel))
    throw createInvalidRequestError("model is required", "model")
  const model = resolveImageModel(requestedModel, "/v1/images/edits")
  // Copilot receives the uploaded bytes unchanged unless the model resolves to
  // another name; only then is the form re-encoded under a new boundary.
  if (model === requestedModel)
    return { body, contentType, model, requestedModel }
  form.set("model", model)
  const encoded = new Response(form)
  // Bun reports the generated boundary only if the header is read before the
  // body; a stale boundary would make Copilot reject the upload.
  const encodedContentType = encoded.headers.get("content-type")
  if (!encodedContentType)
    throw new Error("The re-encoded image edit has no multipart boundary.")
  return {
    body: new Uint8Array(await encoded.arrayBuffer()),
    contentType: encodedContentType,
    model,
    requestedModel,
  }
}

async function readImageEdit(
  c: Context,
  contentType: string,
): Promise<ImageRequest> {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType === "application/json")
    return await readJsonImageRequest(c, "/v1/images/edits")
  if (mediaType === "multipart/form-data")
    return await readMultipartEdit(c, contentType)
  throw createInvalidRequestError(
    "Image edit requests require application/json or multipart/form-data.",
    "body",
  )
}

imageRoutes.post("/generations", async (c) => {
  try {
    const request = await readJsonImageRequest(c, "/v1/images/generations")
    return await dispatchNativeCopilotRequest(c, {
      ...request,
      endpoint: "/v1/images/generations",
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

imageRoutes.post("/edits", async (c) => {
  try {
    // Copilot reads a request without a content type as JSON; so does this.
    const header = c.req.header("content-type")?.trim() ?? ""
    const contentType = header === "" ? "application/json" : header
    const request = await readImageEdit(c, contentType)
    return await dispatchNativeCopilotRequest(c, {
      ...request,
      endpoint: "/v1/images/edits",
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
