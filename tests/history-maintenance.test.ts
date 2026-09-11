import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SqlSession, Storage } from "~/lib/storage/types"
import type { HistoryRecord } from "~/lib/telemetry-writer"

import { createHistoryRepository } from "~/lib/storage/history-repository"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import {
  createHistoryRuntime,
  createTelemetryWriter,
} from "~/lib/telemetry-writer"

const DAY = 86400_000
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "capi-history-maintenance-"))
  const underlying = new LocalSqliteStorage(join(directory, "fixture.sqlite"))
  await migrateStorage(underlying)
  let prunes = 0
  let failPrune = false
  let now = Date.now()
  const observe = (session: SqlSession): SqlSession => ({
    query: (statement) => session.query(statement),
    execute(statement) {
      if (statement.sql.startsWith("DELETE FROM capi_applied_operations")) {
        prunes++
        if (failPrune) {
          failPrune = false
          throw new Error("injected maintenance failure")
        }
      }
      return session.execute(statement)
    },
  })
  const storage: Storage = {
    read: (work) => underlying.read(work),
    transaction: (work) =>
      underlying.transaction((session) => work(observe(session))),
    atomicBatch: (statements) => underlying.atomicBatch(statements),
    close: () => underlying.close(),
  }
  const history = await createHistoryRuntime(storage, {
    autoFlush: false,
    now: () => now,
  })
  // The startup sweep has its own retention regression; measure subsequent cadence here.
  prunes = 0
  cleanup.push(async () => {
    await history.close(1000)
    await underlying.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    storage,
    history,
    now,
    prunes: () => prunes,
    tick: (milliseconds: number) => {
      now += milliseconds
    },
    failNextPrune: () => {
      failPrune = true
    },
  }
}

function usage(id: string, now: number): HistoryRecord {
  return {
    id,
    kind: "usage",
    generation: 0,
    recordedAt: now,
    payload: {
      timestamp: now,
      inputTokens: 7,
      outputTokens: 11,
      requestCount: 1,
    },
  }
}

test("frequent batches do not repeat retention cleanup and the idle cadence still prunes", async () => {
  const f = await fixture()
  for (let i = 0; i < 4; i++) {
    f.history.writer.enqueue(usage(String(i), f.now))
    await f.history.writer.flush()
  }
  expect(f.prunes()).toBe(0)
  f.tick(30_000)
  await f.history.writer.flush()
  expect(f.prunes()).toBe(1)
  await f.history.writer.flush()
  expect(f.prunes()).toBe(1)
  await f.history.repository.prune(f.now)
  expect(f.prunes()).toBe(2)
})

test("failed maintenance retries before advancing its cadence or losing queued usage", async () => {
  const f = await fixture()
  f.tick(30_000)
  f.failNextPrune()
  f.history.writer.enqueue(usage("during-maintenance", f.now))
  await f.history.writer.flush()
  expect(f.prunes()).toBe(1)
  expect(f.history.writer.status().pendingRecords).toBe(1)
  await f.history.writer.flush()
  expect(f.prunes()).toBe(2)
  expect(f.history.writer.status()).toMatchObject({
    pendingRecords: 0,
    degraded: false,
  })
  expect((await f.history.repository.readUsage(0)).lifetime.requestCount).toBe(
    1,
  )
})

test("prune keeps non-history receipts and the full one-day history replay horizon", async () => {
  const f = await fixture()
  await f.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_applied_operations(id,kind,actor_id,input_digest,committed_revision,result_json,created_at) VALUES ('expired-history','history_batch','fixture','a',0,'{}',?),('boundary-history','history_batch','fixture','b',0,'{}',?),('old-config','settings.replace','fixture','c',0,'{}',?)",
      args: [f.now - DAY - 1, f.now - DAY, f.now - 90 * DAY],
    },
  ])
  await f.history.repository.prune(f.now)
  expect(
    await f.storage.read((session) =>
      session.query({
        sql: "SELECT id FROM capi_applied_operations ORDER BY id",
        args: [],
      }),
    ),
  ).toEqual([{ id: "boundary-history" }, { id: "old-config" }])
})

