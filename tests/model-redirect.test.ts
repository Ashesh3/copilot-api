import { beforeEach, expect, test } from "bun:test"

import {
  applyModelRedirect,
  getAllModelRedirects,
  moveModelRedirect,
  setModelRedirectsForTest,
} from "../src/lib/model-redirect"
import { parseModelSuffix } from "../src/lib/model-suffix"

beforeEach(() => {
  setModelRedirectsForTest([])
})

test("matches exact reasoning effort and applies target effort override", async () => {
  setModelRedirectsForTest([
    {
      id: "high-opus",
      sourceModel: "claude-opus-4.7-1m",
      sourceEffort: "high",
      targetModel: "claude-opus-4.6-1m",
      targetEffort: "high",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "claude-opus-4.7-1m",
    effort: "high",
  })

  expect(redirect).toMatchObject({
    model: "claude-opus-4.6-1m",
    effort: "high",
    redirected: true,
    originalModel: "claude-opus-4.7-1m",
    originalEffort: "high",
    ruleId: "high-opus",
  })
})

test("all effort catch-all preserves requested effort", async () => {
  setModelRedirectsForTest([
    {
      id: "all-opus",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.6",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "claude-opus-4.7",
    effort: "medium",
  })

  expect(redirect.model).toBe("claude-opus-4.6")
  expect(redirect.effort).toBe("medium")
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
      sourceModel: "claude-opus-4.7-1m",
      sourceEffort: "max",
      targetModel: "claude-opus-4.6-1m",
      targetEffort: "max",
      enabled: true,
    },
  ])

  const redirect = await applyModelRedirect({
    model: "claude-opus-4.7-1m",
    effort: "xhigh",
  })

  expect(redirect.model).toBe("claude-opus-4.6-1m")
  expect(redirect.effort).toBe("xhigh")
})

test("first matching rule wins until precedence is changed", async () => {
  setModelRedirectsForTest([
    {
      id: "catch-all",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.6-medium",
      targetEffort: "medium",
      enabled: true,
    },
    {
      id: "high-rule",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "high",
      targetModel: "claude-opus-4.6-high",
      targetEffort: "high",
      enabled: true,
    },
  ])

  const initialRedirect = await applyModelRedirect({
    model: "claude-opus-4.7",
    effort: "high",
  })
  expect(initialRedirect).toMatchObject({
    model: "claude-opus-4.6-medium",
  })

  await moveModelRedirect("high-rule", "up")

  const reorderedRedirect = await applyModelRedirect({
    model: "claude-opus-4.7",
    effort: "high",
  })
  expect(reorderedRedirect).toMatchObject({
    model: "claude-opus-4.6-high",
  })
})

test("does not report conflicts when specific effort rules precede catch-all fallback", async () => {
  setModelRedirectsForTest([
    {
      id: "medium-rule",
      name: "Medium",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "medium",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "all-rule",
      name: "All",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.6-1m",
      enabled: true,
    },
    {
      id: "disabled-rule",
      sourceModel: "claude-opus-4.7",
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
      sourceModel: "claude-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.6",
      enabled: true,
    },
    {
      id: "high-rule",
      name: "High",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "high",
      targetModel: "claude-opus-4.6-high",
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
  expect(parseModelSuffix("claude-opus-4.7-1m:max")).toEqual({
    baseModel: "claude-opus-4.7-1m",
    reasoningEffort: "xhigh",
  })
})
