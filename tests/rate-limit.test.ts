import { afterAll, beforeEach, expect, test } from "bun:test"

import type { State } from "../src/lib/state"

import { HTTPError } from "../src/lib/error"
import { checkRateLimit } from "../src/lib/rate-limit"

const originalDateNow = Date.now
let currentTime = 0

function createState(overrides?: Partial<State>): State {
  return {
    accountType: "individual",
    sessionId: "session-id",
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    debug: false,
    verbose: false,
    isMultiToken: false,
    rateLimitSeconds: 5,
    ...overrides,
  }
}

beforeEach(() => {
  currentTime = 10_000
  Date.now = () => currentTime
})

afterAll(() => {
  Date.now = originalDateNow
})

test("allows a short burst before rejecting when the token bucket is exhausted", async () => {
  const limiterState = createState({ rateLimitSeconds: 5 })

  await expect(checkRateLimit(limiterState)).resolves.toBeUndefined()
  await expect(checkRateLimit(limiterState)).resolves.toBeUndefined()

  try {
    await checkRateLimit(limiterState)
    throw new Error("Expected checkRateLimit to reject")
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).response.status).toBe(429)
  }
})

test("refills a token after the configured interval elapses", async () => {
  const limiterState = createState({ rateLimitSeconds: 5 })

  await checkRateLimit(limiterState)
  await checkRateLimit(limiterState)

  currentTime += 5_000

  await expect(checkRateLimit(limiterState)).resolves.toBeUndefined()
})
