import { expect, test } from "bun:test"

import { formatDuration } from "../ui/src/lib/duration-format"

test.each([
  [0, "0 ms"],
  [999, "999 ms"],
  [1000, "1.0s"],
  [1500, "1.5s"],
  [59_999, "60.0s"],
  [60_000, "1.0m"],
  [138_000, "2.3m"],
] as const)("formats %d milliseconds as %s", (durationMs, expected) => {
  expect(formatDuration(durationMs)).toBe(expected)
})
