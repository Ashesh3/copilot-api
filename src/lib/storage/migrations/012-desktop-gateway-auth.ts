export const desktopGatewayAuthTables = {
  capi_desktop_device_grants: [
    "device_digest TEXT PRIMARY KEY NOT NULL,",
    "user_code_digest TEXT NOT NULL UNIQUE,",
    "issuer TEXT NOT NULL,",
    "client_id TEXT,",
    "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','consumed')),",
    "credential_kind TEXT CHECK (credential_kind IN ('gateway','inference')),",
    "credential_id TEXT,",
    "credential_digest TEXT,",
    "created_at INTEGER NOT NULL,",
    "expires_at INTEGER NOT NULL,",
    "interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),",
    "next_poll_at INTEGER NOT NULL,",
    "approved_at INTEGER,",
    "consumed_at INTEGER",
  ].join("\n"),
  capi_desktop_auth_sessions: [
    "id TEXT PRIMARY KEY NOT NULL,",
    "principal_id TEXT NOT NULL UNIQUE,",
    "issuer TEXT NOT NULL,",
    "client_id TEXT,",
    "credential_kind TEXT NOT NULL CHECK (credential_kind IN ('gateway','inference')),",
    "credential_id TEXT NOT NULL,",
    "credential_digest TEXT NOT NULL,",
    "refresh_digest TEXT NOT NULL UNIQUE,",
    "refresh_expires_at INTEGER NOT NULL,",
    "created_at INTEGER NOT NULL,",
    "updated_at INTEGER NOT NULL,",
    "revoked_at INTEGER",
  ].join("\n"),
  capi_desktop_access_tokens: [
    "digest TEXT PRIMARY KEY NOT NULL,",
    "session_id TEXT NOT NULL REFERENCES capi_desktop_auth_sessions(id) ON DELETE CASCADE,",
    "created_at INTEGER NOT NULL,",
    "expires_at INTEGER NOT NULL",
  ].join("\n"),
} as const

export const desktopGatewayAuthIndexes = {
  capi_desktop_device_expiry: "capi_desktop_device_grants(expires_at)",
  capi_desktop_access_session: "capi_desktop_access_tokens(session_id)",
  capi_desktop_access_expiry: "capi_desktop_access_tokens(expires_at)",
} as const

export const desktopGatewayAuthMigration = {
  version: 12,
  name: "desktop-gateway-auth",
  statements: [
    ...Object.entries(desktopGatewayAuthTables).map(
      ([name, definition]) =>
        "CREATE TABLE " + name + " (" + definition + "\n)",
    ),
    ...Object.entries(desktopGatewayAuthIndexes).map(
      ([name, target]) => "CREATE INDEX " + name + " ON " + target,
    ),
  ],
} as const
