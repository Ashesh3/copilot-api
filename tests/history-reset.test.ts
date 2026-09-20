/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited at runtime. */
import { afterEach, expect, test } from "bun:test"

import type { JsonValue, MutationContext, Storage } from "~/lib/storage/types"
import type { HistoryRecord } from "~/lib/telemetry-writer"

import { createBackupStream } from "~/lib/config-backup"
import {
  StorageCommitUnknownError,
  StorageConflictError,
  StorageSchemaError,
  StorageUnavailableError,
} from "~/lib/storage/errors"
import { createHistoryRepository } from "~/lib/storage/history-repository"
import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { migrateStorage } from "~/lib/storage/migrations"
import { getStoreRevision } from "~/lib/storage/operations"
import { discardIncompleteTransfer, restoreBackup } from "~/lib/storage/restore"
import { completeTransferRecord } from "~/lib/storage/transfer-records"

import { createSchemaFixture, faultStorage } from "./helpers/storage-schema"
import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const NOW = 1_800_000_030_123
const EMPTY_LOSS = { knownLostRecords: 0, knownLostBytes: 0, unknownGaps: 0 }
const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  requestCount: 0,
  firstRequestAt: null,
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture() {
  const value = await createSchemaFixture()
  cleanup.push(() => value.close())
  await migrateStorage(value.storage)
  return {
    ...value,
    repository: createHistoryRepository(value.storage, { now: () => NOW }),
  }
}

function context(
  operationId = "reset-1",
  expectedRevision = 0,
): MutationContext {
  return {
    operationId,
    expectedRevision,
    actorId: "verified-admin",
    kind: "caller-supplied-kind",
    inputDigest: "caller-supplied-digest",
  }
}

function payload(kind: HistoryRecord["kind"], recordedAt: number): JsonValue {
  const timestamp = Math.floor(recordedAt / 60_000) * 60_000
  if (kind === "usage")
    return {
      timestamp,
      model: "fixture-model",
      inputTokens: 7,
      outputTokens: 11,
      requestCount: 1,
      firstRequestAt: recordedAt,
    }
  if (kind === "routing")
    return {
      timestamp,
      totals: { requests: 1, upstreamCalls: 2 },
      accounts: { "1": { newAssignments: 1 } },
    }
  return { unknown: true, reason: "expired-unconfirmed-batch" }
}

function record(
  kind: HistoryRecord["kind"],
  recordedAt: number,
  id = `${kind}-${recordedAt}`,
): HistoryRecord {
  return {
    id,
    kind,
    recordedAt,
    generation: 0,
    payload: payload(kind, recordedAt),
  }
}

function rows(storage: Storage, sql: string) {
  return storage.read((session) => session.query({ sql, args: [] }))
}

test("reset clears durable usage, routing and archived losses across restart", async () => {
  const f = await fixture()
  expect(await f.repository.resetState()).toBeNull()
  await f.repository.applyBatch("prior", [
    record("usage", NOW - 1),
    record("routing", NOW - 1),
    record("collection-gap", NOW - 1),
  ])
  await f.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_metadata(key,value) VALUES('history_collection_lifetime',?)",
      args: ['{"knownLostRecords":9,"knownLostBytes":200,"unknownGaps":3}'],
    },
  ])
  expect(await f.repository.reset(context())).toEqual({
    resetAt: NOW,
    revision: 1,
  })
  await f.storage.close()
  const reopened = new LocalSqliteStorage(f.path)
  try {
    const repository = createHistoryRepository(reopened)
    expect(await repository.resetState()).toEqual({ resetAt: NOW, revision: 1 })
    expect(await repository.readUsage(0)).toEqual({
      buckets: [],
      lifetime: EMPTY_USAGE,
    })
    expect(await repository.readRouting(0)).toEqual({
      buckets: [],
      lifetime: {},
      startedAt: null,
    })
    expect(await repository.collectionStatus()).toEqual(EMPTY_LOSS)
    expect(await rows(reopened, "SELECT id FROM capi_collection_gaps")).toEqual(
      [],
    )
  } finally {
    await reopened.close()
  }
})

