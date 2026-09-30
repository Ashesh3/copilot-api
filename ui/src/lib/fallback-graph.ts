import type { ModelFallbackRule } from "./types"

export type FallbackPathStop = "end" | "loop" | "shared"

export interface FallbackPath {
  start: string
  models: Array<string>
  ruleIds: Array<string>
  stop: FallbackPathStop
  joinsAt?: string
  sharedWith?: string
  loopAt?: string
}

export interface FallbackGraphGroup {
  id: string
  models: Array<string>
  rules: Array<ModelFallbackRule>
  routes: Array<FallbackPath>
}

export function applyFallbackDraft(
  rules: Array<ModelFallbackRule>,
  draft: ModelFallbackRule,
): Array<ModelFallbackRule> {
  const index = rules.findIndex((rule) => rule.id === draft.id)
  if (index === -1) return [...rules, draft]
  return rules.map((rule) => (rule.id === draft.id ? draft : rule))
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" })
}

function activeRulesBySource(
  rules: Array<ModelFallbackRule>,
): Map<string, ModelFallbackRule> {
  const result = new Map<string, ModelFallbackRule>()
  for (const rule of rules)
    if (rule.enabled && !result.has(rule.sourceModel))
      result.set(rule.sourceModel, rule)
  return result
}

export function traceFallbackPath(
  start: string,
  rules: Array<ModelFallbackRule>,
): FallbackPath {
  const active = activeRulesBySource(rules)
  const models = [start]
  const ruleIds: Array<string> = []
  const seen = new Set([start])
  let current = start

  while (true) {
    const rule = active.get(current)
    if (!rule) return { start, models, ruleIds, stop: "end" }
    ruleIds.push(rule.id)
    if (seen.has(rule.targetModel))
      return { start, models, ruleIds, stop: "loop", loopAt: rule.targetModel }
    models.push(rule.targetModel)
    seen.add(rule.targetModel)
    current = rule.targetModel
  }
}

function connectedComponents(
  rules: Array<ModelFallbackRule>,
): Array<Array<string>> {
  const adjacency = new Map<string, Set<string>>()
  for (const rule of rules) {
    const source = adjacency.get(rule.sourceModel) ?? new Set<string>()
    const target = adjacency.get(rule.targetModel) ?? new Set<string>()
    source.add(rule.targetModel)
    target.add(rule.sourceModel)
    adjacency.set(rule.sourceModel, source)
    adjacency.set(rule.targetModel, target)
  }

  const components: Array<Array<string>> = []
  const visited = new Set<string>()
  for (const first of [...adjacency.keys()].sort(compareText)) {
    if (visited.has(first)) continue
    const models: Array<string> = []
    const pending = [first]
    visited.add(first)
    while (pending.length > 0) {
      const model = pending.shift()
      if (!model) break
      models.push(model)
      for (const neighbor of [...(adjacency.get(model) ?? [])].sort(
        compareText,
      ))
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          pending.push(neighbor)
        }
    }
    components.push(models.sort(compareText))
  }
  return components
}

function routeStarts(
  models: Array<string>,
  rules: Array<ModelFallbackRule>,
): Array<string> {
  const active = activeRulesBySource(rules)
  const targeted = new Set(
    [...active.values()].map(({ targetModel }) => targetModel),
  )
  const roots = models.filter(
    (model) => active.has(model) && !targeted.has(model),
  )
  if (roots.length > 0) return roots.sort(compareText)
  const sources = models.filter((model) => active.has(model))
  return (sources.length > 0 ? sources : models).sort(compareText)
}

function collapseSharedSuffixes(
  paths: Array<FallbackPath>,
): Array<FallbackPath> {
  const owners = new Map<string, string>()
  return paths.map((path) => {
    const joinIndex = path.models.findIndex((model) => owners.has(model))
    if (joinIndex === -1) {
      for (const model of path.models) owners.set(model, path.start)
      return path
    }
    const joinsAt = path.models[joinIndex]
    const retainedModels = path.models.slice(0, joinIndex)
    for (const model of retainedModels) owners.set(model, path.start)
    return {
      ...path,
      models: retainedModels,
      ruleIds: path.ruleIds.slice(0, joinIndex),
      stop: "shared",
      joinsAt,
      sharedWith: joinsAt ? owners.get(joinsAt) : undefined,
    }
  })
}

export function buildFallbackGraph(
  rules: Array<ModelFallbackRule>,
): Array<FallbackGraphGroup> {
  return connectedComponents(rules)
    .map((models) => {
      const modelSet = new Set(models)
      const groupRules = rules
        .filter(
          (rule) =>
            modelSet.has(rule.sourceModel) || modelSet.has(rule.targetModel),
        )
        .sort(
          (left, right) =>
            compareText(left.sourceModel, right.sourceModel)
            || compareText(left.targetModel, right.targetModel)
            || compareText(left.id, right.id),
        )
      const routingRules = rules.filter(
        (rule) =>
          modelSet.has(rule.sourceModel) || modelSet.has(rule.targetModel),
      )
      const rootPaths = routeStarts(models, groupRules).map((start) =>
        traceFallbackPath(start, routingRules),
      )
      const coveredRuleIds = new Set(rootPaths.flatMap((path) => path.ruleIds))
      const uncoveredPaths = groupRules
        .filter((rule) => rule.enabled && !coveredRuleIds.has(rule.id))
        .map((rule) => traceFallbackPath(rule.sourceModel, routingRules))
      const paths = [...rootPaths, ...uncoveredPaths]
      return {
        id: models[0] ?? "fallback-group",
        models,
        rules: groupRules,
        routes: collapseSharedSuffixes(paths),
      }
    })
    .sort((left, right) => compareText(left.id, right.id))
}

function pathSignature(path: FallbackPath): string {
  return JSON.stringify([path.models, path.stop])
}

export function findImpactedStarts(
  current: Array<ModelFallbackRule>,
  next: Array<ModelFallbackRule>,
): Array<string> {
  const models = new Set<string>()
  for (const rule of [...current, ...next]) {
    models.add(rule.sourceModel)
    models.add(rule.targetModel)
  }
  return [...models]
    .filter(
      (start) =>
        pathSignature(traceFallbackPath(start, current))
        !== pathSignature(traceFallbackPath(start, next)),
    )
    .sort(compareText)
}
