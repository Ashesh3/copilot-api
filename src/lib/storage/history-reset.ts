import { createHash } from "node:crypto"

import type { MutationContext, SqlSession, Storage } from "~/lib/storage/types"
import type { HistoryRecord } from "~/lib/telemetry-writer"

import { StorageSchemaError } from "~/lib/storage/errors"
import { HISTORY_RUN_LEASE_MS, renewRun } from "~/lib/storage/history-lifecycle"
import { runMutation } from "~/lib/storage/operations"

export const HISTORY_USAGE_RESET_KEY = "history_usage_reset"
const RESET_INPUT_DIGEST = createHash("sha256")
  .update("history.reset:usage-routing-collection:v1")
  .digest("hex")

export interface HistoryResetState {
  resetAt: number
  revision: number
}

function validateHistoryReset(value: unknown): HistoryResetState {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !("resetAt" in value)
    || !("revision" in value)
    || typeof value.resetAt !== "number"
    || !Number.isSafeInteger(value.resetAt)
    || value.resetAt < 0
    || typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
  )
    throw new StorageSchemaError("Invalid usage reset boundary")
  return { resetAt: value.resetAt, revision: value.revision }
}

export function decodeHistoryReset(value: unknown): HistoryResetState | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string")
    throw new StorageSchemaError("Invalid usage reset boundary")
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new StorageSchemaError("Invalid usage reset boundary")
  }
  return validateHistoryReset(parsed)
}

export async function readHistoryReset(
  session: SqlSession,
): Promise<HistoryResetState | null> {
  const rows = await session.query({
    sql: "SELECT value FROM capi_metadata WHERE key = ?",
    args: [HISTORY_USAGE_RESET_KEY],
  })
  return decodeHistoryReset(rows.at(0)?.value)
}

export async function writeHistoryReset(
  session: SqlSession,
  state: HistoryResetState,
): Promise<void> {
  await session.execute({
    sql: "INSERT INTO capi_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    args: [
      HISTORY_USAGE_RESET_KEY,
      JSON.stringify(validateHistoryReset(state)),
    ],
  })
}

/** Gaps retain the source record time so delayed loss detection respects resets. */
export function historyRecordSurvivesReset(
  record: HistoryRecord,
  state: HistoryResetState | null,
): boolean {
  if (!state || record.generation >= state.revision) return true
  const payload = record.payload
  const recordedAt =
    (
      record.kind === "collection-gap"
      && payload !== null
      && typeof payload === "object"
      && !Array.isArray(payload)
      && typeof payload.lastRecordAt === "number"
    ) ?
      payload.lastRecordAt
    : record.recordedAt
  return recordedAt > state.resetAt
}

/** A compacted interval cannot prove how many losses occurred after its reset. */
export function normalizeHistoryRecordAfterReset(
  record: HistoryRecord,
  state: HistoryResetState | null,
): HistoryRecord | undefined {
  if (!historyRecordSurvivesReset(record, state)) return undefined
  const payload = record.payload
  if (
    !state
    || record.generation >= state.revision
    || record.kind !== "collection-gap"
    || payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
    || typeof payload.firstRecordAt !== "number"
    || typeof payload.lastRecordAt !== "number"
    || payload.firstRecordAt > state.resetAt
    || payload.lastRecordAt <= state.resetAt
  )
    return record
  const normalized = structuredClone(payload)
  delete normalized.lostRecords
  delete normalized.lostBytes
  delete normalized.discardedRecords
  normalized.unknown = true
  normalized.reason = "reset-overlapping-collection-gap"
  return { ...record, payload: normalized }
}

async function resetCollectionLeases(
  session: SqlSession,
  state: HistoryResetState,
  runId?: string,
): Promise<void> {
  // Acknowledge expired periods while retaining identities that can resume.
  await session.execute({
    sql: "UPDATE capi_process_runs SET ended_at=? WHERE clean=0 AND (ended_at IS NOT NULL OR COALESCE(json_extract(payload_json,'$.heartbeatAt'),last_flush_at,started_at) < ?)",
    args: [state.resetAt, state.resetAt - HISTORY_RUN_LEASE_MS],
  })
  // Live peers may buffer new events before their next heartbeat. Their new
  // collection period must remain monitored if they stop before that flush.
  await session.execute({
    sql: "UPDATE capi_process_runs SET started_at=?,last_flush_at=NULL,payload_json=json_set(payload_json,'$.heartbeatAt',?) WHERE clean=0 AND ended_at IS NULL",
    args: [state.resetAt, state.resetAt],
  })
  if (runId) await renewRun(session, runId, state.resetAt)
}

export async function resetHistory(
  storage: Storage,
  context: MutationContext,
  options: { runId?: string; now: () => number },
): Promise<HistoryResetState> {
  const committed = await runMutation(
    storage,
    { ...context, kind: "history.reset", inputDigest: RESET_INPUT_DIGEST },
    async (session, revision) => {
      const previous = await readHistoryReset(session)
      const now = options.now()
      if (!Number.isSafeInteger(now) || now < 0)
        throw new StorageSchemaError("Invalid usage reset time")
      const state = { resetAt: Math.max(now, previous?.resetAt ?? 0), revision }
      for (const table of [
        "capi_usage_minutes",
        "capi_routing_minutes",
        "capi_collection_gaps",
      ])
        await session.execute({ sql: `DELETE FROM ${table}`, args: [] })
      await session.execute({
        sql: "UPDATE capi_usage_lifetime SET input_tokens=0,output_tokens=0,request_count=0,first_request_at=NULL WHERE id=1",
        args: [],
      })
      await session.execute({
        sql: "DELETE FROM capi_metadata WHERE key IN ('history_routing_lifetime','history_routing_started_at','history_collection_lifetime')",
        args: [],
      })
      await resetCollectionLeases(session, state, options.runId)
      await writeHistoryReset(session, state)
      return state
    },
  )
  const state = validateHistoryReset(committed.value)
  if (state.revision !== committed.revision)
    throw new StorageSchemaError("Invalid usage reset receipt")
  return state
}
