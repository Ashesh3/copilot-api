import { expect, test } from "bun:test"

import {
  addReplacement,
  applyReplacements,
  getUserReplacements,
  ReplacementValidationError,
  setReplacementsForTest,
} from "~/lib/auto-replace"

test("rejects regex constructs outside the RE2 safe subset", () => {
  setReplacementsForTest([])
  expect(
    addReplacement(String.raw`(a+)\1`, "x", { isRegex: true }),
  ).rejects.toBeInstanceOf(ReplacementValidationError)
  expect(
    addReplacement("(?=secret)", "x", { isRegex: true }),
  ).rejects.toBeInstanceOf(ReplacementValidationError)
})

test("applies nested-quantifier patterns with the linear-time engine", async () => {
  setReplacementsForTest([])
  await addReplacement("(a+)+$", "safe", { isRegex: true })
  const input = "a".repeat(100_000)
  const result = await applyReplacements(input)
  expect(result.text).toBe("safe")
})

test("accepts large replacement rules and inputs", async () => {
  setReplacementsForTest([])
  const pattern = "a".repeat(2048)
  const replacement = "b".repeat(20_000)
  await addReplacement(pattern, replacement)
  const input = `${pattern}${"x".repeat(1_000_001)}`
  const result = await applyReplacements(input)
  expect(result.text).toBe(`${replacement}${"x".repeat(1_000_001)}`)
  expect(result.appliedRules).toHaveLength(1)
})

test("serializes concurrent replacement mutations", async () => {
  setReplacementsForTest([])
  await Promise.all(
    Array.from({ length: 120 }, (_, index) =>
      addReplacement(`needle-${index}`, `replacement-${index}`),
    ),
  )
  expect(await getUserReplacements()).toHaveLength(120)
})
