import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import {
  getLastUsedAccountId,
  runWithRoutedModelSelection,
  selectRoutedModel,
} from "~/lib/account-router"
import { createInvalidRequestError, LocalHTTPError } from "~/lib/error"
import { setRequestContext } from "~/lib/request-logger"
import {
  forwardNativeCopilotRequest,
  type NativeCopilotEndpoint,
  type NativeCopilotRequest,
} from "~/services/copilot/native-passthrough"

const ENDPOINTS: Record<
  NativeCopilotEndpoint,
  { capability: string; provider: string }
> = {
  "/v1/decisions": { capability: "the Decisions API", provider: "Decisions" },
  "/v1/images/edits": { capability: "image editing", provider: "Images" },
  "/v1/images/generations": {
    capability: "image generation",
    provider: "Images",
  },
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/** Routing needs a model; the remaining fields are the upstream's to judge. */
export function readJsonRequestModel(value: unknown): string {
  if (!isRecord(value))
    throw createInvalidRequestError(
      "The request body must be a JSON object.",
      "body",
    )
  if (!isNonBlankString(value.model))
    throw createInvalidRequestError("model is required", "model")
  return value.model
}

function advertises(model: Model, endpoint: NativeCopilotEndpoint): boolean {
  return model.supported_endpoints?.includes(endpoint) === true
}

function createUnsupportedModelError(
  endpoint: NativeCopilotEndpoint,
): LocalHTTPError {
  const clientBody = {
    error: {
      code: "model_not_supported",
      message: `The selected model does not support ${ENDPOINTS[endpoint].capability}.`,
      param: "model",
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

/** Routes one native Copilot call and relays the upstream body unchanged. */
export async function dispatchNativeCopilotRequest(
  c: Context,
  {
    requestedModel,
    ...request
  }: Omit<NativeCopilotRequest, "signal"> & { requestedModel?: string },
): Promise<Response> {
  setRequestContext(c, {
    requestedModel: requestedModel ?? request.model,
    provider: ENDPOINTS[request.endpoint].provider,
    model: request.model,
  })

  // A model missing from every live catalog still reaches Copilot, which
  // remains authoritative; a cataloged model must advertise the endpoint.
  const routedModel = await selectRoutedModel(request.model)
  if (routedModel.model && !advertises(routedModel.model, request.endpoint))
    throw createUnsupportedModelError(request.endpoint)

  const result = await runWithRoutedModelSelection(
    routedModel,
    async () =>
      await forwardNativeCopilotRequest({
        ...request,
        signal: c.req.raw.signal,
      }),
  )
  setRequestContext(c, {
    accountId: getLastUsedAccountId(),
    ...(result.usage ?
      {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      }
    : {}),
  })
  return c.body(result.body, 200, { "content-type": result.contentType })
}