test("reset filters old pending overlays and raw writes without losing fresh events in the same minute", async () => {
  const f = await fixture()
  const old = [record("usage", NOW - 1), record("routing", NOW)]
  const fresh = [record("usage", NOW + 1), record("routing", NOW + 1)]
  const remoteStorage = new LocalSqliteStorage(f.path)
  try {
    const remote = createHistoryRepository(remoteStorage)
    await f.repository.reset(context())
    const pending = [...old, ...fresh].map((item) => ({ record: item }))
    expect((await remote.readUsageTotals(0, pending)).lifetime).toEqual({
      inputTokens: 7,
      outputTokens: 11,
      requestCount: 1,
      firstRequestAt: NOW + 1,
    })
    expect((await remote.readUsage(0, pending)).buckets).toHaveLength(1)
    expect((await remote.readRouting(0, pending)).lifetime).toEqual({
      requests: 1,
      upstreamCalls: 2,
    })
    await remote.applyBatch("mixed-retry", [...old, ...fresh])
    await remote.applyBatch("mixed-retry", [...old, ...fresh])
    const usage = await f.repository.readUsage(0)
    expect(usage.lifetime.requestCount).toBe(1)
    expect(usage.buckets).toHaveLength(1)
    expect(usage.buckets[0]?.timestamp).toBe(1_800_000_000_000)
    expect((await f.repository.readRouting(0)).lifetime).toEqual({
      requests: 1,
      upstreamCalls: 2,
    })
    expect(
      (
        await remote.readUsageTotals(
          0,
          pending.map((item) => ({
            ...item,
            batchId: "mixed-retry",
          })),
        )
      ).lifetime.requestCount,
    ).toBe(1)
  } finally {
    await remoteStorage.close()
  }
})

test("delayed loss detection cannot restore cleared gaps while new loss remains visible", async () => {
  const f = await fixture()
  await f.repository.reset(context())
  const oldGap: HistoryRecord = {
    ...record("collection-gap", NOW + 100, "old-gap"),
    payload: { lastRecordAt: NOW, lostRecords: 4, lostBytes: 80 },
  }
  const freshGap: HistoryRecord = {
    ...record("collection-gap", NOW + 100, "fresh-gap"),
    payload: { lastRecordAt: NOW + 1, lostRecords: 2, lostBytes: 40 },
  }
  const unknown = record("collection-gap", NOW + 1, "new-unknown")
  const pending = [oldGap, freshGap, unknown].map((item) => ({ record: item }))
  expect(await f.repository.collectionStatus({}, pending)).toEqual({
    knownLostRecords: 2,
    knownLostBytes: 40,
    unknownGaps: 1,
  })
  await f.repository.applyBatch("delayed-loss", [oldGap, freshGap, unknown])
  expect(await f.repository.collectionStatus()).toEqual({
    knownLostRecords: 2,
    knownLostBytes: 40,
    unknownGaps: 1,
  })
})

test("current reset generation keeps immediate same-millisecond records while older generations stay cleared", async () => {
  const f = await fixture()
  await f.repository.reset(context())
  const current = { ...record("usage", NOW, "current"), generation: 1 }
  const prior = record("usage", NOW, "prior")
  const pending = [current, prior].map((item) => ({ record: item }))
  expect(
    (await f.repository.readUsageTotals(0, pending)).lifetime.requestCount,
  ).toBe(1)
  await f.repository.applyBatch("same-millisecond", [current, prior])
  expect((await f.repository.readUsageTotals(0)).lifetime.requestCount).toBe(1)
  await f.repository.reset(context("reset-2", 1))
  expect(
    (await f.repository.readUsageTotals(0, pending)).lifetime.requestCount,
  ).toBe(0)
})

