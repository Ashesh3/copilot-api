import consola from "consola"
import fs from "node:fs/promises"

import type { ReasoningEffort } from "~/lib/model-suffix"

import { PATHS } from "./paths"

export interface ModelSettings {
  model: string
  sentryModelName?: string
  supportedReasoningEfforts?: Array<ReasoningEffort>
  defaultReasoningEffort?: ReasoningEffort
  implicitReasoningDefault?: boolean
  exposeVirtualReasoningModels?: boolean
}

export interface ModelSettingsUpdate {
  sentryModelName?: string | null
  supportedReasoningEfforts?: Array<ReasoningEffort | "max"> | null
  defaultReasoningEffort?: ReasoningEffort | "max" | null
  implicitReasoningDefault?: boolean | null
  exposeVirtualReasoningModels?: boolean | null
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
])

let modelSettings: Record<string, ModelSettings> = {}
let isLoaded = false

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.has(value as ReasoningEffort)
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === "max") return "xhigh"
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
  const implicitReasoningDefault =
    typeof value.implicitReasoningDefault === "boolean" ?
      value.implicitReasoningDefault
    : undefined
  const exposeVirtualReasoningModels =
    typeof value.exposeVirtualReasoningModels === "boolean" ?
      value.exposeVirtualReasoningModels
    : undefined

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
  if (implicitReasoningDefault !== undefined) {
    normalized.implicitReasoningDefault = implicitReasoningDefault
  }
  if (exposeVirtualReasoningModels !== undefined) {
    normalized.exposeVirtualReasoningModels = exposeVirtualReasoningModels
  }

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
  )
}

async function saveModelSettings(): Promise<void> {
  try {
    await fs.writeFile(
      PATHS.MODEL_SETTINGS_CONFIG_PATH,
      `${JSON.stringify(Object.values(modelSettings), null, 2)}\n`,
      "utf8",
    )
    consola.debug(
      `Saved ${Object.keys(modelSettings).length} model setting entries`,
    )
  } catch (error) {
    consola.error("Failed to save model settings:", error)
    throw error
  }
}

export async function loadModelSettings(): Promise<void> {
  try {
    const data = await fs.readFile(PATHS.MODEL_SETTINGS_CONFIG_PATH)
    modelSettings = normalizeSettings(JSON.parse(data.toString()) as unknown)
    isLoaded = true
    consola.debug(`Loaded ${Object.keys(modelSettings).length} model settings`)
  } catch {
    modelSettings = {}
    isLoaded = true
  }
}

export async function ensureModelSettingsLoaded(): Promise<void> {
  if (!isLoaded) await loadModelSettings()
}

export function getModelSettings(model: string): ModelSettings | undefined {
  return modelSettings[model]
}

export async function getAllModelSettings(): Promise<Array<ModelSettings>> {
  await ensureModelSettingsLoaded()
  return Object.values(modelSettings).sort((a, b) =>
    a.model.localeCompare(b.model),
  )
}

export async function setModelSettings(
  model: string,
  updates: ModelSettingsUpdate,
): Promise<ModelSettings> {
  await ensureModelSettingsLoaded()

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

  if (updates.implicitReasoningDefault !== undefined) {
    if (typeof updates.implicitReasoningDefault === "boolean") {
      next.implicitReasoningDefault = updates.implicitReasoningDefault
    } else {
      delete next.implicitReasoningDefault
    }
  }

  if (updates.exposeVirtualReasoningModels !== undefined) {
    if (typeof updates.exposeVirtualReasoningModels === "boolean") {
      next.exposeVirtualReasoningModels = updates.exposeVirtualReasoningModels
    } else {
      delete next.exposeVirtualReasoningModels
    }
  }

  if (!hasCustomModelSettings(next)) {
    modelSettings = Object.fromEntries(
      Object.entries(modelSettings).filter(([key]) => key !== trimmedModel),
    )
    await saveModelSettings()
    return { model: trimmedModel }
  }

  modelSettings[trimmedModel] = next
  await saveModelSettings()
  return { ...next }
}

export async function removeModelSettings(model: string): Promise<boolean> {
  await ensureModelSettingsLoaded()
  if (!Object.hasOwn(modelSettings, model)) return false
  modelSettings = Object.fromEntries(
    Object.entries(modelSettings).filter(([key]) => key !== model),
  )
  await saveModelSettings()
  return true
}

export function setModelSettingsForTest(settings: Array<unknown>): void {
  modelSettings = normalizeSettings(settings)
  isLoaded = true
}
