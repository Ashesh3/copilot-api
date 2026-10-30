export const codexReasoningPreferenceTables = {
  capi_codex_reasoning_preferences: `
    account_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    overrides_json TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('migrated', 'user')),
    PRIMARY KEY (account_id, user_id)`,
} as const

export const codexReasoningPreferencesMigration = {
  version: 11,
  name: "codex-reasoning-preferences",
  statements: Object.entries(codexReasoningPreferenceTables).map(
    ([name, definition]) =>
      `CREATE TABLE ${name} (${definition}) WITHOUT ROWID`,
  ),
} as const
