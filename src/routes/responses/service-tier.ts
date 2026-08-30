import type { Context } from "hono"

import type { CustomProviderModelReference } from "~/lib/custom-providers"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { resolveCustomProviderModel } from "~/lib/custom-providers"
import { recordNonDefaultBehavior } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"

function hasAvailableCopilotModel(model: string): boolean {
  const availability = tokenPool.hasEnabledAccountForKnownModel(model)
  if (state.isMultiToken) return availability === true
  return state.models?.data.some((candidate) => candidate.id === model) ?? false
}

function resolveAvailableCustomChatModel(
  model: string,
): CustomProviderModelReference | undefined {
  return resolveCustomProviderModel({ model, kind: "chat" })
}

export interface ResponsesServiceTierRoutingResult {
  customReference?: CustomProviderModelReference
  redirected: boolean
}

export interface ResponsesServiceTierRoutingOptions {
  allowCustomProvider?: boolean
  customReference?: CustomProviderModelReference
}

export function applyResponsesServiceTierRouting(
  c: Context | undefined,
  payload: ResponsesPayload,
  options: ResponsesServiceTierRoutingOptions = {},
): ResponsesServiceTierRoutingResult {
  const serviceTier = payload.service_tier
  if (serviceTier === undefined) return { redirected: false }

  delete payload.service_tier
  if (c) {
    recordNonDefaultBehavior(c, {
      kind: "request_field_stripped",
      message: `Removed unsupported service_tier before forwarding ${payload.model}`,
      data: {
        model: payload.model,
        field: "service_tier",
      },
    })
  }

  if (serviceTier !== "priority" || payload.model.endsWith("-fast")) {
    return { redirected: false }
  }

  const customCandidateBase =
    options.customReference?.matchedAlias === true ?
      options.customReference.upstreamModel
    : undefined
  const candidateBase = customCandidateBase ?? payload.model
  const candidate = `${candidateBase}-fast`
  const copilotAvailable = hasAvailableCopilotModel(candidate)
  const customReference =
    !copilotAvailable && options.allowCustomProvider !== false ?
      resolveAvailableCustomChatModel(candidate)
    : undefined
  if (!copilotAvailable && !customReference) return { redirected: false }

  if (c) {
    recordNonDefaultBehavior(c, {
      kind: "model_variant_routing",
      message: `service_tier=priority routed ${payload.model} to ${candidate}`,
      data: {
        sourceModel: payload.model,
        targetModel: candidate,
        reason: "service_tier=priority",
      },
    })
  }
  payload.model = candidate
  return { customReference, redirected: true }
}
