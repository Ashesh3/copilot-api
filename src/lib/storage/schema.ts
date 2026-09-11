import { StorageSchemaError } from "~/lib/storage/errors"
import {
  initialIndexes,
  initialMigration,
  initialTables,
} from "~/lib/storage/migrations/001-initial"
import {
  gatewaySecretsMigration,
  gatewaySecretTables,
} from "~/lib/storage/migrations/002-gateway-secrets"
import { memoryOnlyDebugMigration } from "~/lib/storage/migrations/003-memory-only-debug"
import {
  accountIntegrationMigration,
  accountIntegrationTables,
} from "~/lib/storage/migrations/004-account-integration"
import { removeActivityMigration } from "~/lib/storage/migrations/005-remove-activity"
import {
  historyRetentionIndexes,
  historyRetentionMigration,
} from "~/lib/storage/migrations/006-history-retention"

export const storageMigrations = [
  initialMigration,
  gatewaySecretsMigration,
  memoryOnlyDebugMigration,
  accountIntegrationMigration,
  removeActivityMigration,
  historyRetentionMigration,
] as const

export const currentSchemaVersion = historyRetentionMigration.version
const versionTwoTables = { ...initialTables, ...gatewaySecretTables }
const versionThreeTables = Object.fromEntries(
  Object.entries(versionTwoTables).filter(([name]) => name !== "capi_debug"),
)
export const schemaThreeTables = versionThreeTables
const versionFourTables = { ...versionThreeTables, ...accountIntegrationTables }
const versionFiveTables = Object.fromEntries(
  Object.entries(versionFourTables).filter(
    ([name]) => name !== "capi_activity",
  ),
)
export const currentTables = versionFiveTables
const versionThreeIndexes = Object.fromEntries(
  Object.entries(initialIndexes).filter(
    ([, target]) => !target.startsWith("capi_debug("),
  ),
)
const versionFiveIndexes = Object.fromEntries(
  Object.entries(versionThreeIndexes).filter(
    ([, target]) => !target.startsWith("capi_activity("),
  ),
)
export const currentIndexes = {
  ...versionFiveIndexes,
  ...historyRetentionIndexes,
}
export const currentCounterKeys = ["config_revision"] as const

/** Preflight validates the applied schema before any destructive migration. */
export function storageSchema(version: number) {
  switch (version) {
    case 1:
    case 2: {
      return {
        tables: version === 1 ? initialTables : versionTwoTables,
        indexes: initialIndexes,
        counterKeys: [
          ...currentCounterKeys,
          "history_activity_generation",
          "history_debug_generation",
        ],
      }
    }
    case 3:
    case 4: {
      return {
        tables: version === 3 ? versionThreeTables : versionFourTables,
        indexes: versionThreeIndexes,
        counterKeys: [...currentCounterKeys, "history_activity_generation"],
      }
    }
    case 5: {
      return {
        tables: versionFiveTables,
        indexes: versionFiveIndexes,
        counterKeys: currentCounterKeys,
      }
    }
    case currentSchemaVersion: {
      return {
        tables: currentTables,
        indexes: currentIndexes,
        counterKeys: currentCounterKeys,
      }
    }
    default: {
      throw new StorageSchemaError("Unsupported schema version")
    }
  }
}
