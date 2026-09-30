/** Durable model transitions share SQLite with permanent account ownership. */
export const conversationModelTables = {
  capi_conversation_model_requests: `
    conversation_key BLOB PRIMARY KEY NOT NULL CHECK (typeof(conversation_key) = 'blob' AND length(conversation_key) = 32),
    request_sequence INTEGER NOT NULL CHECK (request_sequence BETWEEN 1 AND 9007199254740991)`,
  capi_conversation_models: `
    conversation_key BLOB NOT NULL REFERENCES capi_conversation_model_requests(conversation_key) ON DELETE RESTRICT CHECK (typeof(conversation_key) = 'blob' AND length(conversation_key) = 32),
    source_model TEXT NOT NULL,
    target_model TEXT NOT NULL,
    identity_signature TEXT NOT NULL,
    route_json TEXT NOT NULL,
    fingerprints_json TEXT NOT NULL,
    foreign_complete INTEGER NOT NULL CHECK (foreign_complete IN (0, 1)),
    request_sequence INTEGER NOT NULL CHECK (request_sequence BETWEEN 1 AND 9007199254740991),
    config_revision INTEGER NOT NULL CHECK (config_revision >= 0),
    redirect_revision INTEGER NOT NULL CHECK (redirect_revision >= 0),
    binding_signature TEXT NOT NULL,
    PRIMARY KEY (conversation_key, source_model)`,
} as const

export const conversationModelsMigration = {
  version: 8,
  name: "conversation-models",
  statements: [
    ...Object.entries(conversationModelTables).map(
      ([name, definition]) =>
        `CREATE TABLE ${name} (${definition}) WITHOUT ROWID`,
    ),
    "UPDATE capi_settings SET value_json=json_remove(value_json,'$.conversationAffinity','$.affinityTtlSeconds','$.affinityMaxEntries') WHERE namespace='model_fallbacks'",
  ],
} as const
