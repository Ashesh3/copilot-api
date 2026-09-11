import type { SqlSession } from "~/lib/storage/types"

import { StorageSchemaError } from "~/lib/storage/errors"
import { reconcileLegacyCleanRuns } from "~/lib/storage/history-lifecycle"

const DAY_MS = 86400_000
const ARCHIVED_COLLECTION_KEY = "history_collection_lifetime"

interface ArchivedCollectionStatus {
  knownLostRecords: number
  knownLostBytes: number
  unknownGaps: number
}

function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new StorageSchemaError("Invalid collection history counters")
  return value
}

/** Missing history predates compaction; present values contain counters only. */
export function decodeArchivedCollectionStatus(
  value: unknown,
): ArchivedCollectionStatus {
  if (value === undefined || value === null)
    return { knownLostRecords: 0, knownLostBytes: 0, unknownGaps: 0 }
  if (typeof value !== "string")
    throw new StorageSchemaError("Invalid collection history counters")
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new StorageSchemaError("Invalid collection history counters")
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).length !== 3
    || !("knownLostRecords" in parsed)
    || !("knownLostBytes" in parsed)
    || !("unknownGaps" in parsed)
  )
    throw new StorageSchemaError("Invalid collection history counters")
  return {
    knownLostRecords: counter(parsed.knownLostRecords),
    knownLostBytes: counter(parsed.knownLostBytes),
    unknownGaps: counter(parsed.unknownGaps),
  }
}

export async function readArchivedCollectionStatus(
  session: SqlSession,
): Promise<ArchivedCollectionStatus> {
  const rows = await session.query({
    sql: "SELECT value FROM capi_metadata WHERE key = ?",
    args: [ARCHIVED_COLLECTION_KEY],
  })
  return decodeArchivedCollectionStatus(rows.at(0)?.value)
}

async function compactCollectionGaps(
  session: SqlSession,
  cutoff: number,
): Promise<void> {
  const prior = await readArchivedCollectionStatus(session)
  const rows = await session.query({
    sql: "SELECT COUNT(*) AS count, TOTAL(lost_records) AS records, TOTAL(lost_bytes) AS bytes, TOTAL(CASE WHEN kind='unknown' THEN 1 ELSE 0 END) AS unknown_count FROM capi_collection_gaps WHERE COALESCE(ended_at,started_at) < ?",
    args: [cutoff],
  })
  const row = rows.at(0)
  if (!row) throw new StorageSchemaError("Invalid collection history counters")
  if (counter(row.count) === 0) return
  const next: ArchivedCollectionStatus = {
    knownLostRecords: counter(prior.knownLostRecords + counter(row.records)),
    knownLostBytes: counter(prior.knownLostBytes + counter(row.bytes)),
    unknownGaps: counter(prior.unknownGaps + counter(row.unknown_count)),
  }
  await session.execute({
    sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    args: [ARCHIVED_COLLECTION_KEY, JSON.stringify(next)],
  })
  await session.execute({
    sql: "DELETE FROM capi_collection_gaps WHERE COALESCE(ended_at,started_at) < ?",
    args: [cutoff],
  })
}

/** The caller owns the transaction so compaction and deletion commit together. */
export async function pruneHistoryBookkeeping(
  session: SqlSession,
  now: number,
): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new StorageSchemaError("Invalid history maintenance time")
  const cutoff = now - DAY_MS
  await reconcileLegacyCleanRuns(session)
  await compactCollectionGaps(session, cutoff)
  // An expired unclean lease can belong to a paused process. Its UPDATE-only
  // renewal still needs this identity after resumption; only clean runs retire.
  await session.execute({
    sql: "DELETE FROM capi_process_runs WHERE clean=1 AND ended_at < ? AND NOT EXISTS (SELECT 1 FROM capi_collection_gaps WHERE process_run_id=capi_process_runs.id)",
    args: [cutoff],
  })
  await session.execute({
    sql: "DELETE FROM capi_admin_sessions WHERE expires_at <= ? OR EXISTS (SELECT 1 FROM capi_admin WHERE id=capi_admin_sessions.admin_id AND session_version<>capi_admin_sessions.session_version)",
    args: [now],
  })
  for (const table of [
    "capi_setup_codes",
    "capi_device_login_intents",
    "capi_oauth_codes",
  ]) {
    await session.execute({
      sql: `DELETE FROM ${table} WHERE expires_at < ?`,
      args: [cutoff],
    })
  }
}
