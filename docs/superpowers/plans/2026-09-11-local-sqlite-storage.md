# Local SQLite Storage Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent implementation tasks and review the integrated result. Checkboxes track completion.

**Goal:** Remove remote database integration and provide an administrator download of the complete local SQLite database.

**Architecture:** Keep the existing local SQLite schema and repositories. Simplify storage construction to one backend, use a separate local Bun process for SQLite snapshot creation, and stream the resulting temporary file through the protected admin route.

**Tech Stack:** Bun 1.4.0, TypeScript, Hono, built-in SQLite, existing React/Astryx dashboard.

**Spec:** `docs/superpowers/specs/2026-09-11-local-sqlite-storage-design.md`

## Constraints

- No remote database driver, environment variables, SDK dependency, CI lane, or deployment example remains.
- Preserve current local database contents, schema, fixed filename, and Docker volume.
- No new package or remote service dependency; package commands use the approved internal npm registry.
- Export committed database state, including WAL pages; keep inference responsive during snapshot creation and download.
- Complete database export requires administrator session, CSRF, and current password; never accept inference authority.
- Preserve local encrypted CLI recovery compatibility; retire sanitized configuration ZIP exports and old admin backup panel.
- Work in the isolated `codex/sqlite-only-storage` checkout. No production changes or publishing.

## Task 1: SQLite-only backend and dependencies

Files: storage config/client/runtime/readiness, package.json and bun.lock, storage CLI messages, remote-only tests and shared fixtures.

- [x] Replace backend-selection tests with local path/default/explicit DATA_DIR tests and test local persistence with no fetch.
- [x] Run the affected tests against the current implementation; record expectations that change.
- [x] Remove remote adapter/imports/types and dependency. Preserve local Storage interface and existing schema semantics.
- [x] Remove remote-only fixtures and tests, update shared fixtures to stop managing removed environment variables.
- [x] Run SQLite contract, runtime, health, admission, migration, and compatibility tests.

## Task 2: Safe database download and admin UI

Files: new `src/lib/database-export.ts`, new dashboard database-export handler, dashboard route, DatabaseBackup/Settings UI, native export and route tests.

Interface: `POST /dashboard/api/database/export`, JSON `{ currentPassword: string }`, SQLite attachment response. The export service accepts the initialized SQLite path and an AbortSignal; it returns a response stream with owned cleanup.

- [x] Write regressions proving exported bytes are a valid SQLite database and include committed WAL data; prove source requests remain responsive and temp files are removed after cancellation.
- [x] Write route regressions rejecting anonymous, inference-only, wrong-password, missing-CSRF, and cross-origin requests; verify attachment and no-store headers.
- [x] Implement snapshot creation with built-in SQLite in a local Bun child process, a private temporary directory, bounded export concurrency, and cleanup.
- [x] Replace the old UI export/backup panel with one Export database action, existing password input, loading/error state, and brief sensitive-file copy.
- [x] Remove obsolete config ZIP implementation/route/tests. Keep local encrypted CLI backup/restore, moving the shared filename timestamp helper if still needed.
- [x] Build the dashboard to regenerate `page-generated.ts`; verify download using a disposable database.

## Task 3: Deployment and documentation

Files: Dockerfile, Compose files, .env.example, start.bat, CI, README, SECURITY, storage docs and obsolete plans.

- [x] Remove remote database variables, examples and CI workflow. Retain `/app/data` named volume and default DATA_DIR.
- [x] Replace storage runbook with SQLite setup, admin export, stopped-service restore from `.sqlite`, and retained CLI archive recovery instructions.
- [x] Update all current docs and compatibility descriptions; remove obsolete remote-specific designs from current checkout.
- [x] Validate Compose syntax, documentation links, and absence of removed integration identifiers.

## Task 4: Integration review and verification

- [x] Check no removed identifiers remain in tracked code, dependencies, generated UI or current docs.
- [x] Run targeted regressions, full Bun tests with isolation where existing global fixtures require it, backend/UI typechecks, lint and build.
- [x] Review combined diff and fix actionable findings, then repeat covering checks.
- [x] Report exact results, pending deployment status and local restore limitations.

## Verification recorded 2026-09-11

- Fresh-process unit suite: 4,133 pass, zero failures, 23 explicit Nginx opt-in skips across 260 files. Live upstream integrations were not run.
- Backend/UI typechecks and builds passed. Full lint: zero errors, five pre-existing warnings in unrelated response/UI code.
- Linux read-only-root/network-none Docker tests: 39 pass. Packaged server setup and full SQLite export passed with committed WAL fixture data, integrity_check=ok and no temporary exports left.
- Real Chromium dashboard login, rejected password, successful database download, secret/state contents, password reset, mobile layout and cleanup verified.
- Independent review: Windows local namespace regression corrected with red/green; native service and route review clean. Schema DDL and existing Docker volume are preserved.
- No production data migration, deployment, push or merge performed. Existing external deployment data requires an operator-controlled transfer before changing its storage deployment.
