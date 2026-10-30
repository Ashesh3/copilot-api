import { afterEach, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createBackupStream } from "~/lib/config-backup"
import { createHistoryRepository } from "~/lib/storage/history-repository"
import {
  applyLegacyImport,
  previewLegacyImport,
} from "~/lib/storage/legacy-import"
import { migrateStorage } from "~/lib/storage/migrations"
import { repairUsageTokenCounters } from "~/lib/storage/migrations/010-usage-token-counters"
import { codexReasoningPreferencesMigration } from "~/lib/storage/migrations/011-codex-reasoning-preferences"
import { restoreBackup } from "~/lib/storage/restore"
import { storageMigrations, storageSchema } from "~/lib/storage/schema"

import { createSchemaFixture, faultStorage } from "./helpers/storage-schema"
import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const fixtures: Array<Awaited<ReturnType<typeof createSchemaFixture>>> = []
const NOW = Date.UTC(2026, 9, 12, 12)
const DAY = 86400_000

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

async function legacySchema(version = 9) {
  const value = await createSchemaFixture()
  fixtures.push(value)
  await value.storage.transaction(async (session) => {
    for (const migration of storageMigrations.slice(0, version)) {
      for (const sql of migration.statements)
        await session.execute({ sql, args: [] })
      await session.execute({
        sql: "INSERT INTO capi_schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,1)",
        args: [
          migration.version,
          migration.name,
          createHash("sha256").update(JSON.stringify(migration)).digest("hex"),
        ],
      })
    }
    for (const [key, entry] of [
      ["schema_version", String(version)],
      ["store_id", randomUUID()],
      ...storageSchema(version).counterKeys.map((key) => [key, "0"]),
    ])
      await session.execute({
        sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
        args: [key, entry],
      })
  })
  return value.storage
}

test("upgrade discards corrupt token components and rebuilds only invalid lifetime input before pruning", async () => {
  const storage = await legacySchema()
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(?,'bad-input',18014398509482005,11,2),(?,'valid',7,13,3),(?,'bad-output',17,9007199254740991,4),(?,'old',19,23,1)",
      args: [NOW, NOW, NOW, NOW - 2 * DAY],
    },
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=2783224569714966016,output_tokens=198569,request_count=1245,first_request_at=? WHERE id=1",
      args: [NOW - 2 * DAY],
    },
  ])
  await migrateStorage(storage)
  const repository = createHistoryRepository(storage)
  expect(await repository.readUsageTotals(0)).toEqual({
    window: { inputTokens: 43, outputTokens: 47, requests: 10 },
    lifetime: {
      inputTokens: 43,
      outputTokens: 198569,
      requestCount: 1245,
      firstRequestAt: NOW - 2 * DAY,
    },
  })
  const gaps = await storage.read((session) =>
    session.query({
      sql: "SELECT payload_json FROM capi_collection_gaps",
      args: [],
    }),
  )
  expect(gaps).toHaveLength(1)
  expect(JSON.parse(String(gaps[0].payload_json))).toMatchObject({
    historyKind: "usage",
    reason: "invalid-token-counters",
    recovery: "retained-valid-token-minimum",
    originalLifetimeInputTokens: "2783224569714966016",
    originalLifetimeOutputTokens: "198569",
    invalidInputBuckets: 1,
    invalidOutputBuckets: 1,
  })
  expect(String(gaps[0].payload_json)).not.toContain("bad-input")
  await repository.prune(NOW)
  expect((await repository.readUsageTotals(0)).lifetime.inputTokens).toBe(43)
  await migrateStorage(storage)
  expect((await repository.collectionStatus()).unknownGaps).toBe(1)
})

test("repeated combined-overflow repairs do not duplicate the same audit", async () => {
  const storage = await legacySchema(5)
  await storage.atomicBatch([
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=9007199254740980,output_tokens=20,request_count=1 WHERE id=1",
      args: [],
    },
  ])
  await migrateStorage(storage)
  const repository = createHistoryRepository(storage)
  expect((await repository.collectionStatus()).unknownGaps).toBe(1)
  await storage.transaction(repairUsageTokenCounters)
  expect((await repository.collectionStatus()).unknownGaps).toBe(1)
})

test("healthy upgrade preserves lifetime history and adds no collection gap", async () => {
  const storage = await legacySchema()
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(?,'valid',7,11,1)",
      args: [NOW],
    },
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=700,output_tokens=1100,request_count=100,first_request_at=? WHERE id=1",
      args: [NOW - 2 * DAY],
    },
  ])
  const repository = createHistoryRepository(storage)
  const before = await repository.readUsageTotals(0)
  await migrateStorage(storage)
  await migrateStorage(storage)
  expect(await repository.readUsageTotals(0)).toEqual(before)
  expect((await repository.collectionStatus()).unknownGaps).toBe(0)
})