test("loss intervals crossing a remote reset become unknown without rewriting retry records", async () => {
  const f = await fixture()
  await f.repository.reset(context())
  const mixed: HistoryRecord = {
    ...record("collection-gap", NOW + 100, "mixed-gap"),
    payload: {
      historyKind: "usage",
      firstRecordAt: NOW - 1,
      lastRecordAt: NOW + 1,
      lostRecords: 7,
      lostBytes: 140,
      discardedRecords: 7,
    },
  }
  const original = structuredClone(mixed)
  expect(await f.repository.collectionStatus({}, [{ record: mixed }])).toEqual({
    knownLostRecords: 0,
    knownLostBytes: 0,
    unknownGaps: 1,
  })
  await f.repository.applyBatch("mixed-gap-batch", [mixed])
  await f.repository.applyBatch("mixed-gap-batch", [mixed])
  expect(mixed).toEqual(original)
  expect(await f.repository.collectionStatus()).toEqual({
    knownLostRecords: 0,
    knownLostBytes: 0,
    unknownGaps: 1,
  })
  const stored = await rows(
    f.storage,
    "SELECT payload_json FROM capi_collection_gaps WHERE id='mixed-gap'",
  )
  expect(JSON.parse(String(stored[0]?.payload_json))).toEqual({
    historyKind: "usage",
    firstRecordAt: NOW - 1,
    lastRecordAt: NOW + 1,
    unknown: true,
    reason: "reset-overlapping-collection-gap",
  })
})

test("known current-generation gap counts stay exact across the same reset timestamp", async () => {
  const f = await fixture()
  await f.repository.reset(context())
  await f.repository.applyBatch("current-gap-batch", [
    {
      ...record("collection-gap", NOW + 100, "current-gap"),
      generation: 1,
      payload: {
        firstRecordAt: NOW,
        lastRecordAt: NOW + 1,
        lostRecords: 2,
        lostBytes: 40,
        discardedRecords: 2,
      },
    },
  ])
  expect(await f.repository.collectionStatus()).toEqual({
    knownLostRecords: 2,
    knownLostBytes: 40,
    unknownGaps: 0,
  })
})

test("raw records without a payload timestamp keep their distinct minute buckets", async () => {
  const f = await fixture()
  const raw: Array<HistoryRecord> = [NOW, NOW + 60_000].map((recordedAt) => ({
    ...record("usage", recordedAt),
    payload: { inputTokens: 7, outputTokens: 11, requestCount: 1 },
  }))
  await f.repository.applyBatch("raw-minute-fallback", raw)
  expect((await f.repository.readUsage(0)).buckets).toEqual([
    {
      timestamp: 1_800_000_000_000,
      inputTokens: 7,
      outputTokens: 11,
      requestCount: 1,
    },
    {
      timestamp: 1_800_000_060_000,
      inputTokens: 7,
      outputTokens: 11,
      requestCount: 1,
    },
  ])
})

test("replaying a reset keeps fresh data and prior history receipts", async () => {
  const f = await fixture()
  const old = record("usage", NOW - 1)
  await f.repository.applyBatch("old-committed", [old])
  const first = await f.repository.reset(context())
  await f.repository.applyBatch("fresh", [record("usage", NOW + 1)])
  await f.repository.applyBatch("old-committed", [old])
  expect(await f.repository.reset(context())).toEqual(first)
  expect((await f.repository.readUsageTotals(0)).lifetime.requestCount).toBe(1)
  expect(await getStoreRevision(f.storage)).toBe(1)
  expect(
    await rows(
      f.storage,
      "SELECT id FROM capi_applied_operations WHERE kind='history_batch' ORDER BY id",
    ),
  ).toEqual([{ id: "fresh" }, { id: "old-committed" }])
  await expect(
    f.repository.reset({ ...context(), actorId: "another-admin" }),
  ).rejects.toBeInstanceOf(StorageConflictError)
})

test("separate resets in one millisecond advance identity and never move the time boundary backwards", async () => {
  const f = await fixture()
  await f.repository.reset(context())
  const repository = createHistoryRepository(f.storage, { now: () => NOW - 1 })
  expect(await repository.reset(context("reset-2", 1))).toEqual({
    resetAt: NOW,
    revision: 2,
  })
})

