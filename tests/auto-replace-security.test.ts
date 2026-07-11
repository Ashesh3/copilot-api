import { expect, test } from "bun:test"

import {
  addReplacement,
  applyReplacements,
  getUserReplacements,
  REPLACEMENT_LIMITS,
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

test("enforces pattern and input bounds", async () => {
  setReplacementsForTest([])
  expect(
    addReplacement("a".repeat(REPLACEMENT_LIMITS.maxPatternLength + 1), "x"),
  ).rejects.toBeInstanceOf(ReplacementValidationError)

  await addReplacement("secret", "redacted")
  const input = `secret${"x".repeat(REPLACEMENT_LIMITS.maxInputLength)}`
  expect(await applyReplacements(input)).toEqual({
    text: input,
    appliedRules: [],
  })
})

test("serializes concurrent replacement mutations", async () => {
  setReplacementsForTest([])
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      addReplacement(`needle-${index}`, `replacement-${index}`),
    ),
  )
  expect(await getUserReplacements()).toHaveLength(20)
})
