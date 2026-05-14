import { beforeEach, expect, test } from "bun:test"

import {
  applyModelRedirect,
  formatModelRedirectResult,
  getAllModelRedirects,
  moveModelRedirect,
  setModelRedirectsForTest,
} from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { parseModelSuffix } from "../src/lib/model-suffix"

beforeEach(() => {
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test("matches exact reasoning effort and applies target effort override", async () => {
  setModelRedirectsForTest([
    {
      id: "high-source",
      sourceModel: "claude-source-1m",
      sourceEffort: "high",
      targetModel: "claude-target-1m",
      targetEffort: "high",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "claude-source-1m",
    effort: "high",
  })

  expect(redirect).toMatchObject({
    model: "claude-target-1m",
    effort: "high",
    redirected: true,
    originalModel: "claude-source-1m",
    originalEffort: "high",
    ruleId: "high-source",
  })
})

test("all effort catch-all preserves requested effort", async () => {
  setModelRedirectsForTest([
    {
      id: "all-opus",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "claude-source",
    effort: "medium",
  })

  expect(redirect.model).toBe("claude-target")
  expect(redirect.effort).toBe("medium")
})

test("follows chained redirects and applies final target effort", async () => {
  setModelRedirectsForTest([
    {
      id: "opus-to-1m",
      sourceModel: "claude-opus-4.6",
      sourceEffort: "all",
      targetModel: "claude-opus-4.6-1m",
      enabled: true,
    },
    {
      id: "1m-to-internal",
      sourceModel: "claude-opus-4.6-1m",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      targetEffort: "xhigh",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect("claude-opus-4.6")

  expect(redirect).toMatchObject({
    model: "claude-opus-4.7-1m-internal",
    effort: "xhigh",
    redirected: true,
    originalModel: "claude-opus-4.6",
    ruleId: "opus-to-1m",
    ruleIds: ["opus-to-1m", "1m-to-internal"],
  })
  expect(formatModelRedirectResult(redirect)).toBe(
    "claude-opus-4.6 -> claude-opus-4.6-1m -> claude-opus-4.7-1m-internal:xhigh",
  )
})

test("stops chained redirects before loops", async () => {
  setModelRedirectsForTest([
    {
      id: "a-to-b",
      sourceModel: "model-a",
      sourceEffort: "all",
      targetModel: "model-b",
      enabled: true,
    },
    {
      id: "b-to-a",
      sourceModel: "model-b",
      sourceEffort: "all",
      targetModel: "model-a",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect("model-a")

  expect(redirect).toMatchObject({
    model: "model-b",
    redirected: true,
    ruleIds: ["a-to-b"],
  })
})

test("default effort filter only matches requests without explicit effort", async () => {
  setModelRedirectsForTest([
    {
      id: "default-only",
      sourceModel: "gpt-new",
      sourceEffort: "default",
      targetModel: "gpt-known",
      enabled: true,
    },
  ])

  const defaultRedirect = await applyModelRedirect("gpt-new")
  expect(defaultRedirect).toMatchObject({
    model: "gpt-known",
    redirected: true,
  })
  const explicitEffortRedirect = await applyModelRedirect({
    model: "gpt-new",
    effort: "low",
  })
  expect(explicitEffortRedirect).toMatchObject({
    model: "gpt-new",
    redirected: false,
  })
})

test("max aliases normalize to xhigh for matching and target effort", async () => {
  setModelRedirectsForTest([
    {
      id: "max-opus",
      sourceModel: "claude-source-1m",
      sourceEffort: "max",
      targetModel: "claude-target-1m",
      targetEffort: "max",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "claude-source-1m",
    effort: "xhigh",
  })

  expect(redirect.model).toBe("claude-target-1m")
  expect(redirect.effort).toBe("xhigh")
})

test("first matching rule wins until precedence is changed", async () => {
  setModelRedirectsForTest([
    {
      id: "catch-all",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target-medium",
      targetEffort: "medium",
      enabled: true,
    },
    {
      id: "high-rule",
      sourceModel: "claude-source",
      sourceEffort: "high",
      targetModel: "claude-target-high",
      targetEffort: "high",
      enabled: true,
    },
  ])

  const initialRedirect = await applyModelRedirect({
    model: "claude-source",
    effort: "high",
  })
  expect(initialRedirect).toMatchObject({
    model: "claude-target-medium",
  })

  await moveModelRedirect("high-rule", "up")

  const reorderedRedirect = await applyModelRedirect({
    model: "claude-source",
    effort: "high",
  })
  expect(reorderedRedirect).toMatchObject({
    model: "claude-target-high",
  })
})

test("does not report conflicts when specific effort rules precede catch-all fallback", async () => {
  setModelRedirectsForTest([
    {
      id: "medium-rule",
      name: "Medium",
      sourceModel: "claude-source",
      sourceEffort: "medium",
      targetModel: "claude-implicit-medium",
      enabled: true,
    },
    {
      id: "all-rule",
      name: "All",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target-1m",
      enabled: true,
    },
    {
      id: "disabled-rule",
      sourceModel: "claude-source",
      sourceEffort: "medium",
      targetModel: "ignored",
      enabled: false,
    },
  ])

  const rules = await getAllModelRedirects()

  expect(rules.find((rule) => rule.id === "medium-rule")?.conflicts).toEqual([])
  expect(rules.find((rule) => rule.id === "all-rule")?.conflicts).toEqual([])
  expect(rules.find((rule) => rule.id === "disabled-rule")?.conflicts).toEqual(
    [],
  )
})

test("reports conflicts when earlier rules fully shadow a later rule", async () => {
  setModelRedirectsForTest([
    {
      id: "all-rule",
      name: "All",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target",
      enabled: true,
    },
    {
      id: "high-rule",
      name: "High",
      sourceModel: "claude-source",
      sourceEffort: "high",
      targetModel: "claude-target-high",
      enabled: true,
    },
  ])

  const rules = await getAllModelRedirects()

  expect(rules.find((rule) => rule.id === "all-rule")?.conflicts).toEqual([])
  expect(rules.find((rule) => rule.id === "high-rule")?.conflicts).toEqual([
    { id: "all-rule", name: "All" },
  ])
})

test("parses max suffixes for unknown models so redirects can match them", () => {
  expect(parseModelSuffix("claude-source-1m:max")).toEqual({
    baseModel: "claude-source-1m",
    reasoningEffort: "xhigh",
  })
})

test("clamps configurable implicit-default model suffixes to medium", () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  expect(parseModelSuffix("claude-implicit-medium:high")).toEqual({
    baseModel: "claude-implicit-medium",
    reasoningEffort: "medium",
  })
})