test("24-hour usage and routing detail expires while lifetime totals remain exact", async () => {
  const f = await fixture()
  const at = Math.floor(f.now / 60_000) * 60_000
  const records = [
    usage("old-lifetime", at - 8 * DAY),
    usage("older-detail", at - 7 * DAY),
    usage("two-day-detail", at - 2 * DAY),
    usage("day-boundary", at - DAY),
    usage("current", at),
  ]
  records.push({
    id: "old-routing",
    kind: "routing",
    generation: 0,
    recordedAt: at - DAY - 60_000,
    payload: { timestamp: at - DAY - 60_000, totals: { requests: 1 } },
  })
  await f.history.repository.applyBatch("retention", records)
  await f.history.repository.prune(f.now)
  expect(
    (await f.history.repository.readUsage(0)).buckets.map(
      (bucket) => bucket.timestamp,
    ),
  ).toEqual([at - DAY, at])
  expect((await f.history.repository.readRouting(0)).buckets).toEqual([])
  expect(await f.history.repository.readUsageTotals(at - DAY)).toMatchObject({
    window: { inputTokens: 14, outputTokens: 22, requests: 2 },
    lifetime: { inputTokens: 35, outputTokens: 55, requestCount: 5 },
  })
  await f.history.repository.applyBatch("retention", records)
  expect(
    (await f.history.repository.readUsageTotals(at - DAY)).window.requests,
  ).toBe(2)
})

test("history expires without retaining a second long-term usage table", async () => {
  const f = await fixture()
  const at = Math.floor(f.now / 60_000) * 60_000
  await f.storage.atomicBatch([
    {
      sql: "WITH RECURSIVE minutes(value) AS (SELECT ? UNION ALL SELECT value + 60000 FROM minutes WHERE value < ?) INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) SELECT value,'fixture',1,2,1 FROM minutes",
      args: [at - 30 * DAY, at],
    },
  ])
  await f.history.repository.prune(f.now)
  expect(
    await f.storage.read((session) =>
      session.query({
        sql: "SELECT COUNT(*) AS count,MIN(minute) AS oldest,MAX(minute) AS newest FROM capi_usage_minutes",
        args: [],
      }),
    ),
  ).toEqual([{ count: 1441, oldest: at - DAY, newest: at }])
  expect(
    await f.storage.read((session) =>
      session.query({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'capi_usage_%' ORDER BY name",
        args: [],
      }),
    ),
  ).toEqual([{ name: "capi_usage_lifetime" }, { name: "capi_usage_minutes" }])
  await f.history.repository.prune(f.now + 2 * DAY)
  expect((await f.history.repository.readUsage(0)).buckets).toEqual([])
})

test("a full queue drain permits timers before every batch completes and retains all counts", async () => {
  const f = await fixture()
  const repository = createHistoryRepository(f.storage)
  let batches = 0
  const writer = createTelemetryWriter(
    {
      ...repository,
      async applyBatch(id, records) {
        await repository.applyBatch(id, records)
        batches++
      },
    },
    { now: Date.now },
    { autoFlush: false },
  )
  try {
    for (let i = 0; i < 2000; i++) writer.enqueue(usage(String(i), f.now))
    const timerObserved = new Promise<number>((resolve) => {
      setTimeout(() => resolve(batches), 0)
    })
    await writer.flush()
    const beforeTimer = await timerObserved
    expect(beforeTimer).toBeGreaterThan(0)
    expect(beforeTimer).toBeLessThan(20)
    expect(writer.status().pendingRecords).toBe(0)
    expect((await repository.readUsage(0)).lifetime.requestCount).toBe(2000)
  } finally {
    await writer.close(1000)
  }
})
