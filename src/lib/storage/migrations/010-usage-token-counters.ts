import type { SqlSession } from "~/lib/storage/types"

const valid = (column: string) =>
  `(typeof(${column})='integer' AND ${column}>=0 AND ${column}<9007199254740991)`

const invalidInput = `NOT ${valid("input_tokens")}`
const invalidOutput = `NOT ${valid("output_tokens")}`
const invalid = `(${invalidInput} OR ${invalidOutput})`
const original = (column: string) =>
  `CASE WHEN typeof(${column}) IN ('integer','real') THEN CAST(${column} AS TEXT) ELSE 'invalid:' || typeof(${column}) END`

// TOTAL avoids SQLite int64 overflow. Below the safe-integer limit every
// nonnegative intermediate sum is exact; an unrepresentable sum has no usable
// JSON counter and is conservatively unavailable rather than rounded or clamped.
const retained = (column: string) =>
  `(SELECT CASE WHEN TOTAL(${column})<9007199254740991 THEN CAST(TOTAL(${column}) AS INTEGER) ELSE 0 END FROM capi_usage_minutes)`

const retainedOverflow = (column: string) =>
  `(SELECT TOTAL(CASE WHEN ${valid(column)} THEN ${column} ELSE 0 END)>=9007199254740991 FROM capi_usage_minutes)`

const combinedOverflow = `(${valid("input_tokens")} AND ${valid("output_tokens")} AND output_tokens>9007199254740990-input_tokens)`

// Prefix sums stay exact until the limit. Preserve that known prefix rather
// than retaining a rounded aggregate or substituting a saturation sentinel.
const trimOverflow = (column: string) =>
  `WITH running AS MATERIALIZED (
    SELECT minute,model,TOTAL(${column}) OVER (ORDER BY minute,model ROWS UNBOUNDED PRECEDING) AS total
    FROM capi_usage_minutes
  ) UPDATE capi_usage_minutes SET ${column}=0
    WHERE (minute,model) IN (SELECT minute,model FROM running WHERE total>=9007199254740991)`

const statements = [
  `INSERT INTO capi_collection_gaps(id,started_at,ended_at,kind,payload_json)
    SELECT 'invalid-token-counters-' || lower(hex(randomblob(16))),unixepoch()*1000,unixepoch()*1000,'unknown',
      json_object(
        'historyKind','usage',
        'unknown',json('true'),
        'reason','invalid-token-counters',
        'recovery','retained-valid-token-minimum',
        'originalLifetimeInputTokens',${original("input_tokens")},
        'originalLifetimeOutputTokens',${original("output_tokens")},
        'invalidInputBuckets',(SELECT COUNT(*) FROM capi_usage_minutes WHERE ${invalidInput}),
        'invalidOutputBuckets',(SELECT COUNT(*) FROM capi_usage_minutes WHERE ${invalidOutput}),
        'overflowingRetainedInput',${retainedOverflow("input_tokens")},
        'overflowingRetainedOutput',${retainedOverflow("output_tokens")},
        'overflowingCombinedLifetime',${combinedOverflow}
      )
    FROM capi_usage_lifetime WHERE id=1 AND (
      ${invalid} OR EXISTS(SELECT 1 FROM capi_usage_minutes WHERE ${invalid})
      OR ${retainedOverflow("input_tokens")} OR ${retainedOverflow("output_tokens")}
      OR (${combinedOverflow} AND NOT EXISTS (
        SELECT 1 FROM capi_collection_gaps
        WHERE json_extract(payload_json,'$.reason')='invalid-token-counters'
          AND json_extract(payload_json,'$.originalLifetimeInputTokens')=${original("input_tokens")}
          AND json_extract(payload_json,'$.originalLifetimeOutputTokens')=${original("output_tokens")}
          AND json_extract(payload_json,'$.overflowingCombinedLifetime')=1
      ))
    )`,
  `UPDATE capi_usage_minutes SET
    input_tokens=CASE WHEN ${invalidInput} THEN 0 ELSE input_tokens END,
    output_tokens=CASE WHEN ${invalidOutput} THEN 0 ELSE output_tokens END
    WHERE ${invalid}`,
  trimOverflow("input_tokens"),
  trimOverflow("output_tokens"),
  `UPDATE capi_usage_lifetime SET
    input_tokens=CASE WHEN ${invalidInput} THEN ${retained("input_tokens")} ELSE input_tokens END,
    output_tokens=CASE WHEN ${invalidOutput} THEN ${retained("output_tokens")} ELSE output_tokens END
    WHERE id=1 AND ${invalid}`,
] as const

/** Repair before pruning; discarded rounded totals cannot reconstruct history. */
export const usageTokenCountersMigration = {
  version: 10,
  name: "usage-token-counters",
  statements,
} as const

/** Restores/imports write into an already migrated replacement database. */
export async function repairUsageTokenCounters(
  session: SqlSession,
): Promise<void> {
  for (const sql of statements) await session.execute({ sql, args: [] })
}
