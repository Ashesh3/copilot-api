import { expect, test } from "bun:test"

import { deriveUpstreamSessionId } from "~/lib/upstream-session-affinity"

test("derives a stable RFC-4122 version-5 identity", () => {
  const first = deriveUpstreamSessionId("conversation-a")
  const second = deriveUpstreamSessionId("conversation-a")

  expect(first).toBe(second)
  expect(first).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
})

test("separates different conversations", () => {
  expect(deriveUpstreamSessionId("conversation-a")).not.toBe(
    deriveUpstreamSessionId("conversation-b"),
  )
})
