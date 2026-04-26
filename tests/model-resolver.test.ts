import { expect, test } from "bun:test"

import { normalizeModelName } from "../src/lib/model-resolver"

test("normalizes version dashes while preserving 1m internal model IDs", () => {
  expect(normalizeModelName("claude-example-8-9")).toBe("claude-example-8.9")
  expect(normalizeModelName("claude-example-8.9-1m-internal")).toBe(
    "claude-example-8.9-1m-internal",
  )
})
