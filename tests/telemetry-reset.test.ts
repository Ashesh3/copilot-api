/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited. */
import { afterEach, expect, test } from "bun:test"

import type { HistoryRepository } from "~/lib/storage/history-repository"
import type { MutationContext } from "~/lib/storage/types"
import type { HistoryRecord, TelemetryWriter } from "~/lib/telemetry-writer"

import { StorageUnavailableError } from "~/lib/storage/errors"
import { createHistoryRepository } from "~/lib/storage/history-repository"
import { migrateStorage } from "~/lib/storage/migrations"
import { getStoreRevision } from "~/lib/storage/operations"
import { createTelemetryWriter } from "~/lib/telemetry-writer"

import { createSchemaFixture } from "./helpers/storage-schema"

const NOW = 1_800_000_030_123
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

function event(id: string, recordedAt: number): HistoryRecord {
  return {
    id,
    kind: "usage",
    generation: 0,
    recordedAt,
    payload: {
      timestamp: Math.floor(recordedAt / 60_000) * 60_000,
      inputTokens: 7,
      outputTokens: 11,
      requestCount: 1,
      firstRequestAt: recordedAt,
    },
  }
}

async function fixture() {
  const f = await createSchemaFixture()
  await migrateStorage(f.storage)
  let now = NOW
  let failFlush = false
  let failReset = false
  const repository = createHistoryRepository(f.storage, { now: () => now })
  const wrapped: HistoryRepository = {
    ...repository,
    applyBatch(id, records) {
      if (failFlush) return Promise.reject(new StorageUnavailableError())
      return repository.applyBatch(id, records)
    },
    reset(context) {
      if (failReset) return Promise.reject(new StorageUnavailableError())
      return repository.reset(context)
    },
  }
  const writer = createTelemetryWriter(
    wrapped,
    { now: () => now },
    { autoFlush: false },
  )
  cleanup.push(async () => {
    await writer.close(1000)
    await f.close()
  })
  return {
    ...f,
    repository,
    wrapped,
    writer,
    time(value: number) {
      now = value
    },
    failFlush(value: boolean) {
      failFlush = value
    },
    failReset(value: boolean) {
      failReset = value
    },
    async context(operationId = "reset-writer"): Promise<MutationContext> {
      return {
        actorId: "fixture-admin",
        operationId,
        expectedRevision: await getStoreRevision(f.storage),
        kind: "history.reset",
        inputDigest: "fixture-reset",
      }
    },
  }
}

function reset(writer: TelemetryWriter, context: MutationContext) {
  expect(typeof writer.reset).toBe("function")
  return writer.reset(context)
}

test("reset clears failed batches, pending counters and collection warnings then admits same-millisecond usage", async () => {
  const f = await fixture()
  f.writer.enqueue(event("persisted", NOW - 2))
  await f.writer.flush()
  f.failFlush(true)
  f.writer.enqueue(event("active", NOW - 1))
  await f.writer.flush()
  for (let i = 0; i < 2001; i++) f.writer.enqueue(event(`queued-${i}`, NOW))
  expect(f.writer.status().droppedRecords).toBeGreaterThan(0)
  await reset(f.writer, await f.context())
  expect(f.writer.status()).toMatchObject({
    pendingRecords: 0,
    pendingBytes: 0,
    droppedRecords: 0,
    degraded: false,
  })
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(0)
  expect(await f.repository.collectionStatus()).toEqual({
    knownLostRecords: 0,
    knownLostBytes: 0,
    unknownGaps: 0,
  })
  f.failFlush(false)
  f.writer.enqueue(event("fresh-same-millisecond", NOW))
  await f.writer.flush()
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1)
})

