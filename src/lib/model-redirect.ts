import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "./paths"

export interface ModelRedirectRule {
  id: string
  name?: string
  sourceModel: string
  targetModel: string
  enabled: boolean
}

let redirects: Array<ModelRedirectRule> = []
let isLoaded = false

export async function loadModelRedirects(): Promise<void> {
  try {
    const data = await fs.readFile(PATHS.MODEL_REDIRECTS_CONFIG_PATH)
    redirects = JSON.parse(data.toString()) as Array<ModelRedirectRule>
    isLoaded = true
    consola.debug(`Loaded ${redirects.length} model redirect rules`)
  } catch {
    redirects = []
    isLoaded = true
  }
}

export async function saveModelRedirects(): Promise<void> {
  try {
    await fs.writeFile(
      PATHS.MODEL_REDIRECTS_CONFIG_PATH,
      JSON.stringify(redirects, null, 2),
      "utf8",
    )
    consola.debug(`Saved ${redirects.length} model redirect rules`)
  } catch (error) {
    consola.error("Failed to save model redirect rules:", error)
    throw error
  }
}

export async function ensureLoaded(): Promise<void> {
  if (!isLoaded) await loadModelRedirects()
}

export async function getAllModelRedirects(): Promise<
  Array<ModelRedirectRule>
> {
  await ensureLoaded()
  return [...redirects]
}

export async function addModelRedirect(
  sourceModel: string,
  targetModel: string,
  options?: { name?: string },
): Promise<ModelRedirectRule> {
  await ensureLoaded()
  const rule: ModelRedirectRule = {
    id: `redirect-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: options?.name,
    sourceModel,
    targetModel,
    enabled: true,
  }
  redirects.push(rule)
  await saveModelRedirects()
  consola.info(`Added model redirect: "${sourceModel}" -> "${targetModel}"`)
  return rule
}

export async function removeModelRedirect(id: string): Promise<boolean> {
  await ensureLoaded()
  const before = redirects.length
  redirects = redirects.filter((r) => r.id !== id)
  if (redirects.length === before) return false
  await saveModelRedirects()
  consola.info(`Removed model redirect: ${id}`)
  return true
}

export async function updateModelRedirect(
  id: string,
  updates: {
    name?: string
    sourceModel?: string
    targetModel?: string
    enabled?: boolean
  },
): Promise<ModelRedirectRule | null> {
  await ensureLoaded()
  const rule = redirects.find((r) => r.id === id)
  if (!rule) return null

  if (updates.name !== undefined) rule.name = updates.name
  if (updates.sourceModel !== undefined) rule.sourceModel = updates.sourceModel
  if (updates.targetModel !== undefined) rule.targetModel = updates.targetModel
  if (updates.enabled !== undefined) rule.enabled = updates.enabled

  await saveModelRedirects()
  consola.info(`Updated model redirect: ${rule.name || rule.id}`)
  return rule
}

export async function toggleModelRedirect(
  id: string,
): Promise<ModelRedirectRule | null> {
  await ensureLoaded()
  const rule = redirects.find((r) => r.id === id)
  if (!rule) return null
  rule.enabled = !rule.enabled
  await saveModelRedirects()
  return rule
}

export async function clearModelRedirects(): Promise<void> {
  redirects = []
  await saveModelRedirects()
}

export interface ModelRedirectResult {
  model: string
  redirected: boolean
  originalModel?: string
}

/**
 * Apply exact-match model redirect rules. Returns the (possibly redirected)
 * model along with metadata describing whether a redirect occurred.
 *
 * Synchronous-by-design: callers in hot request paths should ensureLoaded()
 * up-front (we do that lazily on first call by triggering load if needed).
 */
export async function applyModelRedirect(
  model: string,
): Promise<ModelRedirectResult> {
  await ensureLoaded()
  for (const rule of redirects) {
    if (!rule.enabled) continue
    if (rule.sourceModel === model) {
      consola.debug(
        `Model redirect: "${model}" -> "${rule.targetModel}" (rule: ${rule.name || rule.id})`,
      )
      return {
        model: rule.targetModel,
        redirected: true,
        originalModel: model,
      }
    }
  }
  return { model, redirected: false }
}