test("REAL and text counter corruption preserves the valid lifetime side and request counts", async () => {
  const storage = await legacySchema()
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(?,'fraction',0.5,7,1),(?,'text',11,'invalid',1),(?,'infinity',1e999,13,1)",
      args: [NOW, NOW, NOW],
    },
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=1234,output_tokens=9007199254740991,request_count=300,first_request_at=? WHERE id=1",
      args: [NOW - DAY],
    },
  ])
  await migrateStorage(storage)
  const repository = createHistoryRepository(storage)
  expect(await repository.readUsageTotals(0)).toEqual({
    window: { inputTokens: 11, outputTokens: 20, requests: 3 },
    lifetime: {
      inputTokens: 1234,
      outputTokens: 20,
      requestCount: 300,
      firstRequestAt: NOW - DAY,
    },
  })
  expect((await repository.collectionStatus()).unknownGaps).toBe(1)
})

test("fresh schema needs no counter recovery and remains idempotent", async () => {
  const value = await createSchemaFixture()
  fixtures.push(value)
  await migrateStorage(value.storage)
  await migrateStorage(value.storage)
  const repository = createHistoryRepository(value.storage)
  expect((await repository.readUsageTotals(0)).lifetime).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    firstRequestAt: null,
  })
  expect((await repository.collectionStatus()).unknownGaps).toBe(0)
})

test("schema nine backup restores repair sentinels before retaining current detail", async () => {
  const source = await legacySchema()
  // The current exporter reads current tables. An empty preference table emits
  // no frames, preserving the schema-nine backup payload under test without
  // running the counter repair that this restore test is meant to exercise.
  await source.atomicBatch(
    codexReasoningPreferencesMigration.statements.map((sql) => ({
      sql,
      args: [],
    })),
  )
  const now = Math.floor(Date.now() / 60_000) * 60_000
  await source.atomicBatch([
    {
      sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(?,'bad',9007199254740991,7,1),(?,'old',11,13,1)",
      args: [now, now - 2 * DAY],
    },
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=9007199254740991,output_tokens=200,request_count=30,first_request_at=? WHERE id=1",
      args: [now - 2 * DAY],
    },
  ])
  const backup = await streamBytes(
    createBackupStream("fixture-password", undefined, source),
  )
  await withTransferStorage(async (target) => {
    expect(
      (await restoreBackup(bytesStream(backup), "fixture-password", target))
        .phase,
    ).toBe("complete")
    const repository = createHistoryRepository(target)
    expect(await repository.readUsageTotals(0)).toEqual({
      window: { inputTokens: 0, outputTokens: 7, requests: 1 },
      lifetime: {
        inputTokens: 11,
        outputTokens: 200,
        requestCount: 30,
        firstRequestAt: now - 2 * DAY,
      },
    })
    expect((await repository.collectionStatus()).unknownGaps).toBe(1)
  })
})

test("legacy sentinel imports preserve valid counters and record unavailable historical input", async () => {
  await withTransferStorage(async (target, directory) => {
    const now = Math.floor(Date.now() / 60_000) * 60_000
    await writeFile(
      join(directory, "usage.json"),
      JSON.stringify({
        version: 2,
        buckets: [
          {
            timestamp: now,
            model: "bad",
            inputTokens: Number.MAX_SAFE_INTEGER,
            outputTokens: 7,
            requestCount: 1,
          },
          {
            timestamp: now - 2 * DAY,
            model: "old",
            inputTokens: 11,
            outputTokens: 13,
            requestCount: 1,
          },
        ],
        lifetime: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 200,
          requestCount: 30,
          firstRequestAt: now - 2 * DAY,
        },
      }),
    )
    const input = { directory, includeEnvironment: false }
    const preview = await previewLegacyImport(input, target)
    expect((await applyLegacyImport(input, preview, target)).phase).toBe(
      "complete",
    )
    const repository = createHistoryRepository(target)
    expect(await repository.readUsageTotals(0)).toEqual({
      window: { inputTokens: 0, outputTokens: 7, requests: 1 },
      lifetime: {
        inputTokens: 11,
        outputTokens: 200,
        requestCount: 30,
        firstRequestAt: now - 2 * DAY,
      },
    })
    expect((await repository.collectionStatus()).unknownGaps).toBe(1)
  })
})

