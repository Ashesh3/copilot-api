import { expect, test } from "bun:test"

import type { SqlValue, Storage } from "~/lib/storage/types"

import { StorageSchemaError } from "~/lib/storage/errors"
import {
  pruneHistoryBookkeeping,
  readArchivedCollectionStatus,
} from "~/lib/storage/history-bookkeeping"
import { createHistoryRepository } from "~/lib/storage/history-repository"
import { migrateStorage } from "~/lib/storage/migrations"

import { createSchemaFixture } from "./helpers/storage-schema"

const DAY = 86400_000
const NOW = 1800000000000
const CUTOFF = NOW - DAY
const EMPTY = { knownLostRecords: 0, knownLostBytes: 0, unknownGaps: 0 }

async function fixture() {
  const f = await createSchemaFixture()
  await migrateStorage(f.storage)
  return f
}

function execute(storage: Storage, sql: string, args: Array<SqlValue> = []) {
  return storage.atomicBatch([{ sql, args }])
}

function rows(storage: Storage, sql: string) {
  return storage.read((session) => session.query({ sql, args: [] }))
}

async function oldGap(storage: Storage) {
  await execute(
    storage,
    "INSERT INTO capi_process_runs(id,started_at,ended_at,clean) VALUES ('old-run',?,?,1)",
    [CUTOFF - DAY, CUTOFF - 1],
  )
  await execute(
    storage,
    "INSERT INTO capi_collection_gaps(id,process_run_id,started_at,ended_at,kind,lost_records,lost_bytes,payload_json) VALUES ('old-gap','old-run',?,?,'known',3,120,?)",
    [CUTOFF - DAY, CUTOFF - 1, '{"detail":"expired fixture payload"}'],
  )
}

test("pruning removes disproved legacy gaps before archiving genuine loss", async () => {
  const f = await fixture()
  try {
    await execute(
      f.storage,
      "INSERT INTO capi_process_runs(id,started_at,ended_at,clean) VALUES ('legacy-clean',?,?,1),('genuine-old',?,?,1),('genuine-recent',?,?,1)",
      [CUTOFF - DAY, CUTOFF - 1, CUTOFF - DAY, CUTOFF - 1, NOW - 2, NOW - 1],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_collection_gaps(id,process_run_id,started_at,ended_at,kind,payload_json) VALUES ('unclean-legacy-clean','legacy-clean',?,?,'unknown','{}'),('unclean-genuine-old','genuine-old',?,?,'unknown',?),('unclean-genuine-recent','genuine-recent',?,?,'unknown',?)",
      [
        CUTOFF - DAY,
        CUTOFF - 1,
        CUTOFF - DAY,
        CUTOFF - 1,
        '{"reason":"expired-run-lease"}',
        NOW - 2,
        NOW - 1,
        '{"reason":"expired-run-lease"}',
      ],
    )
    const history = createHistoryRepository(f.storage)
    await history.prune(NOW)
    expect(await f.storage.read(readArchivedCollectionStatus)).toEqual({
      knownLostRecords: 0,
      knownLostBytes: 0,
      unknownGaps: 1,
    })
    expect(
      await rows(f.storage, "SELECT id FROM capi_collection_gaps ORDER BY id"),
    ).toEqual([{ id: "unclean-genuine-recent" }])
    expect(
      await rows(f.storage, "SELECT id FROM capi_process_runs ORDER BY id"),
    ).toEqual([{ id: "genuine-recent" }])
    await history.prune(NOW)
    expect((await history.collectionStatus()).unknownGaps).toBe(2)
  } finally {
    await f.close()
  }
})

