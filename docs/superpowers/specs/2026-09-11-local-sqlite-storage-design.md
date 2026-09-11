# Local SQLite storage and database export

The user requested SQLite-only persistence on 2026-09-11. This supersedes previous remote database and sanitized configuration export designs.

Runtime persistence uses Bun's built-in SQLite driver and a fixed `copilot-api.sqlite` inside `DATA_DIR`. Docker keeps the entire data directory in its existing named volume. Remove the remote storage adapter, SDK dependency and lockfile records, environment variables, dedicated tests, deployment examples, CI jobs, and obsolete documentation. Keep the existing schema and local accounts, credentials, settings, history, and compatibility behavior. No new remote service or npm dependency is introduced.

Replace the administrator configuration ZIP export and encrypted-backup panel with an Export database panel. Its download is a complete standard SQLite database, including committed WAL data, stored credentials, and administrator state. It requires the current administrator password, an authenticated administrator session, and the existing same-origin CSRF check. Inference credentials alone cannot export it. The UI clearly states that the downloaded file contains secrets and is not encrypted.

Use a separate local Bun process and a read-only source connection to create a consistent SQLite snapshot in a private temporary directory. Do not copy the live database file or require a checkpoint. Snapshot work must not block the inference event loop, and streaming a slow download must not keep the source transaction open. Remove temporary files after download completion, cancellation, or failure. Only one export process may run at a time; normal inference continues.

Expose `POST /dashboard/api/database/export` with JSON `{ "currentPassword": "..." }`; return a SQLite attachment with `Cache-Control: no-store`. Retire the configuration ZIP route and its unused code. Retain the existing local encrypted CLI backup/restore facility for recovery of prior archives; it has no remote database integration. Existing deployment data is not moved or deleted automatically.

Validation covers local configuration, persistence across restarts, real SQL integrity and WAL visibility in exports, administrator and CSRF enforcement, cleanup on cancellation/error, backend/UI builds and typechecks, lint, and the project test suite. Exercise the UI download through a local disposable database when possible. Do not publish, deploy, or modify production data as part of this implementation.