test("schema five upgrades recover retained history before the old retention migration prunes it", async () => {
  const storage = await legacySchema(5)
  const old = Math.floor(Date.now() / 60_000) * 60_000 - 2 * DAY
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(?,'old',29,31,1)",
      args: [old],
    },
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=9007199254740991,output_tokens=9007199254740991,request_count=80,first_request_at=? WHERE id=1",
      args: [old],
    },
  ])
  await migrateStorage(storage)
  expect(await createHistoryRepository(storage).readUsageTotals(0)).toEqual({
    window: { inputTokens: 0, outputTokens: 0, requests: 0 },
    lifetime: {
      inputTokens: 29,
      outputTokens: 31,
      requestCount: 80,
      firstRequestAt: old,
    },
  })
})

test("counter repair rolls back with migration failure and records one gap after retry", async () => {
  const storage = await legacySchema()
  await storage.atomicBatch([
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=9007199254740991,output_tokens=7,request_count=1,first_request_at=1 WHERE id=1",
      args: [],
    },
  ])
  try {
    await migrateStorage(
      faultStorage(storage, {
        beforeCommit: () => {
          throw new Error("injected migration failure")
        },
      }),
    )
    throw new Error("Expected migration failure")
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("injected migration failure")
  }
  const state = await storage.read(async (session) => ({
    lifetime: await session.query({
      sql: "SELECT input_tokens FROM capi_usage_lifetime",
      args: [],
    }),
    gaps: await session.query({
      sql: "SELECT id FROM capi_collection_gaps",
      args: [],
    }),
    version: await session.query({
      sql: "SELECT value FROM capi_metadata WHERE key='schema_version'",
      args: [],
    }),
  }))
  expect(state).toEqual({
    lifetime: [{ input_tokens: Number.MAX_SAFE_INTEGER }],
    gaps: [],
    version: [{ value: "9" }],
  })
  await migrateStorage(storage)
  await migrateStorage(storage)
  const repository = createHistoryRepository(storage)
  expect((await repository.readUsageTotals(0)).lifetime).toEqual({
    inputTokens: 0,
    outputTokens: 7,
    requestCount: 1,
    firstRequestAt: 1,
  })
  expect((await repository.collectionStatus()).unknownGaps).toBe(1)
})

test("repair audit retains numeric evidence without copying malformed lifetime text", async () => {
  const storage = await legacySchema()
  await storage.atomicBatch([
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens='private-fixture-content',output_tokens=7,request_count=1 WHERE id=1",
      args: [],
    },
  ])
  await migrateStorage(storage)
  const rows = await storage.read((session) =>
    session.query({
      sql: "SELECT payload_json FROM capi_collection_gaps",
      args: [],
    }),
  )
  expect(rows).toHaveLength(1)
  expect(String(rows[0].payload_json)).not.toContain("private-fixture-content")
  expect(JSON.parse(String(rows[0].payload_json))).toMatchObject({
    originalLifetimeInputTokens: "invalid:text",
    originalLifetimeOutputTokens: "7",
  })
})

test("individually valid buckets with an overflowing sum retain a representable prefix", async () => {
  const storage = await legacySchema()
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES(?,'a',9007199254740980,3,1),(?,'b',20,7,1),(?,'c',2,11,1)",
      args: [NOW, NOW, NOW],
    },
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=9007199254741002,output_tokens=200,request_count=30,first_request_at=? WHERE id=1",
      args: [NOW - DAY],
    },
  ])
  await migrateStorage(storage)
  const repository = createHistoryRepository(storage)
  expect(await repository.readUsageTotals(0)).toMatchObject({
    window: { inputTokens: 9007199254740980, outputTokens: 21, requests: 3 },
    lifetime: {
      inputTokens: 9007199254740980,
      outputTokens: 200,
      requestCount: 30,
    },
  })
  expect((await repository.collectionStatus()).unknownGaps).toBe(1)
  await migrateStorage(storage)
  expect((await repository.collectionStatus()).unknownGaps).toBe(1)
})

test("combined lifetime overflow keeps independently valid input and output", async () => {
  const storage = await legacySchema()
  await storage.atomicBatch([
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=9007199254740980,output_tokens=20,request_count=1 WHERE id=1",
      args: [],
    },
  ])
  await migrateStorage(storage)
  const repository = createHistoryRepository(storage)
  expect((await repository.readUsageTotals(0)).lifetime).toMatchObject({
    inputTokens: 9007199254740980,
    outputTokens: 20,
    requestCount: 1,
  })
  expect((await repository.collectionStatus()).unknownGaps).toBe(1)
})