test("old gap details compact once into numeric lifetime totals while active and referenced runs remain", async () => {
  const f = await fixture()
  try {
    expect(await f.storage.read(readArchivedCollectionStatus)).toEqual(EMPTY)
    await oldGap(f.storage)
    await execute(
      f.storage,
      "INSERT INTO capi_metadata(key,value) VALUES('history_collection_lifetime',?)",
      [
        JSON.stringify({
          knownLostRecords: 7,
          knownLostBytes: 9,
          unknownGaps: 2,
        }),
      ],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_process_runs(id,started_at,ended_at,clean) VALUES ('unclean-run',?,?,0),('active-run',?,NULL,0),('referenced-run',?,?,1),('boundary-run',?,?,1),('recent-run',?,?,1)",
      [
        CUTOFF - DAY,
        CUTOFF - 1,
        CUTOFF - DAY,
        CUTOFF - DAY,
        CUTOFF - 1,
        CUTOFF - DAY,
        CUTOFF,
        CUTOFF - DAY,
        NOW - 1,
      ],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_collection_gaps(id,process_run_id,started_at,ended_at,kind,lost_records,lost_bytes) VALUES ('unknown-old','unclean-run',?,?,'unknown',NULL,NULL),('open-old',NULL,?,NULL,'known',2,80),('active-gap','active-run',?,NULL,'unknown',NULL,NULL),('boundary-gap',NULL,?,?,'known',4,400),('referenced-gap','referenced-run',?,?,'known',5,500),('recent-gap','recent-run',?,?,'known',6,600)",
      [
        CUTOFF - DAY,
        CUTOFF - 1,
        CUTOFF - 1,
        NOW - 1,
        CUTOFF - DAY,
        CUTOFF,
        CUTOFF - DAY,
        NOW - 1,
        NOW - 2,
        NOW - 1,
      ],
    )
    await f.storage.transaction((session) =>
      pruneHistoryBookkeeping(session, NOW),
    )
    expect(await f.storage.read(readArchivedCollectionStatus)).toEqual({
      knownLostRecords: 12,
      knownLostBytes: 209,
      unknownGaps: 3,
    })
    expect(
      await rows(f.storage, "SELECT id FROM capi_collection_gaps ORDER BY id"),
    ).toEqual([
      { id: "active-gap" },
      { id: "boundary-gap" },
      { id: "recent-gap" },
      { id: "referenced-gap" },
    ])
    expect(
      await rows(f.storage, "SELECT id FROM capi_process_runs ORDER BY id"),
    ).toEqual([
      { id: "active-run" },
      { id: "boundary-run" },
      { id: "recent-run" },
      { id: "referenced-run" },
      { id: "unclean-run" },
    ])
    await f.storage.transaction((session) =>
      pruneHistoryBookkeeping(session, NOW),
    )
    expect(await f.storage.read(readArchivedCollectionStatus)).toEqual({
      knownLostRecords: 12,
      knownLostBytes: 209,
      unknownGaps: 3,
    })
    const [archived] = await rows(
      f.storage,
      "SELECT value FROM capi_metadata WHERE key='history_collection_lifetime'",
    )
    expect(JSON.parse(String(archived.value))).toEqual({
      knownLostRecords: 12,
      knownLostBytes: 209,
      unknownGaps: 3,
    })
  } finally {
    await f.close()
  }
})

test("compaction and deletion roll back together before a retry counts each gap once", async () => {
  const f = await fixture()
  try {
    await oldGap(f.storage)
    const failure: unknown = await f.storage
      .transaction(async (session) => {
        await pruneHistoryBookkeeping(session, NOW)
        throw new Error("rollback fixture")
      })
      .catch((error: unknown) => error)
    expect(failure).toEqual(new Error("rollback fixture"))
    expect(await f.storage.read(readArchivedCollectionStatus)).toEqual(EMPTY)
    expect(
      await rows(f.storage, "SELECT id FROM capi_collection_gaps"),
    ).toEqual([{ id: "old-gap" }])
    expect(await rows(f.storage, "SELECT id FROM capi_process_runs")).toEqual([
      { id: "old-run" },
    ])
    await f.storage.transaction((session) =>
      pruneHistoryBookkeeping(session, NOW),
    )
    await f.storage.transaction((session) =>
      pruneHistoryBookkeeping(session, NOW),
    )
    expect(await f.storage.read(readArchivedCollectionStatus)).toEqual({
      knownLostRecords: 3,
      knownLostBytes: 120,
      unknownGaps: 0,
    })
    expect(
      await rows(f.storage, "SELECT id FROM capi_collection_gaps"),
    ).toEqual([])
  } finally {
    await f.close()
  }
})

