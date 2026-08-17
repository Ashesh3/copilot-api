import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { getCustomProviderModels } from "~/lib/custom-providers"
import { forwardError } from "~/lib/error"
import { modelHasOneMillionContext } from "~/lib/model-capabilities"
import { applyModelRedirect, getAllModelRedirects } from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  type ReasoningEffort,
  generateVirtualModels,
  getModelReasoningConfig,
} from "~/lib/model-suffix"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

function isModelVisible(model: Model): boolean {
  return (
    model.model_picker_enabled === true || model.policy?.state === "enabled"
  )
}

function getCopilotModelIds(models: Array<{ id: string }>): Set<string> {
  return new Set(models.map((model) => model.id))
}

export interface ModelDiscoveryListing extends Record<string, unknown> {
  id: string
  alias?: boolean
  aliases?: Array<string>
  billing?: Model["billing"]
  capabilities?: Model["capabilities"]
  canonical_id?: string
  created: number
  created_at: string
  dimensions?: number
  display_name?: string
  issues?: Model["issues"]
  kind?: string
  model_picker_category?: Model["model_picker_category"]
  model_picker_price_category?: Model["model_picker_price_category"]
  name?: string
  object: string
  owned_by: string
  policy?: Model["policy"]
  preview?: Model["preview"]
  provider?: string
  provider_id?: string
  supports_streaming?: boolean
  supported_endpoints?: Array<string>
  supports_1m_context?: boolean
  thinking?: ModelDiscoveryThinking
  type: string
  vendor?: Model["vendor"]
  version?: Model["version"]
  warning_messages?: Model["warning_messages"]
}

interface ModelDiscoveryThinking {
  effort_options?: Array<ModelDiscoveryThinkingOption>
}

interface ModelDiscoveryThinkingOption {
  id: ReasoningEffort
  name: string
  recommended?: boolean
}

function supportedEndpointsForClient(model: {
  supported_endpoints?: Array<string>
}): Array<string> | undefined {
  const endpoints = model.supported_endpoints
  if (!endpoints) return undefined
  if (!endpoints.includes("/responses")) return [...endpoints]
  return [...new Set([...endpoints, "ws:/responses"])]
}

function toThinkingOption(
  effort: ReasoningEffort,
  defaultEffort: ReasoningEffort | undefined,
): ModelDiscoveryThinkingOption {
  return {
    id: effort,
    name: effort,
    ...(effort === defaultEffort ? { recommended: true } : {}),
  }
}

function toDiscoveryThinking(model: Model): ModelDiscoveryThinking | undefined {
  const config = getModelReasoningConfig(model.id)
  if (!config) return undefined

  const uniqueEfforts = [...new Set(config.supportedEfforts)]
  return {
    effort_options: uniqueEfforts.map((effort) =>
      toThinkingOption(effort, config.defaultEffort),
    ),
  }
}

function toCopilotModelListing(model: Model): ModelDiscoveryListing {
  const supportedEndpoints = supportedEndpointsForClient(model)
  const thinking = toDiscoveryThinking(model)
  return {
    ...structuredClone(model),
    id: model.id,
    object: "model",
    type: "model",
    created: 0, // No date available from source
    created_at: new Date(0).toISOString(), // No date available from source
    owned_by: model.vendor ?? "unknown",
    display_name: model.name,
    ...(supportedEndpoints ? { supported_endpoints: supportedEndpoints } : {}),
    ...(modelHasOneMillionContext(model) ? { supports_1m_context: true } : {}),
    ...(thinking ? { thinking } : {}),
  }
}

function modelIdWithEffort(
  model: string,
  effort: ReasoningEffort | undefined,
): string {
  return effort ? `${model}:${effort}` : model
}

function cloneAliasedListing(
  source: ModelDiscoveryListing,
  options: { canonicalId: string; id: string },
): ModelDiscoveryListing {
  return {
    ...source,
    id: options.id,
    alias: true,
    canonical_id: options.canonicalId,
  }
}

function addUniqueListings(
  target: Array<ModelDiscoveryListing>,
  ids: Set<string>,
  listings: Array<ModelDiscoveryListing>,
): void {
  for (const listing of listings) {
    if (ids.has(listing.id)) continue
    ids.add(listing.id)
    target.push(listing)
  }
}

function toListingById(
  listings: Array<ModelDiscoveryListing>,
): Map<string, ModelDiscoveryListing> {
  return new Map(listings.map((model) => [model.id, model]))
}

function toVirtualModelListings(
  models: Array<Model>,
): Array<ModelDiscoveryListing> {
  const modelsById = new Map(models.map((model) => [model.id, model]))
  return generateVirtualModels(models).map((virtualModel) => {
    const separator = virtualModel.id.lastIndexOf(":")
    const sourceModel = modelsById.get(virtualModel.id.slice(0, separator))
    const supportedEndpoints = supportedEndpointsForClient(virtualModel)
    return structuredClone({
      ...sourceModel,
      ...virtualModel,
      ...(supportedEndpoints ?
        { supported_endpoints: supportedEndpoints }
      : {}),
    })
  })
}

async function getRedirectSourceListing(options: {
  sourceModel: string
  sourceEffort?: ReasoningEffort
  listingsById: Map<string, ModelDiscoveryListing>
}): Promise<ModelDiscoveryListing | undefined> {
  const redirect = await applyModelRedirect({
    model: options.sourceModel,
    effort: options.sourceEffort,
  })
  if (!redirect.redirected) return undefined

  const targetWithEffort = modelIdWithEffort(redirect.model, redirect.effort)
  const targetListing =
    options.listingsById.get(targetWithEffort)
    ?? options.listingsById.get(redirect.model)
  if (!targetListing) return undefined

  const sourceId = modelIdWithEffort(options.sourceModel, options.sourceEffort)
  return cloneAliasedListing(targetListing, {
    id: sourceId,
    canonicalId: targetListing.id,
  })
}

