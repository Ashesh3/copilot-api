/** Retain one day of usage/routing detail and index receipt cleanup selectively. */
export const historyRetentionIndexes = {
  capi_operations_kind_created: "capi_applied_operations(kind, created_at)",
} as const

export const historyRetentionMigration = {
  version: 6,
  name: "history-retention",
  statements: [
    "DELETE FROM capi_usage_minutes WHERE minute < ((unixepoch() - 86400) / 60) * 60000",
    "DELETE FROM capi_routing_minutes WHERE minute < ((unixepoch() - 86400) / 60) * 60000",
    `CREATE INDEX capi_operations_kind_created ON ${historyRetentionIndexes.capi_operations_kind_created}`,
  ],
} as const
