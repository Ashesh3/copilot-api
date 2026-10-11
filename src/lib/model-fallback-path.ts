import type { ModelFallbackConfig } from "~/lib/model-fallback-config"
import type {
  ModelRedirectRequest,
  ModelRedirectResult,
  ModelRedirectRule,
} from "~/lib/model-redirect"
import type { ConversationModelRoute } from "~/lib/storage/conversation-models-repository"
import type { Model } from "~/services/copilot/get-models"

import { resolveCustomProviderModel } from "~/lib/custom-providers"
import { getModelFallbackIdentity } from "~/lib/model-fallback-identity"
import { resolveModelRedirectRules } from "~/lib/model-redirect-resolver"
import { normalizeReasoningEffortForModel } from "~/lib/model-suffix"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"

function canGenerate(model: Model | undefined): boolean {
  return (
    model?.kind !== "embedding"
    && model?.capabilities.type !== "embedding"
    && model?.capabilities.type !== "embeddings"
  )
}

/** Availability only: never reserves or changes a conversation's account. */
export function hasAvailableFallbackModel(model: string): boolean {
  const catalog = state.models?.data ?? []
  if (
    resolveCustomProviderModel({
      model,
      kind: "chat",
      copilotModelIds: new Set(catalog.map((entry) => entry.id)),
    })
  )
    return true
  if (state.isMultiToken || tokenPool.size > 0)
    return tokenPool
      .getEligibleAccountsForModel(model)
      .some((account) =>
        canGenerate(tokenPool.getModelForAccount(model, account.id)),
      )
  return catalog.some((entry) => entry.id === model && canGenerate(entry))
}

export interface AvailableModelFallback {
  redirect: ModelRedirectResult
  route: Array<ConversationModelRoute>
}

export function fallbackRoutingRequest(
  redirect: ModelRedirectResult,
  modelOnly?: boolean,
): ModelRedirectRequest {
  return {
    model: redirect.model,
    effort: normalizeReasoningEffortForModel(redirect.model, redirect.effort),
    verbosity: redirect.verbosity,
    modelOnly,
  }
}

/**
 * Follow configured edges without dispatching providerless models. Keep every
 * edge so a successful route can be validated against its rules on later turns.
 * Probing the path must not consume the attempt's cycle-detection state.
 */
export function resolveAvailableModelFallback(options: {
  config: ModelFallbackConfig
  redirects: ReadonlyArray<ModelRedirectRule>
  request: ModelRedirectRequest
  visitedModels: ReadonlySet<string>
  reason: ConversationModelRoute["reason"]
}): AvailableModelFallback | undefined {
  let request = options.request
  let reason = options.reason
  const visited = new Set(options.visitedModels)
  visited.add(getModelFallbackIdentity(request.model))
  const route: Array<ConversationModelRoute> = []
  while (true) {
    const rule = options.config.rules.find(
      (entry) => entry.enabled && entry.sourceModel === request.model,
    )
    if (!rule) return undefined
    const redirect = resolveModelRedirectRules(options.redirects, {
      ...request,
      model: rule.targetModel,
    })
    const identity = getModelFallbackIdentity(redirect.model)
    if (redirect.loop || visited.has(identity)) return undefined
    visited.add(identity)
    route.push({
      source: request.model,
      target: rule.targetModel,
      resolved: redirect.model,
      reason,
    })
    if (hasAvailableFallbackModel(redirect.model)) return { redirect, route }
    request = fallbackRoutingRequest(redirect, request.modelOnly)
    reason = "unavailable"
  }
}
