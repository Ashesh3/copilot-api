import { expect, test } from "bun:test"

import { shouldApplyFallbackSnapshot } from "../ui/src/lib/fallback-settings-snapshot"

test("older fallback snapshots cannot replace a committed configuration", () => {
  expect(shouldApplyFallbackSnapshot(14, 13)).toBe(false)
})

test("equal and newer fallback snapshots remain eligible for redirect refreshes", () => {
  expect(shouldApplyFallbackSnapshot(14, 14)).toBe(true)
  expect(shouldApplyFallbackSnapshot(14, 15)).toBe(true)
})