test.each([
  "fixture-secret-invalid-json",
  "null",
  '{"knownLostRecords":1,"knownLostBytes":0}',
  '{"knownLostRecords":-1,"knownLostBytes":0,"unknownGaps":0}',
  '{"knownLostRecords":"1","knownLostBytes":0,"unknownGaps":0}',
  '{"knownLostRecords":1.5,"knownLostBytes":0,"unknownGaps":0}',
  '{"knownLostRecords":9007199254740992,"knownLostBytes":0,"unknownGaps":0}',
  '{"knownLostRecords":1,"knownLostBytes":0,"unknownGaps":0,"detail":"fixture-secret"}',
])(
  "malformed archived counters fail closed without dropping details: %s",
  async (value) => {
    const f = await fixture()
    try {
      await oldGap(f.storage)
      await execute(
        f.storage,
        "INSERT INTO capi_metadata(key,value) VALUES('history_collection_lifetime',?)",
        [value],
      )
      const read: unknown = await f.storage
        .read(readArchivedCollectionStatus)
        .catch((error: unknown) => error)
      expect(read).toBeInstanceOf(StorageSchemaError)
      expect(String(read)).not.toContain("fixture-secret")
      const pruning: unknown = await f.storage
        .transaction((session) => pruneHistoryBookkeeping(session, NOW))
        .catch((error: unknown) => error)
      expect(pruning).toBeInstanceOf(StorageSchemaError)
      expect(
        await rows(f.storage, "SELECT id FROM capi_collection_gaps"),
      ).toEqual([{ id: "old-gap" }])
    } finally {
      await f.close()
    }
  },
)

test("counter overflow preserves uncompacted details", async () => {
  const f = await fixture()
  try {
    await oldGap(f.storage)
    await execute(
      f.storage,
      "INSERT INTO capi_metadata(key,value) VALUES('history_collection_lifetime',?)",
      [
        JSON.stringify({
          knownLostRecords: Number.MAX_SAFE_INTEGER,
          knownLostBytes: 0,
          unknownGaps: 0,
        }),
      ],
    )
    const failure: unknown = await f.storage
      .transaction((session) => pruneHistoryBookkeeping(session, NOW))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(StorageSchemaError)
    expect(
      await rows(f.storage, "SELECT id FROM capi_collection_gaps"),
    ).toEqual([{ id: "old-gap" }])
  } finally {
    await f.close()
  }
})

