import type { SqlSession } from "~/lib/storage/types"

import { pruneHistoryBookkeeping } from "~/lib/storage/history-bookkeeping"

const MINUTE_MS = 60_000
const DAY_MS = 86400_000
const minute = (value: number) => Math.floor(value / MINUTE_MS) * MINUTE_MS

export async function pruneHistoryCounters(
  session: SqlSession,
  now: number,
): Promise<void> {
  for (const table of ["capi_usage_minutes", "capi_routing_minutes"]) {
    await session.execute({
      sql: `DELETE FROM ${table} WHERE minute < ?`,
      args: [minute(now - DAY_MS)],
    })
  }
  // One day exceeds the five-minute queue age and storage operation deadlines.
  await session.execute({
    sql: "DELETE FROM capi_applied_operations WHERE kind = 'history_batch' AND created_at < ?",
    args: [now - DAY_MS],
  })
  await pruneHistoryBookkeeping(session, now)
}
