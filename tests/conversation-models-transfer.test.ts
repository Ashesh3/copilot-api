/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited. */
import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"

import { createBackupStream } from "~/lib/config-backup"
import {
  createConversationModelsRepository,
  validateConversationModelsState,
} from "~/lib/storage/conversation-models-repository"
import { migrateStorage } from "~/lib/storage/migrations"
import { restoreBackup } from "~/lib/storage/restore"
import { storageMigrations, storageSchema } from "~/lib/storage/schema"
import {
  completeTransferRecord,
  transferRecords,
} from "~/lib/storage/transfer-records"

import { createSchemaFixture } from "./helpers/storage-schema"
import {
  bytesStream,
  streamBytes,
  withTransferStorage,
} from "./helpers/transfer-storage"

const conversationKey = "a".repeat(64)
const binding = {
  configRevision: 0,
  redirectRevision: 0,
  signature: "b".repeat(64),
}

test("encrypted backups restore durable model routes, foreign hashes and request ordering", async () => {
  await withTransferStorage(async (source) => {
    const repository = createConversationModelsRepository(source)
    const first = await repository.begin(conversationKey, binding)
    await repository.remember({
      conversationKey,
      binding,
      requestSequence: first.requestSequence,
      sourceModel: "model-a",
      targetModel: "model-b",
      identitySignature: "f".repeat(64),
      route: [{ source: "model-a", target: "model-b", resolved: "model-b" }],
      foreignThinking: {
        complete: true,
        fingerprints: new Set(["c".repeat(64)]),
      },
    })
    const records = await source.read(async (session) => {
      const values = []
      for await (const value of transferRecords(session)) values.push(value)
      return values
    })
    expect(
      records.filter((record) => record.table === "capi_conversation_models"),
    ).toHaveLength(1)
    const backup = await streamBytes(
      createBackupStream("fixture-password", undefined, source),
    )
    await withTransferStorage(async (target) => {
      expect(
        (await restoreBackup(bytesStream(backup), "fixture-password", target))
          .phase,
      ).toBe("complete")
      const next = await createConversationModelsRepository(target).begin(
        conversationKey,
        binding,
      )
      expect(next.requestSequence).toBeGreaterThan(first.requestSequence)
      expect(next.routes.get("model-a")?.targetModel).toBe("model-b")
      expect(next.routes.get("model-a")?.identitySignature).toBe("f".repeat(64))
      expect(next.routes.get("model-a")?.foreignThinking.fingerprints).toEqual(
        new Set(["c".repeat(64)]),
      )
    })
  })
})

function transferred(overrides: Record<string, unknown>) {
  return completeTransferRecord("capi_conversation_models", {
    conversation_key: Buffer.from(conversationKey, "hex"),
    source_model: "model-a",
    target_model: "model-b",
    route_json: JSON.stringify([
      { source: "model-a", target: "model-b", resolved: "model-b" },
    ]),
    fingerprints_json: JSON.stringify(["c".repeat(64)]),
    foreign_complete: 1,
    request_sequence: 1,
    config_revision: 0,
    redirect_revision: 0,
    binding_signature: binding.signature,
    identity_signature: "f".repeat(64),
    ...overrides,
  })
}

test.each([
  { route_json: "[]" },
  {
    route_json: JSON.stringify([
      { source: "wrong", target: "model-b", resolved: "model-b" },
    ]),
  },
  {
    route_json: JSON.stringify([
      { source: "model-a", target: "model-c", resolved: "model-c" },
    ]),
  },
  { fingerprints_json: JSON.stringify(["private signature"]) },
  { fingerprints_json: JSON.stringify(["c".repeat(64), "c".repeat(64)]) },
  {
    fingerprints_json: JSON.stringify(
      Array.from({ length: 4097 }, (_, index) =>
        index.toString(16).padStart(64, "0"),
      ),
    ),
  },
  { binding_signature: "private config" },
  { identity_signature: "provider identity without hashing" },
  { foreign_complete: 2 },
  { request_sequence: 0 },
])("restore rejects malformed route state", (overrides) => {
  expect(() => transferred(overrides)).toThrow()
})

test("restore rejects accepted request sequence beyond the allocated ticket", async () => {
  await withTransferStorage(async (storage) => {
    const repository = createConversationModelsRepository(storage)
    const first = await repository.begin(conversationKey, binding)
    await repository.remember({
      conversationKey,
      binding,
      requestSequence: first.requestSequence,
      sourceModel: "model-a",
      targetModel: "model-b",
      identitySignature: "f".repeat(64),
      route: [{ source: "model-a", target: "model-b", resolved: "model-b" }],
      foreignThinking: { complete: true, fingerprints: new Set() },
    })
    await storage.atomicBatch([
      {
        sql: "UPDATE capi_conversation_models SET request_sequence=2",
        args: [],
      },
    ])
    await expect(
      storage.read(validateConversationModelsState),
    ).rejects.toThrow()
  })
})

test("schema seven upgrades preserve account ownership and remove obsolete fallback settings", async () => {
  const value = await createSchemaFixture()
  try {
    await value.storage.transaction(async (session) => {
      for (const migration of storageMigrations.slice(0, 7)) {
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
      for (const [key, metadataValue] of [
        ["schema_version", "7"],
        ["store_id", randomUUID()],
        ...storageSchema(7).counterKeys.map((key) => [key, "0"]),
      ]) {
        await session.execute({
          sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?)",
          args: [key, metadataValue],
        })
      }
      await session.execute({
        sql: "INSERT INTO capi_accounts(id,domain,created_at,updated_at) VALUES(42,'github.com',0,0)",
        args: [],
      })
      await session.execute({
        sql: "INSERT INTO capi_conversation_accounts(conversation_key,account_id) VALUES(?,42)",
        args: [Buffer.from(conversationKey, "hex")],
      })
      await session.execute({
        sql: "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('model_fallbacks',?,0)",
        args: [
          JSON.stringify({
            enabled: true,
            conversationAffinity: false,
            affinityTtlSeconds: 60,
            affinityMaxEntries: 1,
            rules: [],
          }),
        ],
      })
    })
    await migrateStorage(value.storage)
    const rows = await value.storage.read((session) =>
      session.query({
        sql: "SELECT value_json FROM capi_settings WHERE namespace='model_fallbacks'",
        args: [],
      }),
    )
    expect(JSON.parse(String(rows[0].value_json))).toEqual({
      enabled: true,
      rules: [],
    })
    expect(
      await value.storage.read((session) =>
        session.query({
          sql: "SELECT account_id FROM capi_conversation_accounts",
          args: [],
        }),
      ),
    ).toEqual([{ account_id: 42 }])
    expect(
      (
        await createConversationModelsRepository(value.storage).begin(
          conversationKey,
          binding,
        )
      ).routes.size,
    ).toBe(0)
    await migrateStorage(value.storage)
  } finally {
    await value.close()
  }
})
