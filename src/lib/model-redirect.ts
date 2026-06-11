import consola from "consola"
import fs from "node:fs/promises"

import type { ReasoningEffort } from "~/lib/model-suffix"

import { PATHS } from "./paths"

export type ModelRedirectEffortFilter = "all" | "default" | ReasoningEffort

export const MODEL_REDIRECT_EFFORT_FILTERS: Array<ModelRedirectEffortFilter> = [
  "all",
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

const REDIRECT_EFFORT_CASES = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

type RedirectEffortCase = (typeof REDIRECT_EFFORT_CASES)[number]

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
let skipPersistForTest = false

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
  )
}

function normalizeSourceEffort(value: unknown): ModelRedirectEffortFilter {
  if (value === "all" || value === "default") return value
  if (isReasoningEffort(value)) return value
  return "all"
}

function normalizeTargetEffort(value: unknown): ReasoningEffort | undefined {
  return isReasoningEffort(value) ? value : undefined
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

function effortCases(
  filter: ModelRedirectEffortFilter,
): Array<RedirectEffortCase> {
  if (filter === "all") return [...REDIRECT_EFFORT_CASES]
  return [filter as RedirectEffortCase]
}

function getShadowingRules(
  rule: ModelRedirectRule,
  priorRules: Array<ModelRedirectRule>,
): Array<ModelRedirectRule> {
  if (!rule.enabled) return []

  const remaining = new Set(effortCases(rule.sourceEffort))
  const shadowingRules: Array<ModelRedirectRule> = []

  for (const candidate of priorRules) {
    if (!candidate.enabled || candidate.sourceModel !== rule.sourceModel) {
      continue
    }

    let coversAnyRemainingCase = false
    for (const effort of effortCases(candidate.sourceEffort)) {
      if (!remaining.has(effort)) continue
      remaining.delete(effort)
      coversAnyRemainingCase = true
    }

    if (coversAnyRemainingCase) shadowingRules.push(candidate)
    if (remaining.size === 0) return shadowingRules
  }

  return []
}

function withConflicts(
  rules: Array<ModelRedirectRule>,
): Array<ModelRedirectRuleWithConflicts> {
  return rules.map((rule, index) => {
    const shadowingRules = getShadowingRules(rule, rules.slice(0, index))
    return {
      ...rule,
      conflicts: shadowingRules.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
      })),
    }
  })
}

export async function loadModelRedirects(): Promise<void> {
  skipPersistForTest = false

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
  if (skipPersistForTest) return

  try {
    await fs.mkdir(PATHS.APP_DIR, { recursive: true })
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
  ruleIds?: Array<string>
  redirectChain?: Array<ModelRedirectStep>
}

export interface ModelRedirectRequest {
  model: string
  effort?: ReasoningEffort
}

export interface ModelRedirectStep {
  ruleId: string
  ruleName?: string
  sourceModel: string
  sourceEffort?: ReasoningEffort
  targetModel: string
  targetEffort?: ReasoningEffort
}

const MAX_REDIRECT_CHAIN_LENGTH = 10

function matchesEffort(
  filter: ModelRedirectEffortFilter,
  effort: ReasoningEffort | undefined,
): boolean {
  if (filter === "all") return true
  if (filter === "default") return effort === undefined
  return filter === effort
}

function findMatchingRedirectRule(
  model: string,
  effort: ReasoningEffort | undefined,
): ModelRedirectRule | undefined {
  return redirects.find(
    (rule) =>
      rule.enabled
      && rule.sourceModel === model
      && matchesEffort(rule.sourceEffort, effort),
  )
}

function formatModelWithEffort(
  model: string,
  effort: ReasoningEffort | undefined,
): string {
  return effort ? `${model}:${effort}` : model
}

function getRedirectStateKey(
  model: string,
  effort: ReasoningEffort | undefined,
): string {
  return formatModelWithEffort(model, effort ?? undefined)
}

function createRedirectStep(
  rule: ModelRedirectRule,
  sourceModel: string,
  sourceEffort: ReasoningEffort | undefined,
): ModelRedirectStep {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    sourceModel,
    sourceEffort,
    targetModel: rule.targetModel,
    targetEffort: rule.targetEffort ?? sourceEffort,
  }
}

export function formatModelRedirectResult(
  redirect: ModelRedirectResult,
): string {
  const chain = redirect.redirectChain
  if (!chain || chain.length === 0) {
    return formatModelWithEffort(redirect.model, redirect.effort)
  }

  return [
    formatModelWithEffort(chain[0].sourceModel, chain[0].sourceEffort),
    ...chain.map((step) =>
      formatModelWithEffort(step.targetModel, step.targetEffort),
    ),
  ].join(" -> ")
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
  const originalModel = typeof input === "string" ? input : input.model
  const originalEffort = typeof input === "string" ? undefined : input.effort
  let model = originalModel
  let effort = originalEffort
  const redirectChain: Array<ModelRedirectStep> = []
  const seen = new Set<string>()

  while (redirectChain.length < MAX_REDIRECT_CHAIN_LENGTH) {
    seen.add(getRedirectStateKey(model, effort))

    const rule = findMatchingRedirectRule(model, effort)
    if (!rule) break

    const currentKey = getRedirectStateKey(model, effort)
    const step = createRedirectStep(rule, model, effort)
    const nextKey = getRedirectStateKey(step.targetModel, step.targetEffort)
    if (nextKey === currentKey) {
      break
    }
    if (seen.has(nextKey)) {
      consola.warn(
        `Model redirect loop detected, stopping at ${formatModelWithEffort(model, effort)} before rule ${rule.name || rule.id}`,
      )
      break
    }

    redirectChain.push(step)
    model = step.targetModel
    effort = step.targetEffort
  }

  if (redirectChain.length === 0) {
    return { model, effort, redirected: false }
  }

  if (redirectChain.length >= MAX_REDIRECT_CHAIN_LENGTH) {
    consola.warn(
      `Model redirect chain exceeded ${MAX_REDIRECT_CHAIN_LENGTH} hops, stopping at ${formatModelWithEffort(model, effort)}`,
    )
  }

  const result: ModelRedirectResult = {
    model,
    effort,
    redirected: true,
    originalModel,
    originalEffort,
    ruleId: redirectChain[0]?.ruleId,
    ruleIds: redirectChain.map((step) => step.ruleId),
    redirectChain,
  }
  consola.debug(
    `Model redirect chain: ${formatModelRedirectResult(result)} (rules: ${result.ruleIds?.join(", ")})`,
  )
  return result
}

export function setModelRedirectsForTest(rules: Array<unknown>): void {
  redirects = normalizeRules(rules)
  isLoaded = true
  skipPersistForTest = true
}
