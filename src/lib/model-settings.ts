import type { ReasoningEffort } from "~/lib/model-suffix"

import {
  getLoadedSetting,
  readSetting,
  updateSetting,
} from "~/lib/storage/domain-settings"
import { StorageSchemaError } from "~/lib/storage/errors"
import { normalizeSettingsJson } from "~/lib/storage/settings-repository"

export interface ModelSettings {
  model: string
  sentryModelName?: string
  supportedReasoningEfforts?: Array<ReasoningEffort>
  defaultReasoningEffort?: ReasoningEffort
  implicitReasoningDefault?: boolean
  exposeVirtualReasoningModels?: boolean
  supportsAssistantPrefill?: boolean
  unsupportedRequestParameters?: Array<ModelRequestParameter>
  /** Sent as the first system message of every request for this model. */
  forcedSystemPrompt?: string
  /** Remove the client's own system and developer prompts. */
  clearOtherSystemPrompts?: boolean
}

export interface ModelSettingsUpdate {
  sentryModelName?: string | null
  supportedReasoningEfforts?: Array<ReasoningEffort | "max"> | null
  defaultReasoningEffort?: ReasoningEffort | "max" | null
  implicitReasoningDefault?: boolean | null
  exposeVirtualReasoningModels?: boolean | null
  supportsAssistantPrefill?: boolean | null
  unsupportedRequestParameters?: Array<ModelRequestParameter> | null
  forcedSystemPrompt?: string | null
  clearOtherSystemPrompts?: boolean | null
}

export type ModelRequestParameter = "temperature" | "top_p"

export const MAX_FORCED_SYSTEM_PROMPT_LENGTH = 200_000

type BooleanModelSetting =
  | "implicitReasoningDefault"
  | "exposeVirtualReasoningModels"
  | "supportsAssistantPrefill"

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
const REQUEST_PARAMETERS = new Set<ModelRequestParameter>([
  "temperature",
  "top_p",
])
const DEFAULT_UNSUPPORTED_REQUEST_PARAMETERS: Record<
  string,
  Array<ModelRequestParameter>
> = {
  "gpt-5.4-mini": ["temperature", "top_p"],
  "gpt-5.5": ["temperature", "top_p"],
}
const NO_ASSISTANT_PREFILL_CLAUDE_FAMILIES = new Set([
  "opus",
  "sonnet",
  "haiku",
  "fable",
])
const DELETE_BOOLEAN_MODEL_SETTING: Record<
  BooleanModelSetting,
  (settings: ModelSettings) => void
> = {
  implicitReasoningDefault: (settings) => {
    delete settings.implicitReasoningDefault
  },
  exposeVirtualReasoningModels: (settings) => {
    delete settings.exposeVirtualReasoningModels
  },
  supportsAssistantPrefill: (settings) => {
    delete settings.supportsAssistantPrefill
  },
}

let testSettings: Record<string, ModelSettings> | undefined
// Snapshot documents are frozen, so a validated copy stays valid until the
// setting is written again and a new document replaces it.
const validatedSettingsByDocument = new WeakMap<
  object,
  Record<string, ModelSettings>
>()

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.has(value as ReasoningEffort)
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return isReasoningEffort(value) ? value : undefined
}

function normalizeSupportedReasoningEfforts(
  value: unknown,
): Array<ReasoningEffort> | undefined {
  if (!Array.isArray(value)) return undefined

  const efforts = value.flatMap((item) => {
    const effort = normalizeReasoningEffort(item)
    return effort ? [effort] : []
  })

  return [...new Set(efforts)]
}

function isModelRequestParameter(
  value: unknown,
): value is ModelRequestParameter {
  return REQUEST_PARAMETERS.has(value as ModelRequestParameter)
}

function normalizeUnsupportedRequestParameters(
  value: unknown,
): Array<ModelRequestParameter> | undefined {
  if (!Array.isArray(value)) return undefined

  const parameters = value.flatMap((item) =>
    isModelRequestParameter(item) ? [item] : [],
  )

  return [...new Set(parameters)]
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function normalizeForcedSystemPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const prompt = value.trim()
  return prompt.length > 0 ? prompt : undefined
}

