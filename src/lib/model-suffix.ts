import type { Model } from "~/services/copilot/get-models"

import { getModelSettings } from "~/lib/model-settings"
import { state } from "~/lib/state"

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

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
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
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

  const effort = parseReasoningEffort(potentialEffort)
  if (!effort) {
    return { baseModel: model }
  }

  return {
    baseModel: potentialBase,
    reasoningEffort: normalizeReasoningEffortForModel(potentialBase, effort),
  }
}

export function parseReasoningEffort(
  value: unknown,
): ReasoningEffort | undefined {
  return typeof value === "string" && Object.hasOwn(EFFORT_ALIASES, value) ?
      EFFORT_ALIASES[value]
    : undefined
}

/**
 * Get the reasoning config for a model, if it supports reasoning effort.
 */
export function getModelReasoningConfig(
  model: string,
): ModelReasoningConfig | undefined {
  const defaults = DEFAULT_MODEL_REASONING_CONFIG[model]
  const settings = getModelSettings(model)
  const upstream = getUpstreamReasoningConfig(model)

  if (!defaults && !settings && !upstream) return undefined

  return buildModelReasoningConfig(defaults, settings, upstream)
}

function buildModelReasoningConfig(
  defaults: ModelReasoningConfig | undefined,
  settings: ReturnType<typeof getModelSettings>,
  upstream: Pick<ModelReasoningConfig, "supportedEfforts"> | undefined,
): ModelReasoningConfig | undefined {
  const supportedEfforts = resolveSupportedEfforts(defaults, settings, upstream)
  const configuredDefaultEffort = resolveDefaultEffort(
    supportedEfforts,
    defaults,
    settings,
  )

  if (!supportedEfforts || !configuredDefaultEffort) return undefined

  const defaultEffort =
    coerceEffortToSupported(configuredDefaultEffort, supportedEfforts)
    ?? supportedEfforts[0]

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

function getUpstreamReasoningConfig(
  model: string,
): Pick<ModelReasoningConfig, "supportedEfforts"> | undefined {
  const supportedEfforts = state.models?.data
    .find((entry) => entry.id === model)
    ?.capabilities.supports.reasoning_effort?.flatMap((effort) => {
      const parsed = parseReasoningEffort(effort)
      return parsed ? [parsed] : []
    })

  if (!supportedEfforts || supportedEfforts.length === 0) return undefined

  return { supportedEfforts: [...new Set(supportedEfforts)] }
}

function coerceEffortToSupported(
  effort: ReasoningEffort,
  supportedEfforts: Array<ReasoningEffort>,
): ReasoningEffort | undefined {
  if (supportedEfforts.includes(effort)) return effort

  if (effort === "max" && supportedEfforts.includes("xhigh")) return "xhigh"
  if (effort === "xhigh" && supportedEfforts.includes("max")) return "max"

  return undefined
}

function resolveSupportedEfforts(
  defaults: ModelReasoningConfig | undefined,
  settings: ReturnType<typeof getModelSettings>,
  upstream: Pick<ModelReasoningConfig, "supportedEfforts"> | undefined,
): Array<ReasoningEffort> | undefined {
  const supportedEfforts =
    settings?.supportedReasoningEfforts
    ?? upstream?.supportedEfforts
    ?? defaults?.supportedEfforts
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
  if (!config) return effort === "max" ? "xhigh" : effort

  return (
    coerceEffortToSupported(effort, config.supportedEfforts)
    ?? config.defaultEffort
  )
}

export function usesImplicitReasoningDefault(model: string): boolean {
  return getModelReasoningConfig(model)?.implicitReasoningDefault === true
}

interface VirtualModel {
  capabilities: Model["capabilities"]
  id: string
  object: string
  type: string
  created: number
  created_at: string
  owned_by: string
  display_name: string
  name: string
  vendor: string
  version: string
  preview: boolean
  policy?: Model["policy"]
  billing?: Model["billing"]
  custom_model?: Model["custom_model"]
  issues?: Model["issues"]
  model_picker_category?: Model["model_picker_category"]
  model_picker_price_category?: Model["model_picker_price_category"]
  supported_endpoints?: Array<string>
  warning_messages?: Model["warning_messages"]
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
      const displayName = `${model.name} (${effort} thinking)`
      virtualModels.push({
        id: `${model.id}:${effort}`,
        object: "model",
        type: "model",
        created: 0,
        created_at: new Date(0).toISOString(),
        owned_by: model.vendor,
        display_name: displayName,
        name: displayName,
        vendor: model.vendor,
        version: model.version,
        preview: model.preview,
        capabilities: model.capabilities,
        ...(model.policy ? { policy: model.policy } : {}),
        ...(model.billing ? { billing: model.billing } : {}),
        ...(model.model_picker_category ?
          { model_picker_category: model.model_picker_category }
        : {}),
        ...(model.model_picker_price_category ?
          { model_picker_price_category: model.model_picker_price_category }
        : {}),
        ...(model.custom_model !== undefined ?
          { custom_model: model.custom_model }
        : {}),
        ...(model.issues ? { issues: model.issues } : {}),
        ...(model.warning_messages ?
          { warning_messages: model.warning_messages }
        : {}),
        supported_endpoints: model.supported_endpoints,
      })
    }
  }

  return virtualModels
}
