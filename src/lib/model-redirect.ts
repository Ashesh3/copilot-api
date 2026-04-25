import consola from "consola"
import fs from "node:fs/promises"

import type { ReasoningEffort } from "~/lib/model-suffix"

import { PATHS } from "./paths"

export type ModelRedirectEffortFilter = "all" | "default" | ReasoningEffort

export const MODEL_REDIRECT_EFFORT_FILTERS: Array<ModelRedirectEffortFilter> = [
  "all",
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
]

export interface ModelRedirectRule {
  id: string
  name?: string
  sourceModel: string
  sourceEffort: ModelRedirectEffortFilter
  targetModel: string
  targetEffort?: ReasoningEffort
  enabled: boolean
}

export interface ModelRedirectConflict {
  id: string
  name?: string
}

export interface ModelRedirectRuleWithConflicts extends ModelRedirectRule {
  conflicts: Array<ModelRedirectConflict>
}

let redirects: Array<ModelRedirectRule> = []
let isLoaded = false

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
  )
}

function normalizeEffortAlias(value: unknown): unknown {
  return value === "max" ? "xhigh" : value
}

function normalizeSourceEffort(value: unknown): ModelRedirectEffortFilter {
  const normalized = normalizeEffortAlias(value)
  if (normalized === "all" || normalized === "default") return normalized
  if (isReasoningEffort(normalized)) return normalized
  return "all"
}

function normalizeTargetEffort(value: unknown): ReasoningEffort | undefined {
  const normalized = normalizeEffortAlias(value)
  return isReasoningEffort(normalized) ? normalized : undefined
}

function normalizeRule(raw: unknown): ModelRedirectRule | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined
  }

  const value = raw as Record<string, unknown>
  if (
    typeof value.id !== "string"
    || typeof value.sourceModel !== "string"
    || typeof value.targetModel !== "string"
  ) {
    return undefined
  }

  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : undefined,
    sourceModel: value.sourceModel,
    sourceEffort: normalizeSourceEffort(value.sourceEffort),
    targetModel: value.targetModel,
    targetEffort: normalizeTargetEffort(value.targetEffort),
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
  }
}

function normalizeRules(raw: unknown): Array<ModelRedirectRule> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const rule = normalizeRule(item)
    return rule ? [rule] : []
  })
}

function effortsOverlap(
  left: ModelRedirectEffortFilter,
  right: ModelRedirectEffortFilter,
): boolean {
  return left === "all" || right === "all" || left === right
}

function rulesConflict(
  left: ModelRedirectRule,
  right: ModelRedirectRule,
): boolean {
  return (
    left.enabled
    && right.enabled
    && left.sourceModel === right.sourceModel
    && effortsOverlap(left.sourceEffort, right.sourceEffort)
  )
}

function withConflicts(
  rules: Array<ModelRedirectRule>,
): Array<ModelRedirectRuleWithConflicts> {
  return rules.map((rule) => ({
    ...rule,
    conflicts: rules
      .filter((candidate) => candidate.id !== rule.id)
      .filter((candidate) => rulesConflict(rule, candidate))
      .map((candidate) => ({ id: candidate.id, name: candidate.name })),
  }))
}