/** Clearing other prompts is only meaningful while a forced prompt is set. */
function applyForcedSystemPromptFields(
  settings: ModelSettings,
  prompt: unknown,
  clearOtherSystemPrompts: unknown,
): void {
  const forcedSystemPrompt = normalizeForcedSystemPrompt(prompt)
  if (!forcedSystemPrompt) {
    delete settings.forcedSystemPrompt
    delete settings.clearOtherSystemPrompts
    return
  }
  settings.forcedSystemPrompt = forcedSystemPrompt
  if (clearOtherSystemPrompts === true) {
    settings.clearOtherSystemPrompts = true
  } else {
    delete settings.clearOtherSystemPrompts
  }
}

function applyNormalizedBoolean(
  settings: ModelSettings,
  key: BooleanModelSetting,
  value: boolean | undefined,
): void {
  if (value !== undefined) {
    settings[key] = value
  }
}

function normalizeModelSettings(raw: unknown): ModelSettings | undefined {
  if (!isSettingsRecord(raw)) return undefined

  const value = raw
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    return undefined
  }

  const supportedReasoningEfforts = normalizeSupportedReasoningEfforts(
    value.supportedReasoningEfforts,
  )
  const sentryModelName =
    typeof value.sentryModelName === "string" ?
      value.sentryModelName.trim()
    : undefined
  const defaultReasoningEffort = normalizeReasoningEffort(
    value.defaultReasoningEffort,
  )
  const implicitReasoningDefault = normalizeOptionalBoolean(
    value.implicitReasoningDefault,
  )
  const exposeVirtualReasoningModels = normalizeOptionalBoolean(
    value.exposeVirtualReasoningModels,
  )
  const supportsAssistantPrefill = normalizeOptionalBoolean(
    value.supportsAssistantPrefill,
  )
  const unsupportedRequestParameters = normalizeUnsupportedRequestParameters(
    value.unsupportedRequestParameters,
  )

  const normalized: ModelSettings = { model: value.model.trim() }

  if (sentryModelName) {
    normalized.sentryModelName = sentryModelName
  }
  if (supportedReasoningEfforts && supportedReasoningEfforts.length > 0) {
    normalized.supportedReasoningEfforts = supportedReasoningEfforts
  }
  if (defaultReasoningEffort) {
    normalized.defaultReasoningEffort = defaultReasoningEffort
  }
  applyNormalizedBoolean(
    normalized,
    "implicitReasoningDefault",
    implicitReasoningDefault,
  )
  applyNormalizedBoolean(
    normalized,
    "exposeVirtualReasoningModels",
    exposeVirtualReasoningModels,
  )
  applyNormalizedBoolean(
    normalized,
    "supportsAssistantPrefill",
    supportsAssistantPrefill,
  )
  if (unsupportedRequestParameters && unsupportedRequestParameters.length > 0) {
    normalized.unsupportedRequestParameters = unsupportedRequestParameters
  }
  applyForcedSystemPromptFields(
    normalized,
    value.forcedSystemPrompt,
    value.clearOtherSystemPrompts,
  )

  return hasCustomModelSettings(normalized) ? normalized : undefined
}

function normalizeSettings(raw: unknown): Record<string, ModelSettings> {
  const items = getSettingsItems(raw)
  const normalized: Record<string, ModelSettings> = {}

  for (const item of items) {
    const settings = normalizeModelSettings(item)
    if (settings) normalized[settings.model] = settings
  }

  return normalized
}

function getSettingsItems(raw: unknown): Array<unknown> {
  if (Array.isArray(raw)) return raw
  if (!isSettingsRecord(raw)) return []

  return Object.entries(raw).map(([model, value]) => {
    if (!isSettingsRecord(value)) return value
    return { model, ...value }
  })
}

function hasCustomModelSettings(settings: ModelSettings): boolean {
  return (
    settings.sentryModelName !== undefined
    || settings.supportedReasoningEfforts !== undefined
    || settings.defaultReasoningEffort !== undefined
    || settings.implicitReasoningDefault !== undefined
    || settings.exposeVirtualReasoningModels !== undefined
    || settings.supportsAssistantPrefill !== undefined
    || settings.unsupportedRequestParameters !== undefined
    || settings.forcedSystemPrompt !== undefined
  )
}

function validSettingArray(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every((entry) => predicate(entry))
}

