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
import {
  accountDistributionMigration,
  accountDistributionTables,
} from "~/lib/storage/migrations/007-account-distribution"
import {
  conversationModelsMigration,
  conversationModelTables,
} from "~/lib/storage/migrations/008-conversation-models"
import {
  conversationAccountModelMigration,
  conversationAccountModelTables,
} from "~/lib/storage/migrations/009-conversation-account-model"
import { usageTokenCountersMigration } from "~/lib/storage/migrations/010-usage-token-counters"
import {
  codexReasoningPreferencesMigration,
  codexReasoningPreferenceTables,
} from "~/lib/storage/migrations/011-codex-reasoning-preferences"
import {
  desktopGatewayAuthIndexes,
  desktopGatewayAuthMigration,
  desktopGatewayAuthTables,
} from "~/lib/storage/migrations/012-desktop-gateway-auth"

export const storageMigrations = [
  initialMigration,
  gatewaySecretsMigration,
  memoryOnlyDebugMigration,
  accountIntegrationMigration,
  removeActivityMigration,
  historyRetentionMigration,
  accountDistributionMigration,
  conversationModelsMigration,
  conversationAccountModelMigration,
  usageTokenCountersMigration,
  codexReasoningPreferencesMigration,
  desktopGatewayAuthMigration,
] as const

export const currentSchemaVersion = desktopGatewayAuthMigration.version
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
const versionSevenTables = {
  ...versionFiveTables,
  ...accountDistributionTables,
}
const versionEightTables = {
  ...versionSevenTables,
  ...conversationModelTables,
}
const versionTenTables = {
  ...versionEightTables,
  ...conversationAccountModelTables,
}
const versionElevenTables = {
  ...versionTenTables,
  ...codexReasoningPreferenceTables,
}
export const currentTables = {
  ...versionElevenTables,
  ...desktopGatewayAuthTables,
}
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
const versionElevenIndexes = {
  ...versionFiveIndexes,
  ...historyRetentionIndexes,
}
export const currentIndexes = {
  ...versionElevenIndexes,
  ...desktopGatewayAuthIndexes,
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
    case 6: {
      return {
        tables: versionFiveTables,
        indexes: versionElevenIndexes,
        counterKeys: currentCounterKeys,
      }
    }
    case 7: {
      return {
        tables: versionSevenTables,
        indexes: versionElevenIndexes,
        counterKeys: currentCounterKeys,
      }
    }
    case 8: {
      return {
        tables: versionEightTables,
        indexes: versionElevenIndexes,
        counterKeys: currentCounterKeys,
      }
    }
    case 9:
    case 10: {
      return {
        tables: versionTenTables,
        indexes: versionElevenIndexes,
        counterKeys: currentCounterKeys,
      }
    }
    case 11: {
      return {
        tables: versionElevenTables,
        indexes: versionElevenIndexes,
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
