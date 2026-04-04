import { expect, test } from "bun:test"

import * as tokenPoolModule from "../src/lib/token-pool"

test("uses a 120-second buffer when scheduling token refresh", () => {
  expect(tokenPoolModule.getTokenRefreshIntervalMs?.(1800)).toBe(1_680_000)
})

test("keeps a 60-second minimum refresh interval", () => {
  expect(tokenPoolModule.getTokenRefreshIntervalMs?.(100)).toBe(60_000)
})

test("masks tokens before logging them", () => {
  expect(tokenPoolModule.maskTokenForLog?.("1234567890abcdef")).toBe(
    "1234...cdef",
  )
})
