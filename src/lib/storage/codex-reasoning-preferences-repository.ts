import { z } from "zod"

import type { AccountClaims } from "~/lib/codex-account-identity"
import type { SqlSession } from "~/lib/storage/types"

import { StorageSchemaError } from "~/lib/storage/errors"
import { getStorageRuntime } from "~/lib/storage/runtime"

// Every effort understood by Desktop 26.1027 is available by default. This is
// a display preference, never a gateway plan or inference capability filter.
export const codexReasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
] as const

export const codexReasoningOverridesSchema = z.partialRecord(
  z.enum(codexReasoningEfforts),
  z.boolean(),
)
type Overrides = z.infer<typeof codexReasoningOverridesSchema>
type Source = "default" | "migrated" | "user"
interface StoredPreference {
  overrides: Overrides
  source: Exclude<Source, "default">
}

export function decodeStoredCodexReasoningPreference(
  row: Record<string, unknown>,
): StoredPreference {
  try {
    if (
      typeof row.account_id !== "string"
      || row.account_id.length === 0
      || typeof row.user_id !== "string"
      || row.user_id.length === 0
      || typeof row.overrides_json !== "string"
      || (row.source !== "user" && row.source !== "migrated")
    ) {
      throw new StorageSchemaError("Invalid Codex reasoning preference")
    }
    return {
      overrides: codexReasoningOverridesSchema.parse(
        JSON.parse(row.overrides_json),
      ),
      source: row.source,
    }
  } catch {
    throw new StorageSchemaError("Invalid Codex reasoning preference")
  }
}

function identityArgs(claims: AccountClaims): [string, string] {
  return [claims.chatgpt_account_id, claims.chatgpt_user_id]
}

function displayPreference(stored: StoredPreference | null) {
  return {
    enabled: codexReasoningEfforts.filter(
      (effort) => stored?.overrides[effort] !== false,
    ),
    source: stored?.source ?? "default",
    uses_defaults:
      stored === null || Object.keys(stored.overrides).length === 0,
  }
}

async function loadPreference(
  session: SqlSession,
  claims: AccountClaims,
): Promise<StoredPreference | null> {
  const rows = await session.query({
    sql: "SELECT account_id, user_id, overrides_json, source FROM capi_codex_reasoning_preferences WHERE account_id=? AND user_id=?",
    args: identityArgs(claims),
  })
  const row = rows.at(0)
  if (!row) return null
  return decodeStoredCodexReasoningPreference(row)
}

export function readCodexReasoningPreference(claims: AccountClaims) {
  return getStorageRuntime().storage.read(async (session) =>
    displayPreference(await loadPreference(session, claims)),
  )
}

export function updateCodexReasoningPreference(
  claims: AccountClaims,
  changes: Overrides,
  migrate: boolean,
) {
  return getStorageRuntime().storage.transaction(async (session) => {
    const previous = await loadPreference(session, claims)
    if (migrate && previous !== null) return null
    const stored: StoredPreference = {
      overrides:
        Object.keys(changes).length === 0 ?
          {}
        : { ...previous?.overrides, ...changes },
      source: migrate ? "migrated" : "user",
    }
    await session.execute({
      sql: "INSERT INTO capi_codex_reasoning_preferences(account_id,user_id,overrides_json,source) VALUES(?,?,?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET overrides_json=excluded.overrides_json,source=excluded.source",
      args: [
        ...identityArgs(claims),
        JSON.stringify(stored.overrides),
        stored.source,
      ],
    })
    return displayPreference(stored)
  })
}