function validateStoredModelSettingFields(item: Record<string, unknown>): void {
  const fields: Record<string, (value: unknown) => boolean> = {
    sentryModelName: (value) => typeof value === "string",
    defaultReasoningEffort: isReasoningEffort,
    supportedReasoningEfforts: (value) =>
      validSettingArray(value, isReasoningEffort),
    unsupportedRequestParameters: (value) =>
      validSettingArray(value, isModelRequestParameter),
    implicitReasoningDefault: (value) => typeof value === "boolean",
    exposeVirtualReasoningModels: (value) => typeof value === "boolean",
    supportsAssistantPrefill: (value) => typeof value === "boolean",
    forcedSystemPrompt: (value) => typeof value === "string",
    clearOtherSystemPrompts: (value) => typeof value === "boolean",
  }
  for (const [key, validate] of Object.entries(fields)) {
    if (Object.hasOwn(item, key) && !validate(item[key]))
      throw new StorageSchemaError("Invalid model setting field")
  }
}

export function validateStoredModelSettings(
  value: unknown,
): Record<string, ModelSettings> {
  if (value === undefined) return {}
  if (!Array.isArray(value) && !isSettingsRecord(value))
    throw new StorageSchemaError("Invalid model settings")
  for (const item of getSettingsItems(value)) {
    if (
      !isSettingsRecord(item)
      || typeof item.model !== "string"
      || !item.model.trim()
    )
      throw new StorageSchemaError("Invalid model setting entry")
    validateStoredModelSettingFields(item)
  }
  return normalizeSettings(value)
}

/** Validated settings for the loaded document. Callers must not mutate them. */
function loadedSettings(): Record<string, ModelSettings> {
  if (testSettings) return testSettings
  const document = getLoadedSetting("model_settings")
  if (typeof document !== "object" || document === null) {
    return validateStoredModelSettings(document)
  }
  const cached = validatedSettingsByDocument.get(document)
  if (cached) return cached
  const validated = validateStoredModelSettings(document)
  validatedSettingsByDocument.set(document, validated)
  return validated
}

function currentSettings(): Record<string, ModelSettings> {
  return structuredClone(loadedSettings())
}

async function mutateSettings<T>(
  update: (settings: Record<string, ModelSettings>) => T,
): Promise<T> {
  if (testSettings) {
    const next = structuredClone(testSettings)
    const result = update(next)
    testSettings = next
    return structuredClone(result)
  }
  let result: T | undefined
  await updateSetting("model_settings", (current) => {
    const next = validateStoredModelSettings(current)
    result = update(next)
    return normalizeSettingsJson(Object.values(next))
  })
  return structuredClone(result as T)
}

export async function loadModelSettings(): Promise<void> {
  validateStoredModelSettings(await readSetting("model_settings"))
  testSettings = undefined
}

export async function ensureModelSettingsLoaded(): Promise<void> {
  await Promise.resolve(currentSettings())
}

export function getModelSettings(model: string): ModelSettings | undefined {
  // Clone only the requested entry; a long forced prompt on another model
  // should not be copied on every lookup.
  const settings = loadedSettings()
  return Object.hasOwn(settings, model) ?
      structuredClone(settings[model])
    : undefined
}

export async function getAllModelSettings(): Promise<Array<ModelSettings>> {
  return await Promise.resolve(
    Object.values(currentSettings()).sort((a, b) =>
      a.model.localeCompare(b.model),
    ),
  )
}

