import type { Model } from "~/services/copilot/get-models"

import { getModelSettings } from "~/lib/model-settings"

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh"

interface ModelReasoningConfig {
  supportedEfforts: Array<ReasoningEffort>
  defaultEffort: ReasoningEffort
  implicitReasoningDefault?: boolean
  exposeVirtualReasoningModels?: boolean
}

/**
 * Default reasoning config per public model, derived from Copilot CLI v0.0.414.
 * Models not in this map do not support per-request reasoning effort control.
 */
const DEFAULT_MODEL_REASONING_CONFIG: Partial<
  Record<string, ModelReasoningConfig>
> = {
  "claude-sonnet-4.6": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  "claude-opus-4.6": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  "claude-opus-4.6-fast": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  "claude-opus-4.6-1m": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  "gpt-5.3-codex": {
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  "gpt-5.2-codex": {
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
  },
  "gpt-5.2": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  "gpt-5.1-codex": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  "gpt-5.1-codex-max": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  "gpt-5.1": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  "gpt-5.1-codex-mini": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  "gpt-5-mini": {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
}

const EFFORT_ALIASES: Record<string, ReasoningEffort> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
}

export interface ParsedModel {
  baseModel: string
  reasoningEffort?: ReasoningEffort
}

/**
 * Parse a model string that may contain a reasoning effort suffix.
 * Format: "model-name:effort" (e.g. "claude-sonnet-4.6:high")
 *
 * If the suffix is not a valid effort level, the suffix is ignored and the
 * full string is treated as the model name. For models not present in the
 * local reasoning config, keep the parsed effort so redirect rules can still
 * route newly released model IDs before account routing sees them.
 */
export function parseModelSuffix(model: string): ParsedModel {
  const colonIndex = model.lastIndexOf(":")
  if (colonIndex === -1) {
    return { baseModel: model }
  }

  const potentialBase = model.slice(0, colonIndex)
  const potentialEffort = model.slice(colonIndex + 1)

  if (!Object.hasOwn(EFFORT_ALIASES, potentialEffort)) {
    return { baseModel: model }
  }
  const effort = EFFORT_ALIASES[potentialEffort]

  return {
    baseModel: potentialBase,
    reasoningEffort: normalizeReasoningEffortForModel(potentialBase, effort),
  }
}

/**
 * Get the reasoning config for a model, if it supports reasoning effort.
 */
export function getModelReasoningConfig(
  model: string,
): ModelReasoningConfig | undefined {
  const defaults = DEFAULT_MODEL_REASONING_CONFIG[model]
  const settings = getModelSettings(model)

  if (!defaults && !settings) return undefined

  return buildModelReasoningConfig(defaults, settings)
}

function buildModelReasoningConfig(
  defaults: ModelReasoningConfig | undefined,
  settings: ReturnType<typeof getModelSettings>,
): ModelReasoningConfig | undefined {
  const supportedEfforts = resolveSupportedEfforts(defaults, settings)
  const configuredDefaultEffort = resolveDefaultEffort(
    supportedEfforts,
    defaults,
    settings,
  )

  if (!supportedEfforts || !configuredDefaultEffort) return undefined

  const defaultEffort =
    supportedEfforts.includes(configuredDefaultEffort) ?
      configuredDefaultEffort
    : supportedEfforts[0]

  return {
    supportedEfforts,
    defaultEffort,
    implicitReasoningDefault:
      settings?.implicitReasoningDefault ?? defaults?.implicitReasoningDefault,
    exposeVirtualReasoningModels:
      settings?.exposeVirtualReasoningModels
      ?? defaults?.exposeVirtualReasoningModels,
  }
}

function resolveSupportedEfforts(
  defaults: ModelReasoningConfig | undefined,
  settings: ReturnType<typeof getModelSettings>,
): Array<ReasoningEffort> | undefined {
  const supportedEfforts =
    settings?.supportedReasoningEfforts ?? defaults?.supportedEfforts
  return supportedEfforts && supportedEfforts.length > 0 ?
      supportedEfforts
    : undefined
}

function resolveDefaultEffort(
  supportedEfforts: Array<ReasoningEffort> | undefined,
  defaults: ModelReasoningConfig | undefined,
  settings: ReturnType<typeof getModelSettings>,
): ReasoningEffort | undefined {
  return (
    settings?.defaultReasoningEffort
    ?? defaults?.defaultEffort
    ?? supportedEfforts?.[0]
  )
}

export function normalizeReasoningEffortForModel(
  model: string,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!effort) return undefined

  const config = getModelReasoningConfig(model)
  if (!config) return effort

  return config.supportedEfforts.includes(effort) ?
      effort
    : config.defaultEffort
}

export function usesImplicitReasoningDefault(model: string): boolean {
  return getModelReasoningConfig(model)?.implicitReasoningDefault === true
}

interface VirtualModel {
  id: string
  object: string
  type: string
  created: number
  created_at: string
  owned_by: string
  display_name: string
  supported_endpoints?: Array<string>
}

/**
 * Generate virtual model entries for models that support reasoning effort.
 * Each supported effort level gets its own virtual model entry.
 */
export function generateVirtualModels(
  models: Array<Model>,
): Array<VirtualModel> {
  const virtualModels: Array<VirtualModel> = []

  for (const model of models) {
    const config = getModelReasoningConfig(model.id)
    if (!config) continue
    if (
      config.implicitReasoningDefault
      && config.exposeVirtualReasoningModels !== true
    ) {
      continue
    }

    for (const effort of config.supportedEfforts) {
      virtualModels.push({
        id: `${model.id}:${effort}`,
        object: "model",
        type: "model",
        created: 0,
        created_at: new Date(0).toISOString(),
        owned_by: model.vendor,
        display_name: `${model.name} (${effort} thinking)`,
        supported_endpoints: model.supported_endpoints,
      })
    }
  }

  return virtualModels
}
