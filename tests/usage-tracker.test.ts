import { expect, test } from "bun:test"

import { parseUsageData } from "~/lib/usage-tracker"

const DAY_MS = 24 * 60 * 60 * 1000

test("migrates all legacy records into minute/model buckets and lifetime totals", () => {
  const now = Date.UTC(2026, 6, 12, 12, 0, 0)
  const data = parseUsageData(
    {
      records: [
        {
          timestamp: now - 8 * DAY_MS,
          inputTokens: 10,
          outputTokens: 20,
          model: "old",
        },
        {
          timestamp: now - 30_000,
          inputTokens: 1,
          outputTokens: 2,
          model: "gpt-test",
        },
        {
          timestamp: now - 10_000,
          inputTokens: 3,
          outputTokens: 4,
          model: "gpt-test",
        },
      ],
    },
    now,
  )

  expect(data.version).toBe(2)
  expect(data.buckets).toHaveLength(2)
  expect(data.buckets[1]).toMatchObject({
    inputTokens: 4,
    outputTokens: 6,
    requestCount: 2,
    model: "gpt-test",
  })
  expect(data.lifetime).toEqual({
    inputTokens: 14,
    outputTokens: 26,
    requestCount: 3,
    firstRequestAt: now - 8 * DAY_MS,
  })
})

test("retains v2 buckets beyond the seven-day reporting window", () => {
  const now = Date.UTC(2026, 6, 12, 12, 0, 0)
  const data = parseUsageData(
    {
      version: 2,
      buckets: [
        {
          timestamp: now - 8 * DAY_MS,
          inputTokens: 100,
          outputTokens: 100,
          requestCount: 1,
        },
        {
          timestamp: now - DAY_MS,
          inputTokens: 5,
          outputTokens: 6,
          requestCount: 2,
        },
      ],
      lifetime: {
        inputTokens: 105,
        outputTokens: 106,
        requestCount: 3,
        firstRequestAt: now - 8 * DAY_MS,
      },
    },
    now,
  )

  expect(data.buckets).toHaveLength(2)
  expect(data.lifetime.requestCount).toBe(3)
  expect(data.lifetime.inputTokens).toBe(105)
})

test("drops malformed records and invalid counters during migration", () => {
  const now = Date.UTC(2026, 6, 12, 12, 0, 0)
  const data = parseUsageData(
    {
      records: [
        { timestamp: now, inputTokens: -1, outputTokens: 3 },
        { timestamp: now, inputTokens: Number.NaN, outputTokens: 3 },
        { timestamp: now + DAY_MS, inputTokens: 1, outputTokens: 1 },
        { timestamp: now, inputTokens: 2, outputTokens: 3 },
      ],
    },
    now,
  )
  expect(data.buckets).toHaveLength(1)
  expect(data.lifetime).toMatchObject({
    inputTokens: 2,
    outputTokens: 3,
    requestCount: 1,
  })
})

test("keeps records exactly on the seven-day cutoff", () => {
  const now = Date.UTC(2026, 6, 12, 12, 0, 0)
  const data = parseUsageData(
    {
      records: [
        {
          timestamp: now - 7 * DAY_MS,
          inputTokens: 1,
          outputTokens: 1,
        },
      ],
    },
    now,
  )
  expect(data.buckets).toHaveLength(1)
  expect(data.lifetime.requestCount).toBe(1)
})

test("retains long model identifiers", () => {
  const now = Date.UTC(2026, 6, 12, 12, 0, 0)
  const model = `provider/${"x".repeat(256)}`
  const data = parseUsageData(
    {
      records: [
        {
          timestamp: now,
          inputTokens: 1,
          outputTokens: 1,
          model,
        },
      ],
    },
    now,
  )

  expect(data.buckets[0]?.model).toBe(model)
})
