import { beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { setModelRoutingOverridesForTest } from "../src/lib/model-routing"
import * as tokenPoolModule from "../src/lib/token-pool"

const MODEL_A = "model-a"
const MODEL_B = "model-b"

function createPool(
  accountIds: Array<number>,
  models: Array<string> = [MODEL_A],
): tokenPoolModule.TokenPool {
  const pool = new tokenPoolModule.TokenPool()
  for (const accountId of accountIds) {
    const account = pool.addAccount(
      `github-token-${accountId}`,
      "individual",
      accountId,
    )
    account.healthy = true
    account.models = new Set(models)
  }
  pool.rebuildModelIndex()
  return pool
}

function assignment(
  pool: tokenPoolModule.TokenPool,
  key: string,
  model = MODEL_A,
): number | undefined {
  return pool.getAccountForModelBySession(model, key)?.id
}

function expectedRendezvousAccount(
  key: string,
  accountIds: Array<number>,
): number {
  return accountIds.reduce((winner, candidate) => {
    const winnerScore = createHash("sha256")
      .update(`${key}\0${winner}`)
      .digest("hex")
    const candidateScore = createHash("sha256")
      .update(`${key}\0${candidate}`)
      .digest("hex")
    return candidateScore > winnerScore ? candidate : winner
  })
}

beforeEach(() => {
  setModelRoutingOverridesForTest({})
})

test("uses a 120-second buffer when scheduling token refresh", () => {
  expect(tokenPoolModule.getTokenRefreshIntervalMs(1800)).toBe(1_680_000)
})

test("keeps a 60-second minimum refresh interval", () => {
  expect(tokenPoolModule.getTokenRefreshIntervalMs(100)).toBe(60_000)
})

test("masks tokens before logging them", () => {
  expect(tokenPoolModule.maskTokenForLog("1234567890abcdef")).toBe(
    "1234...cdef",
  )
})

test("selects the exact highest SHA-256 rendezvous score", () => {
  const ids = [7, 42, 1001]
  const pool = createPool(ids)

  for (const key of ["alpha", "beta", "gamma", "delta"]) {
    expect(assignment(pool, key)).toBe(expectedRendezvousAccount(key, ids))
  }
})

test("keeps an identified session stable across repeated selections", () => {
  const pool = createPool([1, 2, 3])
  const selections = Array.from({ length: 20 }, () =>
    assignment(pool, "stable-session"),
  )

  expect(new Set(selections).size).toBe(1)
})

test("balances deterministic identified sessions across three accounts", () => {
  const pool = createPool([1, 2, 3])
  const counts = new Map<number, number>()
  for (let index = 0; index < 900; index++) {
    const accountId = assignment(pool, `session-${index}`)
    if (accountId !== undefined) {
      counts.set(accountId, (counts.get(accountId) ?? 0) + 1)
    }
  }

  expect([...counts.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3])
  for (const count of counts.values()) {
    expect(count).toBeGreaterThan(240)
    expect(count).toBeLessThan(360)
  }
})

test("uses one account preference order across models", () => {
  const pool = createPool([11, 22, 33], [MODEL_A, MODEL_B])

  expect(assignment(pool, "cross-model-session", MODEL_A)).toBe(
    assignment(pool, "cross-model-session", MODEL_B),
  )
})

test("removing an account only remaps sessions assigned to it", () => {
  const pool = createPool([1, 2, 3])
  const keys = Array.from({ length: 300 }, (_, index) => `remove-${index}`)
  const before = new Map(keys.map((key) => [key, assignment(pool, key)]))
  const removed = pool.getAllAccounts().find((account) => account.id === 2)
  if (!removed) throw new TypeError("Expected account 2")

  pool.markUnhealthy(removed)

  for (const key of keys) {
    if (before.get(key) !== 2) {
      expect(assignment(pool, key)).toBe(before.get(key))
    }
  }
})

test("adding an account preserves most prior assignments", () => {
  const pool = createPool([1, 2])
  const keys = Array.from({ length: 600 }, (_, index) => `add-${index}`)
  const before = new Map(keys.map((key) => [key, assignment(pool, key)]))
  const added = pool.addAccount("github-token-3", "individual", 3)
  added.healthy = true
  added.models = new Set([MODEL_A])
  pool.rebuildModelIndex()

  const preserved = keys.filter(
    (key) => assignment(pool, key) === before.get(key),
  ).length
  expect(preserved / keys.length).toBeGreaterThan(0.58)
})

test("selection is independent of account insertion and index rebuild order", () => {
  const forward = createPool([1, 2, 3])
  const reverse = createPool([3, 2, 1])
  const keys = Array.from({ length: 100 }, (_, index) => `order-${index}`)

  forward.rebuildModelIndex()
  reverse.rebuildModelIndex()

  for (const key of keys) {
    expect(assignment(forward, key)).toBe(assignment(reverse, key))
  }
})

test("returns the sole eligible account for identified sessions", () => {
  const pool = createPool([19])
  expect(assignment(pool, "single-session")).toBe(19)
})

test("keeps unidentified clients on the first eligible account", () => {
  const pool = createPool([9, 4, 7])
  expect(pool.getAccountForModelBySession(MODEL_A, undefined)?.id).toBe(9)
})
