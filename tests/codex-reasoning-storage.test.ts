import { expect, test } from "bun:test"

import { createBackupStream } from "~/lib/config-backup"
import { StorageSchemaError } from "~/lib/storage/errors"
import { migrateStorage } from "~/lib/storage/migrations"
import { restoreBackup } from "~/lib/storage/restore"
import { completeTransferRecord } from "~/lib/storage/transfer-records"

import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const table = "capi_codex_reasoning_preferences"
const preference = {
  account_id: "account-a",
  user_id: "user-a",
  overrides_json: '{"ultra":false}',
  source: "user",
}

test("version ten databases gain reasoning preferences without changing existing settings", async () => {
  await withTransferStorage(async (storage) => {
    await storage.atomicBatch([
      { sql: `DROP TABLE ${table}`, args: [] },
      { sql: "DELETE FROM capi_schema_migrations WHERE version=11", args: [] },
      {
        sql: "UPDATE capi_metadata SET value='10' WHERE key='schema_version'",
        args: [],
      },
      {
        sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app','{}',0)",
        args: [],
      },
    ])
    await migrateStorage(storage)
    await migrateStorage(storage)
    expect(
      await storage.read((session) =>
        session.query({ sql: `SELECT * FROM ${table}`, args: [] }),
      ),
    ).toEqual([])
    expect(
      await storage.read((session) =>
        session.query({
          sql: "SELECT value_json FROM capi_settings WHERE namespace='app'",
          args: [],
        }),
      ),
    ).toEqual([{ value_json: "{}" }])
  })
})

test("backup and restore preserve account-user effort choices", async () => {
  await withTransferStorage(async (source) => {
    await source.atomicBatch([
      {
        sql: `INSERT INTO ${table}(account_id,user_id,overrides_json,source) VALUES(?,?,?,?)`,
        args: [
          preference.account_id,
          preference.user_id,
          preference.overrides_json,
          preference.source,
        ],
      },
    ])
    const bytes = await streamBytes(
      createBackupStream("test-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      expect(
        (await restoreBackup(bytesStream(bytes), "test-password", target))
          .phase,
      ).toBe("complete")
      expect(
        await target.read((session) =>
          session.query({ sql: `SELECT * FROM ${table}`, args: [] }),
        ),
      ).toEqual([preference])
    })
  })
})

test.each([
  { overrides_json: '{"max":"false"}' },
  { overrides_json: '{"unrelated":true}' },
  { source: "unknown" },
  { account_id: "" },
  { user_id: "" },
])("malformed restored reasoning preferences fail validation %#", (change) => {
  expect(() =>
    completeTransferRecord(table, { ...preference, ...change }),
  ).toThrow(StorageSchemaError)
})