async function getRedirectSourceModels(
  listingsById: Map<string, ModelDiscoveryListing>,
): Promise<Array<ModelDiscoveryListing>> {
  const redirectRules = await getAllModelRedirects()
  const models: Array<ModelDiscoveryListing> = []

  for (const rule of redirectRules) {
    if (!rule.enabled) continue

    const sourceEfforts =
      rule.sourceEffort === "all" || rule.sourceEffort === "default" ?
        [undefined]
      : [rule.sourceEffort]

    for (const sourceEffort of sourceEfforts) {
      const listing = await getRedirectSourceListing({
        sourceModel: rule.sourceModel,
        sourceEffort,
        listingsById,
      })
      if (listing) models.push(listing)
    }
  }

  return models
}

function getClaudeDashAliasId(id: string): string | undefined {
  const [baseModel, effort] = id.split(":", 2)
  if (!baseModel.startsWith("claude-")) return undefined

  const dashed = baseModel.replaceAll(
    /(?<!\d)(\d)\.(\d)(?!\d)/g,
    (_, major: string, minor: string) => `${major}-${minor}`,
  )
  if (dashed === baseModel || normalizeModelName(dashed) !== baseModel) {
    return undefined
  }

  return effort ? `${dashed}:${effort}` : dashed
}

function getClaudeDashAliasModels(
  listings: Array<ModelDiscoveryListing>,
): Array<ModelDiscoveryListing> {
  return listings.flatMap((model) => {
    const aliasId = getClaudeDashAliasId(model.id)
    return aliasId ?
        [cloneAliasedListing(model, { id: aliasId, canonicalId: model.id })]
      : []
  })
}

function canRequestOneMillionContextAlias(
  model: ModelDiscoveryListing,
  listingsById: Map<string, ModelDiscoveryListing>,
): boolean {
  const normalizedAliasTarget = normalizeModelName(`${model.id}[1m]`)
  return (
    normalizedAliasTarget === model.id
    || normalizedAliasTarget === model.canonical_id
    || listingsById.has(normalizedAliasTarget)
  )
}

function getOneMillionContextAliasModels(
  listings: Array<ModelDiscoveryListing>,
  listingsById: Map<string, ModelDiscoveryListing>,
): Array<ModelDiscoveryListing> {
  return listings.flatMap((model) => {
    if (!model.supports_1m_context) return []
    if (model.id.includes(":") || model.id.endsWith("[1m]")) return []
    if (!canRequestOneMillionContextAlias(model, listingsById)) return []

    const displayName = `${model.name ?? model.display_name ?? model.id} (1M context)`
    const oneMillionContextModel: ModelDiscoveryListing = {
      ...model,
      id: `${model.id}[1m]`,
      canonical_id: model.id,
      name: displayName,
      display_name: displayName,
    }
    delete oneMillionContextModel.alias
    delete oneMillionContextModel.supports_1m_context
    return [oneMillionContextModel]
  })
}

export async function buildModelDiscoveryListings(): Promise<
  Array<ModelDiscoveryListing>
> {
  if (!state.models) {
    // This should be handled by startup logic, but as a fallback.
    await cacheModels()
  }

  const visibleModels =
    state.models?.data.filter((model) => isModelVisible(model)) ?? []

  const allModels = state.models?.data ?? []
  const allCopilotModels = allModels.map((model) =>
    toCopilotModelListing(model),
  )
  const allVirtualModels = toVirtualModelListings(allModels)

  // Copilot models
  const copilotModels = visibleModels.map((model) =>
    toCopilotModelListing(model),
  )

  // Virtual models for reasoning effort variants (e.g. "claude-sonnet-4.6:high")
  const virtualModels = toVirtualModelListings(visibleModels)

  const discoveryModels: Array<ModelDiscoveryListing> = [
    ...copilotModels,
    ...virtualModels,
  ]
  const copilotModelIds = getCopilotModelIds(discoveryModels)
  const customProviderModelCandidates: Array<ModelDiscoveryListing> =
    getCustomProviderModels().map((model) => ({ ...model }))
  const listingsById = toListingById([
    ...allCopilotModels,
    ...allVirtualModels,
    ...customProviderModelCandidates,
  ])

  addUniqueListings(
    discoveryModels,
    copilotModelIds,
    await getRedirectSourceModels(listingsById),
  )
  addUniqueListings(
    discoveryModels,
    copilotModelIds,
    getClaudeDashAliasModels(discoveryModels),
  )
  addUniqueListings(
    discoveryModels,
    copilotModelIds,
    getOneMillionContextAliasModels(discoveryModels, listingsById),
  )

  const customModels = customProviderModelCandidates.filter(
    (model) => model.alias || !copilotModelIds.has(model.id),
  )

  return [...discoveryModels, ...customModels]
}

modelRoutes.get("/", async (c) => {
  try {
    return c.json({
      object: "list",
      data: await buildModelDiscoveryListings(),
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

modelRoutes.get("/:model", async (c) => {
  const model = (await buildModelDiscoveryListings()).find(
    (entry) => entry.id === c.req.param("model"),
  )
  if (!model) {
    return c.json(
      { error: { message: "Model not found", type: "not_found_error" } },
      404,
    )
  }
  return c.json(model)
})
