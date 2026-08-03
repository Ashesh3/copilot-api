import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"

export interface ModelRoutingOverride {
  modelId: string
  accountId: number
  enabled: boolean
}

type ModelRoutingConfig = Partial<Record<string, Record<string, boolean>>>

let routingConfig: ModelRoutingConfig = {}
let isLoaded = false

function normalizeConfig(value: unknown): ModelRoutingConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {}
  }

  const normalized: ModelRoutingConfig = {}
  for (const [modelId, accountMap] of Object.entries(value)) {
    if (
      typeof accountMap !== "object"
      || accountMap === null
      || Array.isArray(accountMap)
    ) {
      continue
    }

    const typedAccountMap = accountMap as Record<string, unknown>
    for (const [accountId, enabled] of Object.entries(typedAccountMap)) {
      if (typeof enabled !== "boolean") continue
      const normalizedAccountMap = normalized[modelId] ?? {}
      normalizedAccountMap[accountId] = enabled
      normalized[modelId] = normalizedAccountMap
    }
  }

  return normalized
}

export async function loadModelRoutingOverrides(): Promise<void> {
  try {
    const data = await fs.readFile(PATHS.MODEL_ROUTING_CONFIG_PATH)
    routingConfig = normalizeConfig(JSON.parse(data.toString()) as unknown)
    consola.debug(
      `Loaded model routing overrides for ${Object.keys(routingConfig).length} models`,
    )
  } catch {
    routingConfig = {}
  }
  isLoaded = true
}

export async function saveModelRoutingOverrides(): Promise<void> {
  try {
    await fs.writeFile(
      PATHS.MODEL_ROUTING_CONFIG_PATH,
      JSON.stringify(routingConfig, null, 2),
      "utf8",
    )
    consola.debug("Saved model routing overrides")
  } catch (error) {
    consola.error("Failed to save model routing overrides:", error)
    throw error
  }
}

export async function ensureModelRoutingOverridesLoaded(): Promise<void> {
  if (!isLoaded) await loadModelRoutingOverrides()
}

export function isModelEnabledForAccount(
  modelId: string,
  accountId: number,
): boolean {
  return routingConfig[modelId]?.[String(accountId)] ?? true
}

export function hasModelRoutingOverride(
  modelId: string,
  accountId: number,
): boolean {
  return routingConfig[modelId]?.[String(accountId)] !== undefined
}

export async function setModelRoutingOverride(
  modelId: string,
  accountId: number,
  enabled: boolean,
): Promise<ModelRoutingOverride> {
  await ensureModelRoutingOverridesLoaded()
  const accountMap = routingConfig[modelId] ?? {}
  accountMap[String(accountId)] = enabled
  routingConfig[modelId] = accountMap
  await saveModelRoutingOverrides()
  return { modelId, accountId, enabled }
}

export async function clearModelRoutingOverrides(): Promise<void> {
  routingConfig = {}
  await saveModelRoutingOverrides()
}

export function setModelRoutingOverridesForTest(
  config: ModelRoutingConfig,
): void {
  routingConfig = config
  isLoaded = true
}

export function resetModelRoutingOverridesForTest(): void {
  routingConfig = {}
  isLoaded = false
}

export async function getAllModelRoutingOverrides(): Promise<
  Array<ModelRoutingOverride>
> {
  await ensureModelRoutingOverridesLoaded()
  const overrides: Array<ModelRoutingOverride> = []

  for (const [modelId, accountMap] of Object.entries(routingConfig)) {
    if (!accountMap) continue

    for (const [accountId, enabled] of Object.entries(accountMap)) {
      overrides.push({ modelId, accountId: Number(accountId), enabled })
    }
  }

  return overrides
}