test("expired transients prune without changing active authority, durable accounts or non-history receipts", async () => {
  const f = await fixture()
  try {
    await execute(
      f.storage,
      "INSERT INTO capi_admin(id,password_hash,session_version,created_at,updated_at) VALUES(1,'fixture-admin',2,?,?)",
      [CUTOFF - DAY, NOW],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_admin_sessions(token_hash,csrf_hash,session_version,created_at,last_seen_at,expires_at) VALUES('current','csrf',2,?,?,?),('expired','csrf',2,?,?,?),('old-version','csrf',1,?,?,?)",
      [
        CUTOFF - DAY,
        NOW,
        NOW + DAY,
        CUTOFF - DAY,
        CUTOFF - 2,
        CUTOFF - 1,
        CUTOFF - DAY,
        NOW,
        NOW + DAY,
      ],
    )
    for (const [id, expiry] of [
      ["old", CUTOFF - 1],
      ["boundary", CUTOFF],
      ["recent-expired", NOW - 1],
      ["active", NOW + DAY],
    ] as const) {
      await execute(
        f.storage,
        "INSERT INTO capi_setup_codes(digest,created_at,expires_at) VALUES(?,?,?)",
        [id, CUTOFF - DAY, expiry],
      )
      await execute(
        f.storage,
        "INSERT INTO capi_device_login_intents(id,admin_id,domain,device_code,user_code,verification_uri,interval_seconds,created_at,expires_at) VALUES(?,1,'fixture.example','fixture-device','fixture-user','https://fixture.example',5,?,?)",
        [id, CUTOFF - DAY, expiry],
      )
      await execute(
        f.storage,
        "INSERT INTO capi_oauth_codes(digest,client_id,redirect_uri,scopes_json,state,code_challenge,created_at,expires_at) VALUES(?,'fixture-client','https://fixture.example','[]','fixture-state','fixture-challenge',?,?)",
        [id, CUTOFF - DAY, expiry],
      )
    }
    await execute(
      f.storage,
      "INSERT INTO capi_oauth_families(id,principal_id,created_at,expires_at) VALUES('active-family','fixture-principal',?,?)",
      [CUTOFF - 2 * DAY, CUTOFF - DAY],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_oauth_access(digest,family_id,principal_id,client_id,scopes_json,created_at,expires_at) VALUES('active-access','active-family','fixture-principal','fixture-client','[]',?,?)",
      [CUTOFF - 2 * DAY, CUTOFF - DAY],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_oauth_refresh(digest,family_id,principal_id,client_id,scopes_json,created_at,expires_at) VALUES('active-refresh','active-family','fixture-principal','fixture-client','[]',?,?)",
      [CUTOFF - 2 * DAY, CUTOFF - DAY],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_inference_credentials(digest,id,kind,principal_id,created_at,updated_at) VALUES('managed-digest','managed','managed','fixture-principal',?,?)",
      [CUTOFF - 10 * DAY, CUTOFF - 10 * DAY],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_gateway_credentials(id,digest,label,created_at) VALUES('gateway','gateway-digest','fixture',?)",
      [CUTOFF - 10 * DAY],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_accounts(domain,created_at,updated_at) VALUES('fixture.example',?,?)",
      [CUTOFF - 10 * DAY, CUTOFF - 10 * DAY],
    )
    await execute(
      f.storage,
      "INSERT INTO capi_settings(namespace,value_json,revision) VALUES('app','{}',0)",
    )
    await execute(
      f.storage,
      "INSERT INTO capi_applied_operations(id,kind,actor_id,input_digest,committed_revision,result_json,created_at) VALUES('receipt','settings.replace','fixture','fixture',0,'{}',?)",
      [CUTOFF - 10 * DAY],
    )
    await f.storage.transaction((session) =>
      pruneHistoryBookkeeping(session, NOW),
    )
    expect(
      await rows(
        f.storage,
        "SELECT token_hash FROM capi_admin_sessions ORDER BY token_hash",
      ),
    ).toEqual([{ token_hash: "current" }])
    for (const [table, key] of [
      ["capi_setup_codes", "digest"],
      ["capi_device_login_intents", "id"],
      ["capi_oauth_codes", "digest"],
    ]) {
      expect(
        await rows(f.storage, `SELECT ${key} AS id FROM ${table} ORDER BY id`),
      ).toEqual([
        { id: "active" },
        { id: "boundary" },
        { id: "recent-expired" },
      ])
    }
    for (const table of [
      "capi_oauth_families",
      "capi_oauth_access",
      "capi_oauth_refresh",
      "capi_inference_credentials",
      "capi_gateway_credentials",
      "capi_accounts",
      "capi_settings",
      "capi_applied_operations",
      "capi_admin",
    ]) {
      expect(
        await rows(f.storage, `SELECT COUNT(*) AS count FROM ${table}`),
      ).toEqual([{ count: 1 }])
    }
  } finally {
    await f.close()
  }
})
