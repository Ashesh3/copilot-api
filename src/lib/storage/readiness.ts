import type { StorageFailureReason } from "~/lib/storage/errors"
import type { Storage } from "~/lib/storage/types"

import { StorageUnavailableError, storageError } from "~/lib/storage/errors"

export interface StorageReadiness {
  ready: boolean
  engine: "sqlite"
  sqliteVersion?: string
  reason?: StorageFailureReason | "schema_missing" | "schema_invalid"
}

export async function probeStorage(
  storage: Storage,
  options: { requireSchema?: boolean } = {},
): Promise<StorageReadiness> {
  const result: StorageReadiness = { ready: false, engine: "sqlite" }
  try {
    await storage.read(async (session) => {
      const ping = await session.query({ sql: "SELECT 1 AS ok", args: [] })
      if (ping[0]?.ok !== 1) throw new StorageUnavailableError()
      const sqlite = await session.query({
        sql: "SELECT sqlite_version() AS version",
        args: [],
      })
      if (
        typeof sqlite[0]?.version !== "string"
        || !/^\d+\.\d+\.\d+$/.test(sqlite[0].version)
      )
        throw new StorageUnavailableError("unsupported_engine")
      result.sqliteVersion = sqlite[0].version
    })
    if (options.requireSchema !== false) {
      const rows = await storage.read((session) =>
        session.query({
          sql: "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
          args: ["table", "capi_metadata"],
        }),
      )
      if (rows.length !== 1) return { ...result, reason: "schema_missing" }
    }
    return { ...result, ready: true }
  } catch (error) {
    const mapped = storageError(error)
    return {
      ...result,
      reason:
        mapped instanceof StorageUnavailableError ?
          mapped.reason
        : "schema_invalid",
    }
  }
}
