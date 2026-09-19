/** Permanent ownership is deliberately independent of scheduler/policy versions. */
export const accountDistributionTables = {
  capi_account_distribution: `
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    version INTEGER NOT NULL CHECK (version >= 1)`,
  capi_account_allocations: `
    account_id INTEGER PRIMARY KEY NOT NULL REFERENCES capi_accounts(id) ON DELETE RESTRICT,
    percentage INTEGER NOT NULL CHECK (typeof(percentage) = 'integer' AND percentage BETWEEN 1 AND 100)`,
  capi_conversation_accounts: `
    conversation_key BLOB PRIMARY KEY NOT NULL CHECK (typeof(conversation_key) = 'blob' AND length(conversation_key) = 32),
    account_id INTEGER NOT NULL REFERENCES capi_accounts(id) ON DELETE RESTRICT`,
  capi_account_scheduler: `
    scope TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    credits_json TEXT NOT NULL`,
} as const

export const accountDistributionMigration = {
  version: 7,
  name: "account-distribution",
  statements: Object.entries(accountDistributionTables).map(
    ([name, definition]) =>
      `CREATE TABLE ${name} (${definition})${name === "capi_conversation_accounts" ? " WITHOUT ROWID" : ""}`,
  ),
} as const