test("failed reset preserves buffered history and degraded status", async () => {
  const f = await fixture()
  f.failFlush(true)
  f.writer.enqueue(event("retained", NOW - 1))
  await f.writer.flush()
  const status = f.writer.status()
  f.failReset(true)
  await expect(reset(f.writer, await f.context())).rejects.toBeInstanceOf(
    StorageUnavailableError,
  )
  expect(f.writer.status()).toEqual(status)
  f.failFlush(false)
  f.failReset(false)
  await f.writer.flush()
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1)
})

test("replaying the same reset leaves new queued and persisted usage intact", async () => {
  const f = await fixture()
  const context = await f.context()
  await reset(f.writer, context)
  f.writer.enqueue(event("persisted-after-reset", NOW))
  await f.writer.flush()
  f.writer.enqueue(event("pending-after-reset", NOW))
  await reset(f.writer, context)
  const result = await f.writer.read((pending) =>
    f.repository.readUsage(0, pending),
  )
  expect(result.lifetime.requestCount).toBe(2)
  await f.writer.flush()
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(2)
})

test("a remote reset removes old overlays and mixed-minute batches while retaining newer events", async () => {
  const f = await fixture()
  const other = createTelemetryWriter(
    f.repository,
    { now: () => NOW + 2 },
    { autoFlush: false },
  )
  cleanup.unshift(async () => {
    await other.close(1000)
  })
  other.enqueue(event("old", NOW - 1))
  await reset(f.writer, await f.context())
  other.enqueue(event("new", NOW + 1))
  const result = await other.read((pending) =>
    f.repository.readUsage(0, pending),
  )
  expect(result.lifetime.requestCount).toBe(1)
  expect(other.status().pendingRecords).toBe(1)
  await other.flush()
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1)
})

test("evicting old records before observing a remote reset does not recreate cleared gaps", async () => {
  const f = await fixture()
  const other = createTelemetryWriter(
    f.repository,
    { now: () => NOW + 2 },
    { autoFlush: false },
  )
  cleanup.unshift(async () => {
    await other.close(1000)
  })
  for (let i = 0; i < 2000; i++) other.enqueue(event(`old-${i}`, NOW - 1))
  await reset(f.writer, await f.context())
  other.enqueue(event("fresh", NOW + 1))
  expect(other.status().droppedRecords).toBe(1)
  await other.flush()
  expect(other.status()).toMatchObject({
    pendingRecords: 0,
    droppedRecords: 0,
    degraded: false,
  })
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1)
  expect(await f.repository.collectionStatus()).toEqual({
    knownLostRecords: 0,
    knownLostBytes: 0,
    unknownGaps: 0,
  })
})

test("new losses and database failures after reset remain visible", async () => {
  const f = await fixture()
  await reset(f.writer, await f.context())
  for (let i = 0; i < 2001; i++) f.writer.enqueue(event(`new-${i}`, NOW))
  f.failFlush(true)
  await f.writer.flush()
  expect(f.writer.status()).toMatchObject({ droppedRecords: 1, degraded: true })
  f.failFlush(false)
  await f.writer.flush()
  expect((await f.repository.collectionStatus()).knownLostRecords).toBe(1)
})

test("a delayed reset acknowledgement preserves records arriving after its committed boundary", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.wrapped.reset = async (context) => {
    const result = await f.repository.reset(context)
    entered.resolve(undefined)
    await release.promise
    return result
  }
  const pending = reset(f.writer, await f.context())
  await entered.promise
  f.writer.enqueue(event("after-commit", NOW + 1))
  release.resolve(undefined)
  await pending
  expect(f.writer.status().pendingRecords).toBe(1)
  await f.writer.flush()
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1)
})

