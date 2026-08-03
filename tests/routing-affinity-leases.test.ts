import { beforeEach, expect, test } from "bun:test"

import {
  getRoutingAffinityLease,
  resetRoutingAffinityLeasesForTest,
  setRoutingAffinityLease,
} from "~/lib/routing-affinity-leases"

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const NOW = Date.UTC(2026, 7, 3, 12)

beforeEach(() => {
  resetRoutingAffinityLeasesForTest()
})

test("expires leases exactly 24 hours after their latest assignment", () => {
  setRoutingAffinityLease("session", 12, NOW)

  expect(getRoutingAffinityLease("session", NOW + DAY_MS - 1)).toBe(12)
  expect(getRoutingAffinityLease("session", NOW + DAY_MS)).toBeUndefined()
})

test("updating a lease refreshes its timestamp and insertion age", () => {
  setRoutingAffinityLease("refreshed", 1, NOW)
  setRoutingAffinityLease("older", 2, NOW + 1)
  setRoutingAffinityLease("refreshed", 3, NOW + HOUR_MS)

  expect(getRoutingAffinityLease("refreshed", NOW + DAY_MS)).toBe(3)
  expect(
    getRoutingAffinityLease("refreshed", NOW + DAY_MS + HOUR_MS),
  ).toBeUndefined()
})

test("evicts the oldest insertion when capacity exceeds 10000", () => {
  for (let index = 0; index < 10_000; index++) {
    setRoutingAffinityLease(`session-${index}`, index, NOW + index)
  }
  setRoutingAffinityLease("session-new", 10_000, NOW + 10_000)

  expect(getRoutingAffinityLease("session-0", NOW + 10_000)).toBeUndefined()
  expect(getRoutingAffinityLease("session-1", NOW + 10_000)).toBe(1)
  expect(getRoutingAffinityLease("session-new", NOW + 10_000)).toBe(10_000)
})

test("updated entries become newest for capacity eviction", () => {
  for (let index = 0; index < 10_000; index++) {
    setRoutingAffinityLease(`session-${index}`, index, NOW + index)
  }
  setRoutingAffinityLease("session-0", 77, NOW + 10_000)
  setRoutingAffinityLease("session-new", 88, NOW + 10_001)

  expect(getRoutingAffinityLease("session-0", NOW + 10_001)).toBe(77)
  expect(getRoutingAffinityLease("session-1", NOW + 10_001)).toBeUndefined()
})

test("ignores invalid keys, account IDs, and timestamps without throwing", () => {
  for (const [key, accountId, now] of [
    ["", 1, NOW],
    [" ", 1, NOW],
    ["x".repeat(513), 1, NOW],
    ["valid", -1, NOW],
    ["valid", 1.5, NOW],
    ["valid", Number.MAX_SAFE_INTEGER + 1, NOW],
    ["valid", 1, Number.NaN],
  ] as Array<[string, number, number]>) {
    expect(() => setRoutingAffinityLease(key, accountId, now)).not.toThrow()
  }

  expect(getRoutingAffinityLease("valid", NOW)).toBeUndefined()
  expect(() => getRoutingAffinityLease("x".repeat(513), NOW)).not.toThrow()
})

test("reset removes all leases", () => {
  setRoutingAffinityLease("session", 9, NOW)
  resetRoutingAffinityLeasesForTest()
  expect(getRoutingAffinityLease("session", NOW)).toBeUndefined()
})