test("failed reset rolls back counters, gaps, leases, metadata and revision", async () => {
  const f = await fixture()
  await f.repository.applyBatch("before", [
    record("usage", NOW - 1),
    record("collection-gap", NOW - 1),
  ])
  await f.repository.startRun("open-run", NOW)
  const failing = createHistoryRepository(
    faultStorage(f.storage, {
      beforeCommit: () => {
        throw new Error("injected reset failure")
      },
    }),
    { now: () => NOW },
  )
  await expect(failing.reset(context())).rejects.toThrow(
    "injected reset failure",
  )
  expect((await f.repository.readUsageTotals(0)).lifetime.requestCount).toBe(1)
  expect((await f.repository.collectionStatus()).unknownGaps).toBe(1)
  expect(await f.repository.resetState()).toBeNull()
  expect(await getStoreRevision(f.storage)).toBe(0)
  expect(
    await rows(f.storage, "SELECT clean,ended_at FROM capi_process_runs"),
  ).toEqual([{ clean: 0, ended_at: null }])
})

test("lost reset acknowledgement reconciles its receipt without clearing newer telemetry", async () => {
  const f = await fixture()
  let unavailable = true
  const unknown = createHistoryRepository(
    faultStorage(f.storage, {
      afterCommit: () => {
        throw new StorageCommitUnknownError()
      },
      beforeRead: () => {
        if (unavailable) throw new StorageUnavailableError()
      },
    }),
    { now: () => NOW },
  )
  await expect(unknown.reset(context())).rejects.toBeInstanceOf(
    StorageCommitUnknownError,
  )
  await f.repository.applyBatch("new-traffic", [record("usage", NOW + 1)])
  unavailable = false
  expect(await unknown.reset(context())).toEqual({ resetAt: NOW, revision: 1 })
  expect((await f.repository.readUsageTotals(0)).lifetime.requestCount).toBe(1)
})

test("reset acknowledges old leases but resumed collectors still report new failures", async () => {
  const f = await fixture()
  await f.repository.startRun("paused", NOW - 400_000)
  const current = createHistoryRepository(f.storage, {
    runId: "current",
    now: () => NOW,
  })
  await current.startRun("current", NOW)
  expect((await current.collectionStatus()).unknownGaps).toBe(1)
  await current.reset(context())
  await current.heartbeatRun("current", NOW + 1)
  expect(await current.collectionStatus()).toEqual(EMPTY_LOSS)
  expect(
    await rows(
      f.storage,
      "SELECT id,clean,ended_at FROM capi_process_runs ORDER BY id",
    ),
  ).toEqual([
    { id: "current", clean: 0, ended_at: null },
    { id: "paused", clean: 0, ended_at: NOW },
  ])
  const resumed = createHistoryRepository(f.storage, {
    runId: "paused",
    now: () => NOW + 10,
  })
  await resumed.applyBatch("resumed", [record("usage", NOW + 10)])
  expect(
    await rows(
      f.storage,
      "SELECT ended_at FROM capi_process_runs WHERE id='paused'",
    ),
  ).toEqual([{ ended_at: null }])
  await current.heartbeatRun("current", NOW + 300_011)
  expect((await current.collectionStatus()).unknownGaps).toBe(1)
})

test("reset keeps live peer collectors monitored from the new collection period", async () => {
  const f = await fixture()
  await f.repository.startRun("live-peer", NOW - 299_999)
  await f.repository.startRun("lease-boundary-peer", NOW - 300_000)
  const current = createHistoryRepository(f.storage, {
    runId: "current",
    now: () => NOW,
  })
  await current.startRun("current", NOW)
  await current.reset(context())
  expect(await current.collectionStatus()).toEqual(EMPTY_LOSS)
  expect(
    await rows(
      f.storage,
      "SELECT started_at,last_flush_at,ended_at,json_extract(payload_json,'$.heartbeatAt') AS heartbeat FROM capi_process_runs WHERE id='live-peer'",
    ),
  ).toEqual([
    {
      started_at: NOW,
      last_flush_at: null,
      ended_at: null,
      heartbeat: NOW,
    },
  ])
  await current.heartbeatRun("current", NOW + 300_001)
  expect(await current.collectionStatus()).toEqual({
    knownLostRecords: 0,
    knownLostBytes: 0,
    unknownGaps: 2,
  })
  expect(
    await rows(
      f.storage,
      "SELECT started_at,ended_at FROM capi_collection_gaps ORDER BY id",
    ),
  ).toEqual([
    { started_at: NOW, ended_at: NOW + 300_000 },
    { started_at: NOW, ended_at: NOW + 300_000 },
  ])
})