export async function setModelSettings(
  model: string,
  updates: ModelSettingsUpdate,
): Promise<ModelSettings> {
  return mutateSettings((modelSettings) => {
    const trimmedModel = model.trim()
    const current: ModelSettings = modelSettings[trimmedModel] ?? {
      model: trimmedModel,
    }
    const next: ModelSettings = { ...current }

    if (updates.sentryModelName !== undefined) {
      const sentryModelName = updates.sentryModelName?.trim()
      if (sentryModelName) {
        next.sentryModelName = sentryModelName
      } else {
        delete next.sentryModelName
      }
    }

    if (updates.supportedReasoningEfforts !== undefined) {
      const supportedReasoningEfforts = normalizeSupportedReasoningEfforts(
        updates.supportedReasoningEfforts,
      )
      if (supportedReasoningEfforts && supportedReasoningEfforts.length > 0) {
        next.supportedReasoningEfforts = supportedReasoningEfforts
      } else {
        delete next.supportedReasoningEfforts
      }
    }

    if (updates.defaultReasoningEffort !== undefined) {
      const defaultReasoningEffort = normalizeReasoningEffort(
        updates.defaultReasoningEffort,
      )
      if (defaultReasoningEffort) {
        next.defaultReasoningEffort = defaultReasoningEffort
      } else {
        delete next.defaultReasoningEffort
      }
    }

    applyBooleanModelSettingUpdate(
      next,
      "implicitReasoningDefault",
      updates.implicitReasoningDefault,
    )
    applyBooleanModelSettingUpdate(
      next,
      "exposeVirtualReasoningModels",
      updates.exposeVirtualReasoningModels,
    )
    applyBooleanModelSettingUpdate(
      next,
      "supportsAssistantPrefill",
      updates.supportsAssistantPrefill,
    )

    applyUnsupportedRequestParametersUpdate(
      next,
      updates.unsupportedRequestParameters,
    )
    applyForcedSystemPromptUpdate(next, updates)

    if (!hasCustomModelSettings(next)) {
      Reflect.deleteProperty(modelSettings, trimmedModel)
      return { model: trimmedModel }
    }

    modelSettings[trimmedModel] = next
    return { ...next }
  })
}

export async function removeModelSettings(model: string): Promise<boolean> {
  return mutateSettings((modelSettings) => {
    if (!Object.hasOwn(modelSettings, model)) return false
    Reflect.deleteProperty(modelSettings, model)
    return true
  })
}

export function setModelSettingsForTest(settings: Array<unknown>): void {
  testSettings = normalizeSettings(settings)
}

function applyUnsupportedRequestParametersUpdate(
  settings: ModelSettings,
  value: ModelSettingsUpdate["unsupportedRequestParameters"] | undefined,
): void {
  if (value === undefined) return

  const unsupportedRequestParameters =
    normalizeUnsupportedRequestParameters(value)
  if (unsupportedRequestParameters && unsupportedRequestParameters.length > 0) {
    settings.unsupportedRequestParameters = unsupportedRequestParameters
  } else {
    delete settings.unsupportedRequestParameters
  }
}

function applyForcedSystemPromptUpdate(
  settings: ModelSettings,
  updates: ModelSettingsUpdate,
): void {
  if (
    updates.forcedSystemPrompt === undefined
    && updates.clearOtherSystemPrompts === undefined
  ) {
    return
  }
  applyForcedSystemPromptFields(
    settings,
    updates.forcedSystemPrompt === undefined ?
      settings.forcedSystemPrompt
    : updates.forcedSystemPrompt,
    updates.clearOtherSystemPrompts === undefined ?
      settings.clearOtherSystemPrompts
    : updates.clearOtherSystemPrompts,
  )
}

function applyBooleanModelSettingUpdate(
  settings: ModelSettings,
  key: BooleanModelSetting,
  value: boolean | null | undefined,
): void {
  if (value === undefined) return

  if (typeof value === "boolean") {
    settings[key] = value
  } else {
    DELETE_BOOLEAN_MODEL_SETTING[key](settings)
  }
}

export function getUnsupportedRequestParameters(
  model: string,
): Array<ModelRequestParameter> {
  return [
    ...new Set([
      ...(DEFAULT_UNSUPPORTED_REQUEST_PARAMETERS[model] ?? []),
      ...(getModelSettings(model)?.unsupportedRequestParameters ?? []),
    ]),
  ]
}

export function modelSupportsAssistantPrefill(model: string): boolean {
  const configured = getModelSettings(model)?.supportsAssistantPrefill
  if (configured !== undefined) return configured

  return !isNoAssistantPrefillClaudeModel(model)
}

/**
 * Claude Opus, Sonnet, Haiku, and Fable models default to no assistant
 * prefill. Matching name tokens covers every version and naming style, such
 * as "claude-opus-4.8-fast", "claude-3.5-sonnet", and
 * "claude-haiku-4-5-20251001".
 */
function isNoAssistantPrefillClaudeModel(model: string): boolean {
  const tokens = model.toLowerCase().split(/[^a-z\d]+/)
  return (
    tokens.includes("claude")
    && tokens.some((token) => NO_ASSISTANT_PREFILL_CLAUDE_FAMILIES.has(token))
  )
}
