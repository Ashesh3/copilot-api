/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited. */
import { expect, test } from "bun:test"
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto"

import type { TransferRecord } from "~/lib/storage/transfer-records"
import type { Storage } from "~/lib/storage/types"

import {
  BACKUP_MAGIC,
  BACKUP_VERSION,
  createBackupStream,
  deriveBackupKey,
} from "~/lib/config-backup"
import { createAccountDistributionRepository } from "~/lib/storage/account-distribution-repository"
import { migrateStorage } from "~/lib/storage/migrations"
import { restoreBackup } from "~/lib/storage/restore"
import { storageMigrations, storageSchema } from "~/lib/storage/schema"
import {
  transferColumns,
  transferKey,
  transferRecords,
  transferTablesForSchema,
  validateTransferRecord,
} from "~/lib/storage/transfer-records"

import { createSchemaFixture } from "./helpers/storage-schema"
import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

test("encrypted transfer preserves binary ownership, policy and scheduler phase", async () => {
  await withTransferStorage(async (source) => {
    await source.atomicBatch([
      {
        sql: "INSERT INTO capi_accounts(id,domain,enabled,created_at,updated_at) VALUES(1,'github.com',1,0,0),(2,'github.com',1,0,0)",
        args: [],
      },
      {
        sql: "INSERT INTO capi_account_credentials(account_id,oauth_value,updated_at) VALUES(1,'fixture-one',0),(2,'fixture-two',0)",
        args: [],
      },
    ])
    const repository = createAccountDistributionRepository(source)
    await repository.replace(
      [
        { accountId: 1, percentage: 50 },
        { accountId: 2, percentage: 50 },
      ],
      {
        operationId: randomUUID(),
        expectedRevision: 0,
        actorId: "test",
        kind: "distribution",
        inputDigest: "fixture",
      },
    )
    const request = {
      affinityKey: "unicode-🦉-conversation",
      modelId: "model",
      eligibleAccountIds: [1, 2],
    }
    expect((await repository.assign(request)).accountId).toBe(1)
    for (let index = 0; index < 200; index++)
      await repository.assign({ ...request, affinityKey: `paged-${index}` })
    await source.atomicBatch([
      {
        sql: "UPDATE capi_conversation_accounts SET model_id='model-b'",
        args: [],
      },
    ])
    const records = await source.read(async (session) => {
      const found = []
      for await (const record of transferRecords(session)) found.push(record)
      return found
    })
    const mapping = records.find(
      (row) => row.table === "capi_conversation_accounts",
    )
    expect(
      records.filter((row) => row.table === "capi_conversation_accounts"),
    ).toHaveLength(201)
    expect(mapping).toBeDefined()
    if (!mapping) throw new Error("Missing conversation transfer row")
    expect(JSON.stringify(mapping)).not.toContain(request.affinityKey)
    expect(validateTransferRecord(mapping).conversation_key).toBeInstanceOf(
      Uint8Array,
    )
    expect(validateTransferRecord(mapping).model_id).toBe("model-b")
    const bytes = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      expect(
        (await restoreBackup(bytesStream(bytes), "fixture-password", target))
          .phase,
      ).toBe("complete")
      await migrateStorage(target)
      const restored = createAccountDistributionRepository(target)
      expect(await restored.lookup(request.affinityKey)).toBe(1)
      expect(
        await target.read((session) =>
          session.query({
            sql: "SELECT model_id,COUNT(*) AS count FROM capi_conversation_accounts GROUP BY model_id",
            args: [],
          }),
        ),
      ).toEqual([{ model_id: "model-b", count: 201 }])
      for (let index = 0; index < 200; index++)
        expect(await restored.lookup(`paged-${index}`)).toBe(
          await repository.lookup(`paged-${index}`),
        )
      expect((await restored.assign(request)).reason).toBe("existing")
      expect(
        (await restored.assign({ ...request, affinityKey: "next" })).accountId,
      ).toBe(2)
      expect(await restored.load()).toEqual(await repository.load())
    })
  })
})

