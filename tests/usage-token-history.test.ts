import { afterEach, expect, test } from "bun:test"

import type { JsonValue } from "~/lib/storage/types"
import type { HistoryRecord } from "~/lib/telemetry-writer"

import { createHistoryRepository } from "~/lib/storage/history-repository"
import { migrateStorage } from "~/lib/storage/migrations"
import { createTelemetryWriter } from "~/lib/telemetry-writer"

import { createSchemaFixture } from "./helpers/storage-schema"

const fixtures: Array<Awaited<ReturnType<typeof createSchemaFixture>>> = []
const NOW = Date.UTC(2026, 9, 12, 12)

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

async function fixture() {
  const value = await createSchemaFixture()
  fixtures.push(value)
  await migrateStorage(value.storage)
  const repository = createHistoryRepository(value.storage, { now: () => NOW })
  const writer = createTelemetryWriter(
    repository,
    { now: () => NOW },
    { autoFlush: false },
  )
  return { ...value, repository, writer }
}

function usage(id: string, input: JsonValue, output: JsonValue): HistoryRecord {
  return {
    id,
    kind: "usage",
    generation: 0,
    recordedAt: NOW,
    payload: {
      timestamp: NOW,
      model: "fixture-model",
      inputTokens: input,
      outputTokens: output,
      requestCount: 1,
      firstRequestAt: NOW,
    },
  }
}

test("invalid input and output components preserve pending usage and mixed routing batches", async () => {
  const f = await fixture()
  f.writer.enqueue(usage("bad-input", Number.MAX_SAFE_INTEGER, 7))
  f.writer.enqueue(usage("bad-output", 11, 0.5))
  f.writer.enqueue(usage("valid", 5, 13))
  f.writer.enqueue({
    id: "routing",
    kind: "routing",
    generation: 0,
    recordedAt: NOW,
    payload: { timestamp: NOW, totals: { requests: 3, upstreamCalls: 3 } },
  })
  const before = await f.writer.read((pending) =>
    f.repository.readUsageTotals(NOW, pending),
  )
  expect(before).toEqual({
    window: { inputTokens: 16, outputTokens: 20, requests: 3 },
    lifetime: {
      inputTokens: 16,
      outputTokens: 20,
      requestCount: 3,
      firstRequestAt: NOW,
    },
  })
  expect(
    await f.writer.read((pending) =>
      f.repository.collectionStatus({}, pending),
    ),
  ).toEqual({ knownLostRecords: 0, knownLostBytes: 0, unknownGaps: 2 })
  await f.writer.flush()
  expect(f.writer.status()).toMatchObject({
    pendingRecords: 0,
    droppedRecords: 0,
    degraded: false,
  })
  expect(await f.repository.readUsageTotals(NOW)).toEqual(before)
  expect((await f.repository.readRouting(NOW)).lifetime).toEqual({
    requests: 3,
    upstreamCalls: 3,
  })
  expect(await f.repository.collectionStatus()).toEqual({
    knownLostRecords: 0,
    knownLostBytes: 0,
    unknownGaps: 2,
  })
  const gaps = await f.storage.read((session) =>
    session.query({
      sql: "SELECT payload_json FROM capi_collection_gaps",
      args: [],
    }),
  )
  expect(gaps).toHaveLength(2)
  for (const gap of gaps) {
    expect(JSON.parse(String(gap.payload_json))).toMatchObject({
      historyKind: "usage",
      unknown: true,
      reason: "invalid-token-count",
    })
    expect(String(gap.payload_json)).not.toContain("fixture-model")
  }
})

test.each([
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  -1,
  0.5,
  Number.NaN,
  Infinity,
  null,
  "12",
  {},
])(
  "direct history input %p cannot poison valid output or receipt replay",
  async (input) => {
    const f = await fixture()
    const record = usage("invalid", input, 7)
    await f.repository.applyBatch("receipt", [record])
    await f.repository.applyBatch("receipt", [record])
    const pending = [{ record, batchId: "receipt" }]
    expect(await f.repository.readUsageTotals(NOW, pending)).toEqual({
      window: { inputTokens: 0, outputTokens: 7, requests: 1 },
      lifetime: {
        inputTokens: 0,
        outputTokens: 7,
        requestCount: 1,
        firstRequestAt: NOW,
      },
    })
    expect((await f.repository.collectionStatus({}, pending)).unknownGaps).toBe(
      1,
    )
  },
)

