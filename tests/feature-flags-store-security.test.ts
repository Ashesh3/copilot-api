import { expect, test } from "bun:test"

import {
  FeatureFlagValidationError,
  getFeatureFlags,
  isValidFeatureFlagName,
  setFeatureFlag,
  setFeatureFlagsForTest,
} from "~/routes/feature-flags/store"

test("rejects prototype-polluting and malformed feature flag names", () => {
  setFeatureFlagsForTest()
  for (const name of ["__proto__", "constructor", "prototype", "bad flag"]) {
    expect(isValidFeatureFlagName(name)).toBe(false)
    expect(() => setFeatureFlag(name, true)).toThrow(FeatureFlagValidationError)
  }
  expect(Object.getPrototypeOf(getFeatureFlags())).toBeNull()
})

test("accepts bounded ordinary feature flag names", () => {
  setFeatureFlagsForTest()
  const name = `security_safe_flag_${Date.now()}`
  expect(isValidFeatureFlagName(name)).toBe(true)
  expect(setFeatureFlag(name, true)[name]).toBe(true)
})

test("does not expose the mutable feature flag store to callers", () => {
  setFeatureFlagsForTest()
  const snapshot = getFeatureFlags()
  snapshot.__proto__ = true
  snapshot.caller_mutation = true

  expect(Object.hasOwn(getFeatureFlags(), "__proto__")).toBe(false)
  expect(Object.hasOwn(getFeatureFlags(), "caller_mutation")).toBe(false)
})