export async function loadModelRedirects(): Promise<void> {
  try {
    const data = await fs.readFile(PATHS.MODEL_REDIRECTS_CONFIG_PATH)
    redirects = normalizeRules(JSON.parse(data.toString()) as unknown)
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
  Array<ModelRedirectRuleWithConflicts>
> {
  await ensureLoaded()
  return withConflicts([...redirects])
}

export async function addModelRedirect(
  sourceModel: string,
  targetModel: string,
  options?: {
    name?: string
    sourceEffort?: ModelRedirectEffortFilter | "max"
    targetEffort?: ReasoningEffort | "max"
  },
): Promise<ModelRedirectRule> {
  await ensureLoaded()
  const rule: ModelRedirectRule = {
    id: `redirect-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: options?.name,
    sourceModel,
    sourceEffort: normalizeSourceEffort(options?.sourceEffort),
    targetModel,
    targetEffort: normalizeTargetEffort(options?.targetEffort),
    enabled: true,
  }
  redirects.push(rule)
  await saveModelRedirects()
  consola.info(`Added model redirect: "${sourceModel}" -> "${targetModel}"`)
  return { ...rule }
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
    sourceEffort?: ModelRedirectEffortFilter | "max"
    targetModel?: string
    targetEffort?: ReasoningEffort | "max" | null
    enabled?: boolean
  },
): Promise<ModelRedirectRule | null> {
  await ensureLoaded()
  const rule = redirects.find((r) => r.id === id)
  if (!rule) return null

  if (updates.name !== undefined) rule.name = updates.name
  if (updates.sourceModel !== undefined) rule.sourceModel = updates.sourceModel
  if (updates.sourceEffort !== undefined) {
    rule.sourceEffort = normalizeSourceEffort(updates.sourceEffort)
  }
  if (updates.targetModel !== undefined) rule.targetModel = updates.targetModel
  if (updates.targetEffort !== undefined) {
    rule.targetEffort = normalizeTargetEffort(updates.targetEffort)
  }
  if (updates.enabled !== undefined) rule.enabled = updates.enabled

  await saveModelRedirects()
  consola.info(`Updated model redirect: ${rule.name || rule.id}`)
  return { ...rule }
}

export async function toggleModelRedirect(
  id: string,
): Promise<ModelRedirectRule | null> {
  await ensureLoaded()
  const rule = redirects.find((r) => r.id === id)
  if (!rule) return null
  rule.enabled = !rule.enabled
  await saveModelRedirects()
  return { ...rule }
}

export async function moveModelRedirect(
  id: string,
  direction: "up" | "down",
): Promise<ModelRedirectRule | null> {
  await ensureLoaded()
  const index = redirects.findIndex((r) => r.id === id)
  if (index === -1) return null
  const current = redirects[index]

  const nextIndex = direction === "up" ? index - 1 : index + 1
  if (nextIndex < 0 || nextIndex >= redirects.length) {
    return { ...current }
  }

  const next = redirects[nextIndex]
  redirects[index] = next
  redirects[nextIndex] = current
  await saveModelRedirects()
  return { ...current }
}

export async function clearModelRedirects(): Promise<void> {
  redirects = []
  await saveModelRedirects()
}

export interface ModelRedirectResult {
  model: string
  effort?: ReasoningEffort
  redirected: boolean
  originalModel?: string
  originalEffort?: ReasoningEffort
  ruleId?: string
}

export interface ModelRedirectRequest {
  model: string
  effort?: ReasoningEffort
}

function matchesEffort(
  filter: ModelRedirectEffortFilter,
  effort: ReasoningEffort | undefined,
): boolean {
  if (filter === "all") return true
  if (filter === "default") return effort === undefined
  return filter === effort
}

/**
 * Apply exact-match model redirect rules. Returns the (possibly redirected)
 * model along with metadata describing whether a redirect occurred.
 *
 * Synchronous-by-design: callers in hot request paths should ensureLoaded()
 * up-front (we do that lazily on first call by triggering load if needed).
 */
export async function applyModelRedirect(
  input: string | ModelRedirectRequest,
): Promise<ModelRedirectResult> {
  await ensureLoaded()
  const model = typeof input === "string" ? input : input.model
  const effort = typeof input === "string" ? undefined : input.effort
  for (const rule of redirects) {
    if (!rule.enabled) continue
    if (
      rule.sourceModel === model
      && matchesEffort(rule.sourceEffort, effort)
    ) {
      const targetEffort = rule.targetEffort ?? effort
      consola.debug(
        `Model redirect: "${model}"${effort ? `:${effort}` : ""} -> "${rule.targetModel}"${targetEffort ? `:${targetEffort}` : ""} (rule: ${rule.name || rule.id})`,
      )
      return {
        model: rule.targetModel,
        effort: targetEffort,
        redirected: true,
        originalModel: model,
        originalEffort: effort,
        ruleId: rule.id,
      }
    }
  }
  return { model, effort, redirected: false }
}

export function setModelRedirectsForTest(rules: Array<unknown>): void {
  redirects = normalizeRules(rules)
  isLoaded = true
}
