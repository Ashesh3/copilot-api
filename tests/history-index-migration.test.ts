/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun rejection matchers are awaited at runtime. */
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import type { Storage } from "~/lib/storage/types"

import { migrateStorage } from "~/lib/storage/migrations"
import { restoreBackup } from "~/lib/storage/restore"
import { storageMigrations } from "~/lib/storage/schema"

import { createVersionFiveBackup } from "./helpers/history-backup"
import { createSchemaFixture, faultStorage } from "./helpers/storage-schema"
import { bytesStream } from "./helpers/transfer-storage"

const fixtures: Array<Awaited<ReturnType<typeof createSchemaFixture>>> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

async function versionFive(): Promise<Storage> {
  const fixture = await createSchemaFixture()
  fixtures.push(fixture)
  await fixture.storage.transaction(async (session) => {
    for (const migration of storageMigrations.slice(0, 5)) {
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
    for (const [key, value] of [
      ["schema_version", "5"],
      ["store_id", "dfefad84-fac3-483b-9005-c6a54e37079a"],
      ["config_revision", "17"],
    ])
      await session.execute({
        sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
        args: [key, value],
      })
    await session.execute({
      sql: "INSERT INTO capi_applied_operations(id,kind,actor_id,input_digest,committed_revision,result_json,created_at) VALUES ('history','history_batch','fixture','one',0,'{}',1),('config','settings.replace','fixture','two',17,'{}',1)",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app','{\"smallModel\":\"keep\"}',17)",
      args: [],
    })
  })
  return fixture.storage
}

async function receiptState(storage: Storage) {
  return storage.read(async (session) => ({
    metadata: await session.query({
      sql: "SELECT key,value FROM capi_metadata WHERE key IN ('store_id','config_revision') ORDER BY key",
      args: [],
    }),
    receipts: await session.query({
      sql: "SELECT * FROM capi_applied_operations ORDER BY id",
      args: [],
    }),
    settings: await session.query({
      sql: "SELECT * FROM capi_settings",
      args: [],
    }),
    migrations: await session.query({
      sql: "SELECT version,name,checksum FROM capi_schema_migrations WHERE version<=5 ORDER BY version",
      args: [],
    }),
  }))
}

test("schema five upgrades to a selective receipt index while retaining identity, receipts and old migrations", async () => {
  const storage = await versionFive()
  const before = await receiptState(storage)
  await migrateStorage(storage)
  expect(await receiptState(storage)).toEqual(before)
  const plan = await storage.read((session) =>
    session.query({
      sql: "EXPLAIN QUERY PLAN SELECT id FROM capi_applied_operations WHERE kind = 'history_batch' AND created_at < ?",
      args: [2],
    }),
  )
  expect(
    plan.some((row) => String(row.detail).includes("kind=? AND created_at<?")),
  ).toBe(true)
  await migrateStorage(storage)
  expect(await receiptState(storage)).toEqual(before)
})

test("schema five removes expired detail while preserving lifetime totals", async () => {
  const storage = await versionFive()
  const at = Math.floor(Date.now() / 60_000) * 60_000
  await storage.atomicBatch([
    {
      sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES (?,'old',1,2,1),(?,'a',3,6,1),(?,'b',5,10,1),(?,'recent',7,14,1)",
      args: [at - 8 * 86400_000, at - 2 * 86400_000, at - 2 * 86400_000, at],
    },
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=16,output_tokens=32,request_count=4,first_request_at=? WHERE id=1",
      args: [at - 8 * 86400_000],
    },
  ])
  await migrateStorage(storage)
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT model FROM capi_usage_minutes",
        args: [],
      }),
    ),
  ).toEqual([{ model: "recent" }])
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT input_tokens,output_tokens,request_count FROM capi_usage_lifetime",
        args: [],
      }),
    ),
  ).toEqual([{ input_tokens: 16, output_tokens: 32, request_count: 4 }])
})

test("failed index upgrade leaves schema five usable for an atomic retry", async () => {
  const storage = await versionFive()
  const before = await receiptState(storage)
  await expect(
    migrateStorage(
      faultStorage(storage, {
        beforeCommit: () => {
          throw new Error("injected upgrade failure")
        },
      }),
    ),
  ).rejects.toThrow("injected upgrade failure")
  expect(await receiptState(storage)).toEqual(before)
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT value FROM capi_metadata WHERE key='schema_version'",
        args: [],
      }),
    ),
  ).toEqual([{ value: "5" }])
  await migrateStorage(storage)
  expect(
    await storage.read((session) =>
      session.query({
        sql: "SELECT value FROM capi_metadata WHERE key='schema_version'",
        args: [],
      }),
    ),
  ).toEqual([{ value: "6" }])
})

test("schema five archive retains lifetime usage and drops old model detail", async () => {
  const source = await versionFive()
  const at = Math.floor(Date.now() / 60_000) * 60_000
  await source.atomicBatch([
    {
      sql: "INSERT INTO capi_usage_minutes(minute,model,input_tokens,output_tokens,request_count) VALUES (?,'old-model',3,6,1),(?,'recent',7,14,1)",
      args: [at - 2 * 86400_000, at],
    },
    {
      sql: "UPDATE capi_usage_lifetime SET input_tokens=10,output_tokens=20,request_count=2,first_request_at=? WHERE id=1",
      args: [at - 2 * 86400_000],
    },
  ])
  const archive = await createVersionFiveBackup(source)
  const targetFixture = await createSchemaFixture()
  fixtures.push(targetFixture)
  const target = targetFixture.storage
  await migrateStorage(target)
  expect(
    (await restoreBackup(bytesStream(archive), "fixture-password", target))
      .phase,
  ).toBe("complete")
  expect(
    await target.read((session) =>
      session.query({
        sql: "SELECT input_tokens,output_tokens,request_count FROM capi_usage_lifetime",
        args: [],
      }),
    ),
  ).toEqual([{ input_tokens: 10, output_tokens: 20, request_count: 2 }])
  expect(
    await target.read((session) =>
      session.query({
        sql: "SELECT model FROM capi_usage_minutes",
        args: [],
      }),
    ),
  ).toEqual([{ model: "recent" }])
})
