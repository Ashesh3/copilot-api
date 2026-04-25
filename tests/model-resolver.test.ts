import { expect, test } from "bun:test"

import { normalizeModelName } from "../src/lib/model-resolver"

test("normalizes anthropic version dashes while preserving 1m internal model IDs", () => {
  expect(normalizeModelName("claude-opus-4-7")).toBe("claude-opus-4.7")
  expect(normalizeModelName("claude-opus-4.7-1m-internal")).toBe(
    "claude-opus-4.7-1m-internal",
  )
})