test("binary ownership transfer rejects malformed and wrong-length digest encodings", () => {
  for (const conversationKey of [
    "",
    "AB".repeat(32),
    "a".repeat(63),
    "g".repeat(64),
    { type: "Buffer", data: [0] },
  ]) {
    expect(() =>
      validateTransferRecord({
        table: "capi_conversation_accounts",
        key: JSON.stringify([conversationKey]),
        value: {
          conversation_key: conversationKey,
          account_id: 1,
          model_id: null,
        },
      }),
    ).toThrow()
  }
})

test("migrated ownership table requires a full blob digest and restricts missing owners", async () => {
  await withTransferStorage(async (storage) => {
    const ddl = await storage.read((session) =>
      session.query({
        sql: "SELECT sql FROM sqlite_master WHERE name='capi_conversation_accounts'",
        args: [],
      }),
    )
    expect(ddl[0].sql).toContain("WITHOUT ROWID")
    for (const key of [new Uint8Array(16), "a".repeat(32), new Uint8Array(32)])
      await expect(
        storage.atomicBatch([
          {
            sql: "INSERT INTO capi_conversation_accounts(conversation_key,account_id) VALUES(?,1)",
            args: [key],
          },
        ]),
      ).rejects.toThrow()
  })
})

test.each([1, 2, 3, 4, 5, 6])(
  "schema %s upgrades without activating percentages or changing account IDs",
  async (version) => {
    const fixture = await createSchemaFixture()
    try {
      await fixture.storage.transaction(async (session) => {
        for (const migration of storageMigrations.slice(0, version)) {
          for (const sql of migration.statements)
            await session.execute({ sql, args: [] })
          await session.execute({
            sql: "INSERT INTO capi_schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,1)",
            args: [
              migration.version,
              migration.name,
              createHash("sha256")
                .update(JSON.stringify(migration))
                .digest("hex"),
            ],
          })
        }
        for (const [key, value] of [
          ["schema_version", String(version)],
          ["store_id", randomUUID()],
          ...storageSchema(version).counterKeys.map((key) => [key, "0"]),
        ])
          await session.execute({
            sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
            args: [key, value],
          })
        await session.execute({
          sql: "INSERT INTO capi_accounts(id,domain,created_at,updated_at) VALUES(0,'github.com',0,0),(42,'github.com',0,0)",
          args: [],
        })
      })
      await migrateStorage(fixture.storage)
      expect(
        await createAccountDistributionRepository(fixture.storage).load(),
      ).toEqual({
        revision: 0,
        configured: false,
        version: 0,
        allocations: [
          { accountId: 0, percentage: 0 },
          { accountId: 42, percentage: 0 },
        ],
      })
      await migrateStorage(fixture.storage)
    } finally {
      await fixture.close()
    }
  },
)

const legacyConversationKey = Buffer.from("b".repeat(64), "hex")

async function createLegacyOwnerFixture(version: 7 | 8) {
  const fixture = await createSchemaFixture()
  await fixture.storage.transaction(async (session) => {
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
    for (const [key, value] of [
      ["schema_version", String(version)],
      ["store_id", randomUUID()],
      ...storageSchema(version).counterKeys.map((key) => [key, "0"]),
    ])
      await session.execute({
        sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
        args: [key, value],
      })
    await session.execute({
      sql: "INSERT INTO capi_accounts(id,domain,created_at,updated_at) VALUES(42,'github.com',0,0)",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_account_credentials(account_id,oauth_value,updated_at) VALUES(42,'fixture-legacy',0)",
      args: [],
    })
    await session.execute({
      sql: "INSERT INTO capi_conversation_accounts(conversation_key,account_id) VALUES(?,42)",
      args: [legacyConversationKey],
    })
  })
  return fixture
}

test.each([7, 8] as const)(
  "schema %s ownership upgrades with an unknown model and retains its account",
  async (version) => {
    const fixture = await createLegacyOwnerFixture(version)
    try {
      expect(
        transferColumns("capi_conversation_accounts", version).map(
          (column) => column.name,
        ),
      ).toEqual(["conversation_key", "account_id"])
      await migrateStorage(fixture.storage)
      expect(
        await fixture.storage.read((session) =>
          session.query({
            sql: "SELECT account_id,model_id FROM capi_conversation_accounts WHERE conversation_key=?",
            args: [legacyConversationKey],
          }),
        ),
      ).toEqual([{ account_id: 42, model_id: null }])
      await migrateStorage(fixture.storage)
    } finally {
      await fixture.close()
    }
  },
)