test("reset preserves account ownership, credentials, settings and non-history receipts", async () => {
  const f = await fixture()
  await f.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_accounts(id,domain,created_at,updated_at) VALUES(1,'github.com',1,1)",
      args: [],
    },
    {
      sql: "INSERT INTO capi_account_credentials(account_id,oauth_value,updated_at) VALUES(1,'fixture-credential',1)",
      args: [],
    },
    {
      sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app','{}',0)",
      args: [],
    },
    {
      sql: "INSERT INTO capi_account_distribution(id,version) VALUES(1,1)",
      args: [],
    },
    {
      sql: "INSERT INTO capi_account_allocations(account_id,percentage) VALUES(1,100)",
      args: [],
    },
    {
      sql: "INSERT INTO capi_conversation_accounts(conversation_key,account_id) VALUES(?,1)",
      args: [Buffer.alloc(32, 7)],
    },
    {
      sql: "INSERT INTO capi_account_scheduler(scope,version,credits_json) VALUES('scope',1,'{}')",
      args: [],
    },
    {
      sql: "INSERT INTO capi_applied_operations(id,kind,actor_id,input_digest,committed_revision,result_json,created_at) VALUES('configuration','settings.replace','admin','digest',0,'{}',1)",
      args: [],
    },
  ])
  const tables = [
    "capi_accounts",
    "capi_account_credentials",
    "capi_settings",
    "capi_account_distribution",
    "capi_account_allocations",
    "capi_conversation_accounts",
    "capi_account_scheduler",
  ]
  const before = await Promise.all(
    tables.map((table) => rows(f.storage, `SELECT * FROM ${table}`)),
  )
  await f.repository.reset(context())
  expect(
    await Promise.all(
      tables.map((table) => rows(f.storage, `SELECT * FROM ${table}`)),
    ),
  ).toEqual(before)
  expect(
    await rows(
      f.storage,
      "SELECT id FROM capi_applied_operations WHERE id='configuration'",
    ),
  ).toEqual([{ id: "configuration" }])
})

test("reset boundary survives encrypted backup restore", async () => {
  const f = await fixture()
  await f.repository.reset(context())
  const archive = await streamBytes(
    createBackupStream("fixture-reset-password", undefined, f.storage),
  )
  await withTransferStorage(async (target) => {
    await restoreBackup(bytesStream(archive), "fixture-reset-password", target)
    const restored = createHistoryRepository(target)
    expect(await restored.resetState()).toEqual({ resetAt: NOW, revision: 1 })
    await restored.applyBatch("late-backup-record", [record("usage", NOW)])
    expect((await restored.readUsageTotals(0)).lifetime.requestCount).toBe(0)
  })
})

test.each([
  "{}",
  "null",
  "[]",
  '{"resetAt":-1,"revision":1}',
  '{"resetAt":1,"revision":0}',
  '{"resetAt":"1","revision":1}',
  '{"resetAt":1,"revision":1.5}',
  '{"resetAt":9007199254740992,"revision":1}',
  '{"resetAt":1,"revision":1,"extra":"unwanted"}',
])("transfer rejects malformed reset metadata %s", (value) => {
  expect(() =>
    completeTransferRecord("capi_metadata", {
      key: "history_usage_reset",
      value,
    }),
  ).toThrow(StorageSchemaError)
})

test("discarding incomplete restore removes its reset boundary", async () => {
  const f = await fixture()
  const id = "12345678-1234-1234-1234-123456789abc"
  await f.storage.atomicBatch([
    {
      sql: "INSERT INTO capi_metadata(key,value) VALUES('transfer_incomplete',?),('history_usage_reset',?)",
      args: [id, JSON.stringify({ resetAt: NOW, revision: 1 })],
    },
  ])
  await discardIncompleteTransfer(f.storage, id)
  expect(
    await rows(
      f.storage,
      "SELECT key FROM capi_metadata WHERE key='history_usage_reset'",
    ),
  ).toEqual([])
})