test("repeated failed-batch expiration keeps collection-gap buffering bounded", async () => {
  const f = await fixture()
  f.failFlush(true)
  let now = NOW
  f.writer.enqueue(event("initial", now))
  await f.writer.flush()
  for (let cycle = 0; cycle < 12; cycle++) {
    f.writer.enqueue(event(`expired-${cycle}`, now))
    now += 300_001
    f.time(now)
    await f.writer.flush()
    const gaps = await f.writer.read((pending) =>
      Promise.resolve(
        pending.filter((item) => item.record.kind === "collection-gap"),
      ),
    )
    expect(gaps.length).toBeLessThanOrEqual(2)
  }
  expect(f.writer.status()).toMatchObject({
    pendingRecords: 0,
    pendingBytes: 0,
    droppedRecords: 13,
  })
  f.failFlush(false)
  await f.writer.flush()
  expect(await f.repository.collectionStatus()).toMatchObject({
    knownLostRecords: 1,
    unknownGaps: 1,
  })
})

test("new exact drops remain finite and separate from a reset-overlapping unknown gap", async () => {
  const f = await fixture()
  f.writer.enqueue(event("before-reset", NOW - 1))
  for (let index = 0; index < 2001; index++)
    f.writer.enqueue(event(`after-reset-${index}`, NOW + 1))
  await f.repository.reset(await f.context())
  await f.writer.read(() => Promise.resolve())
  expect(f.writer.status().droppedRecords).toBe(0)
  f.writer.enqueue(event("another-fresh-record", NOW + 2))
  const pendingGaps = await f.writer.read((pending) =>
    Promise.resolve(
      pending.filter((item) => item.record.kind === "collection-gap"),
    ),
  )
  for (const item of pendingGaps) {
    const payload = item.record.payload
    if (payload && typeof payload === "object" && !Array.isArray(payload))
      for (const key of ["lostRecords", "lostBytes", "discardedRecords"])
        if (key in payload) expect(Number.isFinite(payload[key])).toBe(true)
  }
  await f.writer.flush()
  expect(await f.repository.collectionStatus()).toMatchObject({
    knownLostRecords: 1,
    unknownGaps: 1,
  })
  expect(f.writer.status().droppedRecords).toBe(1)
})

test("an active mixed batch keeps its receipt identity across a remote reset and lost acknowledgement", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let first = true
  // eslint-disable-next-line require-atomic-updates -- This test owns its fixture; the assignment installs a one-shot acknowledgement fault before flushing.
  f.wrapped.applyBatch = async (id, records) => {
    if (first) {
      first = false
      entered.resolve(undefined)
      await released.promise
      await f.repository.applyBatch(id, records)
      throw new StorageUnavailableError()
    }
    await f.repository.applyBatch(id, records)
  }
  f.writer.enqueue(event("old-active", NOW - 1))
  f.writer.enqueue(event("fresh-active", NOW + 1))
  const flushing = f.writer.flush()
  await entered.promise
  try {
    await f.repository.reset(await f.context())
  } finally {
    released.resolve(undefined)
  }
  await flushing
  const during = await f.writer.read((pending) =>
    f.repository.readUsage(0, pending),
  )
  expect(during.lifetime.requestCount).toBe(1)
  expect(f.writer.status().pendingRecords).toBe(1)
  await f.writer.flush()
  expect(f.writer.status()).toMatchObject({
    pendingRecords: 0,
    pendingBytes: 0,
    degraded: false,
  })
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(1)
})

test("replaying an older reset receipt never replaces the newer observed reset generation", async () => {
  const f = await fixture()
  const first = await f.context("first-reset")
  await f.writer.reset(first)
  f.writer.enqueue(event("cleared-by-second-reset", NOW))
  await f.repository.reset(await f.context("second-reset"))
  await f.writer.read(() => Promise.resolve())
  expect(f.writer.status().pendingRecords).toBe(0)
  f.writer.enqueue(event("new-before-replay", NOW))
  expect((await f.writer.reset(first)).revision).toBe(1)
  f.writer.enqueue(event("new-after-replay", NOW))
  await f.writer.flush()
  expect((await f.repository.resetState())?.revision).toBe(2)
  expect((await f.repository.readUsage(0)).lifetime.requestCount).toBe(2)
})