test("ownership model markers reject empty and binary values but allow unknown models", async () => {
  await withTransferStorage(async (storage) => {
    await storage.atomicBatch([
      {
        sql: "INSERT INTO capi_accounts(id,domain,created_at,updated_at) VALUES(42,'github.com',0,0)",
        args: [],
      },
      {
        sql: "INSERT INTO capi_conversation_accounts(conversation_key,account_id,model_id) VALUES(?,42,NULL)",
        args: [legacyConversationKey],
      },
    ])
    for (const modelId of ["", Buffer.from("model")])
      await expect(
        storage.atomicBatch([
          {
            sql: "UPDATE capi_conversation_accounts SET model_id=?",
            args: [modelId],
          },
        ]),
      ).rejects.toThrow()
    await storage.atomicBatch([
      {
        sql: "UPDATE capi_conversation_accounts SET model_id='model-a'",
        args: [],
      },
    ])
    expect(
      await storage.read((session) =>
        session.query({
          sql: "SELECT account_id,model_id FROM capi_conversation_accounts",
          args: [],
        }),
      ),
    ).toEqual([{ account_id: 42, model_id: "model-a" }])
  })
})

async function legacyOwnershipBackup(
  storage: Storage,
  version: 7 | 8,
): Promise<Uint8Array> {
  const records: Array<TransferRecord> = []
  await storage.read(async (session) => {
    for (const table of transferTablesForSchema(version)) {
      const columns = transferColumns(table, version).map(
        (column) => column.name,
      )
      const rows = await session.query({
        sql: `SELECT ${columns.join(",")} FROM ${table}`,
        args: [],
      })
      records.push(
        ...rows
          .map((row) => ({
            table,
            key: transferKey(table, row, version),
            value: Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                value instanceof Uint8Array ?
                  Buffer.from(value).toString("hex")
                : value,
              ]),
            ) as TransferRecord["value"],
          }))
          .sort((left, right) =>
            Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)),
          ),
      )
    }
  })
  const digest = createHash("sha256")
  const recordCounts: Record<string, number> = {}
  const frames = records.map((record, seq) => {
    recordCounts[record.table] = (recordCounts[record.table] ?? 0) + 1
    const frame = `${JSON.stringify({ kind: "record", seq, record })}\n`
    digest.update(frame)
    return frame
  })
  const identity = records.find(
    (record) =>
      record.table === "capi_metadata" && record.key === '["store_id"]',
  )
  frames.push(
    `${JSON.stringify({
      kind: "manifest",
      seq: frames.length,
      manifest: {
        formatVersion: 1,
        schemaVersion: version,
        sourceStoreId: (identity?.value as { value: string }).value,
        recordCounts,
        recordsSha256: digest.digest("hex"),
      },
    })}\n`,
  )
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const header = Buffer.concat([
    BACKUP_MAGIC,
    Buffer.from([BACKUP_VERSION]),
    salt,
    iv,
  ])
  const key = await deriveBackupKey("fixture-password", salt)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(header)
  key.fill(0)
  return Buffer.concat([
    header,
    cipher.update(frames.join("")),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}

test.each([7, 8] as const)(
  "schema %s ownership backups restore with an unknown model",
  async (version) => {
    const fixture = await createLegacyOwnerFixture(version)
    try {
      const bytes = await legacyOwnershipBackup(fixture.storage, version)
      await withTransferStorage(async (target) => {
        expect(
          (await restoreBackup(bytesStream(bytes), "fixture-password", target))
            .phase,
        ).toBe("complete")
        expect(
          await target.read((session) =>
            session.query({
              sql: "SELECT account_id,model_id FROM capi_conversation_accounts WHERE conversation_key=?",
              args: [legacyConversationKey],
            }),
          ),
        ).toEqual([{ account_id: 42, model_id: null }])
        await migrateStorage(target)
      })
    } finally {
      await fixture.close()
    }
  },
)
