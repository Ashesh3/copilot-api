import { expect, test } from "bun:test"

import { resolveModelRedirectRules } from "~/lib/model-redirect-resolver"

import type { ModelRedirect, RedirectSourceEffort } from "../ui/src/lib/types"

import { findFallbackRedirectSources } from "../ui/src/lib/fallback-redirects"

function redirect(
  edge: { id: string; sourceModel: string; targetModel: string },
  options: {
    enabled?: boolean
    sourceEffort?: RedirectSourceEffort
    targetEffort?: ModelRedirect["targetEffort"]
  } = {},
): ModelRedirect {
  return {
    id: edge.id,
    sourceModel: edge.sourceModel,
    sourceEffort: options.sourceEffort ?? "all",
    targetModel: edge.targetModel,
    targetEffort: options.targetEffort,
    enabled: options.enabled ?? true,
    conflicts: [],
  }
}

test("ordered redirect resolution does not revisit an earlier target rule", () => {
  const redirects = [
    redirect({
      id: "faster-sol",
      sourceModel: "gpt-5.6",
      targetModel: "gpt-5.6-fast",
    }),
    redirect({
      id: "claude-gpt",
      sourceModel: "claude-gpt",
      targetModel: "gpt-5.6",
    }),
  ]

  expect(findFallbackRedirectSources(["gpt-5.6-fast"], redirects)).toEqual([
    {
      sourceModel: "gpt-5.6",
      targetModels: ["gpt-5.6-fast"],
      efforts: ["all"],
      modelOnly: true,
    },
  ])
})

test("transitive redirects attribute each outside source to its final chain model", () => {
  const redirects = [
    redirect({
      id: "claude-gpt",
      sourceModel: "claude-gpt",
      targetModel: "gpt-5.6",
    }),
    redirect({
      id: "faster-sol",
      sourceModel: "gpt-5.6",
      targetModel: "gpt-5.6-fast",
    }),
  ]

  expect(findFallbackRedirectSources(["gpt-5.6-fast"], redirects)).toEqual([
    {
      sourceModel: "claude-gpt",
      targetModels: ["gpt-5.6-fast"],
      efforts: ["all"],
      modelOnly: true,
    },
    {
      sourceModel: "gpt-5.6",
      targetModels: ["gpt-5.6-fast"],
      efforts: ["all"],
      modelOnly: true,
    },
  ])
})

test("effort mutations follow ordered matching and preserve eligible categories", () => {
  const redirects = [
    redirect(
      { id: "all-to-middle", sourceModel: "all-source", targetModel: "middle" },
      {
        targetEffort: "high",
      },
    ),
    redirect(
      { id: "middle-high", sourceModel: "middle", targetModel: "chain-high" },
      {
        sourceEffort: "high",
      },
    ),
    redirect(
      {
        id: "default",
        sourceModel: "split-source",
        targetModel: "chain-default",
      },
      {
        sourceEffort: "default",
      },
    ),
    redirect(
      { id: "none", sourceModel: "split-source", targetModel: "chain-none" },
      {
        sourceEffort: "none",
      },
    ),
  ]

  expect(
    findFallbackRedirectSources(
      ["chain-high", "chain-default", "chain-none"],
      redirects,
    ),
  ).toEqual([
    {
      sourceModel: "all-source",
      targetModels: ["chain-high"],
      efforts: ["all"],
      modelOnly: false,
    },
    {
      sourceModel: "middle",
      targetModels: ["chain-high"],
      efforts: ["high"],
      modelOnly: false,
    },
    {
      sourceModel: "split-source",
      targetModels: ["chain-default", "chain-none"],
      efforts: ["default", "none"],
      modelOnly: true,
    },
  ])
})

test("excludes chain members, disabled, shadowed, looped, and unrelated sources", () => {
  const redirects = [
    redirect({
      id: "chain-member",
      sourceModel: "chain-a",
      targetModel: "chain-b",
    }),
    redirect(
      {
        id: "disabled",
        sourceModel: "disabled-source",
        targetModel: "chain-a",
      },
      { enabled: false },
    ),
    redirect({
      id: "shadow",
      sourceModel: "shadowed-source",
      targetModel: "dead-end",
    }),
    redirect({
      id: "unreachable",
      sourceModel: "shadowed-source",
      targetModel: "chain-a",
    }),
    redirect({
      id: "loop-one",
      sourceModel: "loop-source",
      targetModel: "loop-middle",
    }),
    redirect({
      id: "loop-two",
      sourceModel: "loop-middle",
      targetModel: "loop-source",
    }),
    redirect({
      id: "unrelated",
      sourceModel: "other-source",
      targetModel: "other-target",
    }),
  ]

  expect(
    findFallbackRedirectSources(["chain-a", "chain-b"], redirects),
  ).toEqual([])
})

test("stops at the backend ten-transition cap", () => {
  const redirects = Array.from({ length: 11 }, (_, index) =>
    redirect({
      id: `step-${index + 1}`,
      sourceModel: `model-${index}`,
      targetModel: `model-${index + 1}`,
    }),
  )

  const source = findFallbackRedirectSources(
    ["model-10", "model-11"],
    redirects,
  ).find((entry) => entry.sourceModel === "model-0")
  expect(source).toEqual({
    sourceModel: "model-0",
    targetModels: ["model-10"],
    efforts: ["all"],
    modelOnly: true,
  })
  expect(resolveModelRedirectRules(redirects, { model: "model-0" }).model).toBe(
    "model-10",
  )
})

test("matches backend existence for verbosity mutation and same-state no-ops", () => {
  const redirects: Array<ModelRedirect> = [
    {
      ...redirect({
        id: "verbosity",
        sourceModel: "verbosity-source",
        targetModel: "verbosity-source",
      }),
      targetVerbosity: "high",
    },
    redirect({
      id: "after-verbosity",
      sourceModel: "verbosity-source",
      targetModel: "chain-target",
    }),
    redirect({
      id: "same-state",
      sourceModel: "same-source",
      targetModel: "same-source",
    }),
    redirect({
      id: "after-no-op",
      sourceModel: "same-source",
      targetModel: "chain-target",
    }),
  ]
  const result = findFallbackRedirectSources(["chain-target"], redirects)

  for (const sourceModel of ["verbosity-source", "same-source"]) {
    const backend = resolveModelRedirectRules(redirects, {
      model: sourceModel,
    })
    expect(backend.loop).toBeUndefined()
    expect(backend.model).toBe("chain-target")
    expect(result.some((entry) => entry.sourceModel === sourceModel)).toBe(true)
  }
  expect(result).toEqual([
    {
      sourceModel: "verbosity-source",
      targetModels: ["chain-target"],
      efforts: ["all"],
      modelOnly: true,
    },
    {
      sourceModel: "same-source",
      targetModels: ["chain-target"],
      efforts: ["all"],
      modelOnly: true,
    },
  ])
})
