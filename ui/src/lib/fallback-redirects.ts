import type {
  ModelRedirect,
  ReasoningEffort,
  RedirectSourceEffort,
  RedirectTargetVerbosity,
} from "./types"

const MAX_REDIRECT_CHAIN_LENGTH = 10

/** Effort labels describe eligible incoming categories; `default` means omitted. */
const EFFORT_CASES = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<Exclude<RedirectSourceEffort, "all">>

interface RedirectRequest {
  model: string
  effort?: ReasoningEffort
  verbosity?: RedirectTargetVerbosity
  modelOnly: boolean
}

export interface FallbackRedirectSource {
  sourceModel: string
  targetModels: Array<string>
  efforts: Array<RedirectSourceEffort>
  modelOnly: boolean
}

function stateKey(request: RedirectRequest): string {
  return JSON.stringify([
    request.model,
    request.effort ?? null,
    request.verbosity ?? null,
    request.modelOnly,
  ])
}

function resolveRedirects(
  redirects: ReadonlyArray<ModelRedirect>,
  request: RedirectRequest,
): string | undefined {
  const current = { ...request }
  const seen = new Set([stateKey(current)])
  let transitions = 0
  for (const rule of redirects) {
    if (
      !rule.enabled
      || rule.sourceModel !== current.model
      || (rule.sourceEffort !== "all"
        && rule.sourceEffort !== (current.effort ?? "default"))
    )
      continue
    const next: RedirectRequest = {
      model: rule.targetModel,
      effort:
        request.modelOnly ? undefined : (rule.targetEffort ?? current.effort),
      verbosity: rule.targetVerbosity ?? current.verbosity,
      modelOnly: request.modelOnly,
    }
    const key = stateKey(next)
    if (key === stateKey(current)) continue
    if (seen.has(key)) return undefined
    seen.add(key)
    Object.assign(current, next)
    transitions++
    if (transitions >= MAX_REDIRECT_CHAIN_LENGTH) break
  }
  return transitions > 0 ? current.model : undefined
}

function effortRequest(effort: (typeof EFFORT_CASES)[number]): RedirectRequest {
  return {
    model: "",
    effort: effort === "default" ? undefined : effort,
    modelOnly: false,
  }
}

function eligibleEfforts(
  targets: ReadonlyMap<RedirectSourceEffort, string>,
): Array<RedirectSourceEffort> {
  if (EFFORT_CASES.every((effort) => targets.has(effort))) return ["all"]
  return EFFORT_CASES.filter((effort) => targets.has(effort))
}

/** Find outside model names whose effective ordered redirect ends in this chain. */
export function findFallbackRedirectSources(
  models: ReadonlyArray<string>,
  redirects: ReadonlyArray<ModelRedirect>,
): Array<FallbackRedirectSource> {
  const chain = new Set(models)
  const sources = [
    ...new Set(
      redirects
        .filter((rule) => rule.enabled && !chain.has(rule.sourceModel))
        .map((rule) => rule.sourceModel),
    ),
  ]
  return sources.flatMap((sourceModel) => {
    const targets = new Map<RedirectSourceEffort, string>()
    for (const effort of EFFORT_CASES) {
      const target = resolveRedirects(redirects, {
        ...effortRequest(effort),
        model: sourceModel,
      })
      if (target && chain.has(target)) targets.set(effort, target)
    }
    const modelOnlyTarget = resolveRedirects(redirects, {
      model: sourceModel,
      modelOnly: true,
    })
    const modelOnly = Boolean(modelOnlyTarget && chain.has(modelOnlyTarget))
    if (targets.size === 0 && !modelOnly) return []
    const reached = new Set(targets.values())
    if (modelOnlyTarget && chain.has(modelOnlyTarget))
      reached.add(modelOnlyTarget)
    return [
      {
        sourceModel,
        targetModels: models.filter((model) => reached.has(model)),
        efforts: eligibleEfforts(targets),
        modelOnly,
      },
    ]
  })
}
