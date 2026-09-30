import { expect, test } from "bun:test"

import type { ModelFallbackRule } from "../ui/src/lib/types"

import {
  applyFallbackDraft,
  buildFallbackGraph,
  findImpactedStarts,
  traceFallbackPath,
} from "../ui/src/lib/fallback-graph"

// eslint-disable-next-line max-params -- Compact graph fixtures stay readable as directed edges.
function rule(
  id: string,
  sourceModel: string,
  targetModel: string,
  options: { enabled?: boolean } = {},
): ModelFallbackRule {
  return { id, sourceModel, targetModel, enabled: options.enabled ?? true }
}

test("graph connectivity is stable when configured rules are scrambled", () => {
  const rules = [
    rule("r3", "gpt-6-luna", "gpt-5.5"),
    rule("r1", "gpt-6-astra", "gpt-6-sol"),
    rule("r4", "claude-opus-5.5", "claude-sonnet-5"),
    rule("r2", "gpt-6-sol", "gpt-6-luna"),
  ]

  const forward = buildFallbackGraph(rules)
  const reversed = buildFallbackGraph([...rules].reverse())

  expect(forward).toEqual(reversed)
  expect(forward.map((group) => group.models)).toEqual([
    ["claude-opus-5.5", "claude-sonnet-5"],
    ["gpt-5.5", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"],
  ])
})

test("converging routes render one shared suffix", () => {
  const graph = buildFallbackGraph([
    rule("a", "gpt-6-astra", "gpt-6-luna"),
    rule("b", "gpt-6-sol", "gpt-6-luna"),
    rule("c", "gpt-6-luna", "gpt-5.5"),
    rule("d", "gpt-5.5", "gpt-5.3-codex"),
  ])

  expect(graph).toHaveLength(1)
  expect(graph[0]?.routes).toEqual([
    {
      start: "gpt-6-astra",
      models: ["gpt-6-astra", "gpt-6-luna", "gpt-5.5", "gpt-5.3-codex"],
      ruleIds: ["a", "c", "d"],
      stop: "end",
    },
    {
      start: "gpt-6-sol",
      models: ["gpt-6-sol"],
      ruleIds: ["b"],
      joinsAt: "gpt-6-luna",
      sharedWith: "gpt-6-astra",
      stop: "shared",
    },
  ])
})

test("three-way convergence shares both the suffix and retained branch prefix", () => {
  const graph = buildFallbackGraph([
    rule("a", "gpt-6-astra", "gpt-5.5"),
    rule("b", "gpt-6-sol", "gpt-6-luna"),
    rule("c", "claude-opus-5.5", "gpt-6-luna"),
    rule("d", "gpt-6-luna", "gpt-5.5"),
  ])

  expect(
    graph[0]?.routes.map(({ start, models, joinsAt }) => ({
      start,
      models,
      joinsAt,
    })),
  ).toEqual([
    {
      start: "claude-opus-5.5",
      models: ["claude-opus-5.5", "gpt-6-luna", "gpt-5.5"],
      joinsAt: undefined,
    },
    {
      start: "gpt-6-astra",
      models: ["gpt-6-astra"],
      joinsAt: "gpt-5.5",
    },
    {
      start: "gpt-6-sol",
      models: ["gpt-6-sol"],
      joinsAt: "gpt-6-luna",
    },
  ])
})

test("enabled cycles behind disabled bridge rules remain represented", () => {
  const graph = buildFallbackGraph([
    rule("root", "gpt-6-astra", "gpt-6-sol"),
    rule("bridge", "gpt-6-sol", "gpt-6-luna", { enabled: false }),
    rule("cycle-a", "gpt-6-luna", "gpt-5.5"),
    rule("cycle-b", "gpt-5.5", "gpt-6-luna"),
  ])

  const visibleRuleIds = graph[0]?.routes.flatMap((route) => route.ruleIds)
  expect(visibleRuleIds).toContain("root")
  expect(graph[0]?.rules.map(({ id }) => id)).toEqual([
    "cycle-b",
    "root",
    "cycle-a",
    "bridge",
  ])
  expect(visibleRuleIds).toContain("cycle-a")
  expect(visibleRuleIds).toContain("cycle-b")
  expect(new Set(visibleRuleIds).size).toBe(visibleRuleIds.length)
  expect(traceFallbackPath("gpt-6-luna", graph[0]?.rules ?? []).stop).toBe(
    "loop",
  )
})

test("disabled duplicates, cycles, and orphan targets remain visible", () => {
  const graph = buildFallbackGraph([
    rule("enabled-a", "gpt-6-astra", "gpt-6-sol"),
    rule("disabled-duplicate", "gpt-6-astra", "gpt-5.5", {
      enabled: false,
    }),
    rule("cycle-a", "gpt-6-sol", "gpt-6-luna"),
    rule("cycle-b", "gpt-6-luna", "gpt-6-sol"),
    rule("disabled-orphan", "claude-opus-5.5", "claude-sonnet-5", {
      enabled: false,
    }),
  ])

  expect(
    graph.flatMap((group) => group.rules.map(({ id }) => id)).sort(),
  ).toEqual([
    "cycle-a",
    "cycle-b",
    "disabled-duplicate",
    "disabled-orphan",
    "enabled-a",
  ])
  expect(graph.flatMap((group) => group.models).sort()).toEqual([
    "claude-opus-5.5",
    "claude-sonnet-5",
    "gpt-5.5",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
  ])
  expect(traceFallbackPath("gpt-6-astra", graph[1]?.rules ?? [])).toEqual({
    start: "gpt-6-astra",
    models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
    ruleIds: ["enabled-a", "cycle-a", "cycle-b"],
    stop: "loop",
    loopAt: "gpt-6-sol",
  })
})

test("a request preview follows the complete path beyond four models", () => {
  const rules = [
    rule("one", "gpt-6-astra", "gpt-6-sol"),
    rule("two", "gpt-6-sol", "gpt-6-luna"),
    rule("three", "gpt-6-luna", "gpt-5.5"),
    rule("four", "gpt-5.5", "gpt-5.3-codex"),
    rule("five", "gpt-5.3-codex", "gpt-5.2-codex"),
  ]

  expect(traceFallbackPath("gpt-6-astra", rules)).toEqual({
    start: "gpt-6-astra",
    models: [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.5",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
    ],
    ruleIds: ["one", "two", "three", "four", "five"],
    stop: "end",
  })
})

test("impacted starts include every upstream route through an edited source", () => {
  const current = [
    rule("a", "gpt-6-astra", "gpt-6-luna"),
    rule("b", "gpt-6-sol", "gpt-6-luna"),
    rule("c", "gpt-6-luna", "gpt-5.5"),
  ]
  const next = current.map((item) =>
    item.id === "c" ? { ...item, targetModel: "gpt-5.3-codex" } : item,
  )

  expect(findImpactedStarts(current, next)).toEqual([
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
  ])
})

test("a draft for a rule removed during refresh remains reviewable", () => {
  const refreshed = [rule("current", "gpt-6-astra", "gpt-6-luna")]
  const removedDraft = rule("removed", "gpt-6-sol", "gpt-5.5")

  expect(applyFallbackDraft(refreshed, removedDraft)).toEqual([
    ...refreshed,
    removedDraft,
  ])
})
