import { Hono, type Context, type HonoRequest } from "hono"

import {
  createInvalidJsonBodyError,
  createInvalidRequestError,
  forwardError,
} from "~/lib/error"
import {
  dispatchNativeCopilotRequest,
  isNonBlankString,
  readJsonRequestModel,
} from "~/lib/native-passthrough"
import { readRequestJson } from "~/lib/request-json"

export const imageRoutes = new Hono()

async function readJsonImageRequest(
  c: Context,
): Promise<{ body: string; model: string }> {
  const parsed = await readRequestJson(() => c.req.json<unknown>())
  if (!parsed.ok) throw createInvalidJsonBodyError()
  return {
    body: JSON.stringify(parsed.value),
    model: readJsonRequestModel(parsed.value),
  }
}

async function readMultipartModel(request: HonoRequest): Promise<string> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    throw createInvalidRequestError(
      "The multipart request body could not be parsed.",
      "body",
    )
  }
  const model = form.get("model")
  if (!isNonBlankString(model))
    throw createInvalidRequestError("model is required", "model")
  return model
}

imageRoutes.post("/generations", async (c) => {
  try {
    const request = await readJsonImageRequest(c)
    return await dispatchNativeCopilotRequest(c, {
      ...request,
      contentType: "application/json",
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
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase()
    if (mediaType === "application/json") {
      const request = await readJsonImageRequest(c)
      return await dispatchNativeCopilotRequest(c, {
        ...request,
        contentType: "application/json",
        endpoint: "/v1/images/edits",
      })
    }
    if (mediaType === "multipart/form-data") {
      // Copilot receives the uploaded bytes unchanged; the parsed form only
      // supplies the routing model.
      const body = new Uint8Array(await c.req.raw.clone().arrayBuffer())
      return await dispatchNativeCopilotRequest(c, {
        body,
        contentType,
        endpoint: "/v1/images/edits",
        model: await readMultipartModel(c.req),
      })
    }
    throw createInvalidRequestError(
      "Image edit requests require application/json or multipart/form-data.",
      "body",
    )
  } catch (error) {
    return await forwardError(c, error)
  }
})