test("zero and large supported counts retain their value without collection gaps", async () => {
  const f = await fixture()
  await f.repository.applyBatch("valid", [
    usage("zero", 0, 0),
    usage("large", 2_000_000, 100_000),
  ])
  expect((await f.repository.readUsageTotals(NOW)).window).toEqual({
    inputTokens: 2_000_000,
    outputTokens: 100_000,
    requests: 2,
  })
  expect((await f.repository.collectionStatus()).unknownGaps).toBe(0)
})

test.each(["same-bucket", "separate-buckets"])(
  "%s overflow preserves representable prior counts, routing and pending totals",
  async (mode) => {
    const f = await fixture()
    const first = usage("large-first", Number.MAX_SAFE_INTEGER - 1, 7)
    const second = usage("large-second", Number.MAX_SAFE_INTEGER - 1, 11)
    if (mode === "separate-buckets") {
      second.payload = { ...(second.payload as object), model: "other-model" }
    }
    f.writer.enqueue(first)
    f.writer.enqueue(second)
    f.writer.enqueue({
      id: "mixed-routing",
      kind: "routing",
      generation: 0,
      recordedAt: NOW,
      payload: { timestamp: NOW, totals: { requests: 2 } },
    })
    const before = await f.writer.read((pending) =>
      f.repository.readUsageTotals(NOW, pending),
    )
    expect(before).toMatchObject({
      window: { inputTokens: 9007199254740990, outputTokens: 18, requests: 2 },
      lifetime: {
        inputTokens: 9007199254740990,
        outputTokens: 18,
        requestCount: 2,
      },
    })
    expect(
      (
        await f.writer.read((pending) =>
          f.repository.collectionStatus({}, pending),
        )
      ).unknownGaps,
    ).toBe(2)
    await f.writer.flush()
    expect(f.writer.status()).toMatchObject({
      pendingRecords: 0,
      degraded: false,
    })
    expect(await f.repository.readUsageTotals(NOW)).toEqual(before)
    expect((await f.repository.readRouting(NOW)).lifetime).toEqual({
      requests: 2,
    })
    expect((await f.repository.collectionStatus()).unknownGaps).toBe(2)
  },
)

test("overflow across committed batches retains a valid subtotal and permits smaller increments", async () => {
  const f = await fixture()
  await f.repository.applyBatch("prior", [
    usage("prior", Number.MAX_SAFE_INTEGER - 2, 3),
  ])
  f.writer.enqueue(usage("too-large", 5, 7))
  f.writer.enqueue(usage("fits", 1, 11))
  const before = await f.writer.read((pending) =>
    f.repository.readUsageTotals(NOW, pending),
  )
  expect(before).toMatchObject({
    window: { inputTokens: 9007199254740990, outputTokens: 21, requests: 3 },
    lifetime: {
      inputTokens: 9007199254740990,
      outputTokens: 21,
      requestCount: 3,
    },
  })
  await f.writer.flush()
  expect(await f.repository.readUsageTotals(NOW)).toEqual(before)
  expect((await f.repository.collectionStatus()).unknownGaps).toBe(2)
})

test("an unrepresentable combined count preserves both components with one gap", async () => {
  const f = await fixture()
  f.writer.enqueue(usage("combined", 9007199254740980, 20))
  const before = await f.writer.read((pending) =>
    f.repository.readUsageTotals(NOW, pending),
  )
  expect(before).toMatchObject({
    window: { inputTokens: 9007199254740980, outputTokens: 20, requests: 1 },
    lifetime: {
      inputTokens: 9007199254740980,
      outputTokens: 20,
      requestCount: 1,
    },
  })
  expect(
    (
      await f.writer.read((pending) =>
        f.repository.collectionStatus({}, pending),
      )
    ).unknownGaps,
  ).toBe(1)
  await f.writer.flush()
  expect(await f.repository.readUsageTotals(NOW)).toEqual(before)
  expect((await f.repository.collectionStatus()).unknownGaps).toBe(1)
})
