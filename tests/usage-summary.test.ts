import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SqlSession, Storage } from "~/lib/storage/types"
import type { HistoryRecord } from "~/lib/telemetry-writer"

import { StorageCommitUnknownError } from "~/lib/storage/errors"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import { createHistoryRuntime } from "~/lib/telemetry-writer"
import {
  enableDatabaseUsageForTest,
  getUsageResponse,
  recordUsage,
  resetUsageForTest,
} from "~/lib/usage-tracker"

const MINUTE = 60_000
const DAY = 86400_000
const NOW = Date.UTC(2026, 8, 11, 12, 0, 30)
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "capi-usage-summary-"))
  const underlying = new LocalSqliteStorage(join(directory, "fixture.sqlite"))
  await migrateStorage(underlying)
  const reads: Array<{ sql: string; rows: number }> = []
  let loseCommit = false
  const observe = (session: SqlSession): SqlSession => ({
    async query(statement) {
      const rows = await session.query(statement)
      reads.push({ sql: statement.sql, rows: rows.length })
      return rows
    },
    execute: (statement) => session.execute(statement),
  })
  const storage: Storage = {
    read: (work) => underlying.read((session) => work(observe(session))),
    async transaction(work) {
      const value = await underlying.transaction(work)
      if (loseCommit) {
        loseCommit = false
        throw new StorageCommitUnknownError()
      }
      return value
    },
    atomicBatch: (statements) => underlying.atomicBatch(statements),
    close: () => underlying.close(),
  }
  const now = spyOn(Date, "now").mockReturnValue(NOW)
  enableDatabaseUsageForTest()
  const history = await createHistoryRuntime(storage, { autoFlush: false })
  cleanup.push(async () => {
    await history.close(1000)
    now.mockRestore()
    await underlying.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    storage,
    history,
    reads,
    loseNextCommit: () => {
      loseCommit = true
    },
  }
}

function usage(at: number, tokens: number, model = "model-a"): HistoryRecord {
  return {
    id: `${at}-${tokens}-${model}`,
    kind: "usage",
    generation: 0,
    recordedAt: at,
    payload: {
      timestamp: Math.floor(at / MINUTE) * MINUTE,
      model,
      inputTokens: tokens,
      outputTokens: tokens * 2,
      requestCount: 1,
      firstRequestAt: at,
    },
  }
}

test("usage totals preserve inclusive minute boundaries, future buckets and lifetime while materializing only summaries", async () => {
  const f = await fixture()
  const cutoff = NOW - 30_000 - DAY
  await f.history.repository.applyBatch("boundaries", [
    usage(cutoff - 1, 1),
    usage(cutoff, 2),
    usage(cutoff + 1, 4, "other-model"),
    usage(NOW - MINUTE, 8),
    usage(NOW, 16),
    usage(NOW + DAY, 32),
  ])
  f.reads.length = 0
  const value = await getUsageResponse()
  expect(value).toMatchObject({
    twenty_four_hour: {
      tokens_used: 186,
      request_count: 5,
      total_input_tokens: 62,
      total_output_tokens: 124,
    },
    lifetime: {
      total_input_tokens: 63,
      total_output_tokens: 126,
      total_tokens: 189,
      total_requests: 6,
      first_request_at: Math.floor((cutoff - 1) / 1000),
    },
  })
  expect(Object.keys(value).sort()).toEqual([
    "collection",
    "lifetime",
    "twenty_four_hour",
  ])
  expect(f.reads.reduce((sum, read) => sum + read.rows, 0)).toBeLessThanOrEqual(
    3,
  )
})

test("queued and committed-on-lost-ack usage contributes exactly once before and after retry", async () => {
  const f = await fixture()
  f.history.writer.enqueue(usage(NOW, 3))
  f.loseNextCommit()
  await f.history.writer.flush()
  expect(f.history.writer.status().pendingRecords).toBe(1)
  f.history.writer.enqueue(usage(NOW - 8 * DAY, 5))
  f.history.writer.enqueue(usage(NOW, 7, "model-b"))
  const before = await getUsageResponse()
  expect(before).toMatchObject({
    twenty_four_hour: {
      tokens_used: 30,
      request_count: 2,
      total_input_tokens: 10,
      total_output_tokens: 20,
    },
    lifetime: {
      total_input_tokens: 15,
      total_output_tokens: 30,
      total_requests: 3,
      first_request_at: Math.floor((NOW - 8 * DAY) / 1000),
    },
  })
  await f.history.writer.flush()
  expect(f.history.writer.status().pendingRecords).toBe(0)
  const after = await getUsageResponse()
  expect(after.twenty_four_hour).toEqual(before.twenty_four_hour)
  expect(after.lifetime).toEqual(before.lifetime)
})

test("empty database and explicit memory fixtures retain zero and recorded-usage responses", async () => {
  await fixture()
  const empty = await getUsageResponse()
  expect(empty).toMatchObject({
    twenty_four_hour: {
      tokens_used: 0,
      request_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
    },
    lifetime: { total_tokens: 0, total_requests: 0, first_request_at: null },
  })
  resetUsageForTest()
  try {
    recordUsage(7, 11, "memory-model")
    expect(await getUsageResponse()).toMatchObject({
      twenty_four_hour: {
        tokens_used: 18,
        request_count: 1,
        total_input_tokens: 7,
        total_output_tokens: 11,
      },
      lifetime: {
        total_input_tokens: 7,
        total_output_tokens: 11,
        total_requests: 1,
      },
    })
  } finally {
    enableDatabaseUsageForTest()
  }
})
