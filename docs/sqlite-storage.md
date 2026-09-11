# Local SQLite storage

Accounts, provider secrets, settings, administrator and client credentials,
usage, and routing history live in one local SQLite database. Persistence uses
Bun's built-in `bun:sqlite` driver; no database service or external SQLite
package is required. LLM Debug captures remain process-local. JSON is an API
format and an explicit legacy import source, not a parallel runtime store.
See the [table review](database-table-review.md) for table purposes and retention.

Commands below use `bun src/main.ts` from a source checkout. An installed build
exposes the same commands as `copilot-api`; the container entrypoint accepts
the command directly after the image or Compose service name.

## Database location and Docker persistence

The fixed filename is `copilot-api.sqlite` inside `DATA_DIR`, which defaults to
`~/.local/share/copilot-api`. The image sets `DATA_DIR=/app/data`; the tracked
Compose service keeps that path fixed and mounts the named
`copilot-api_copilot-data` volume there. New installations create that volume
automatically. The name is unchanged for existing installations.

Mount the entire directory so the database, `copilot-api.sqlite-wal`, and
`copilot-api.sqlite-shm` share durable storage. Use a local filesystem suitable
for SQLite WAL and restrict directory access: gateway, upstream, and provider
credentials are recoverable database values. Do not copy a live database file
by itself or remove its sidecars while a process has the database open.

Existing data directories and legacy source files are not moved, deleted, or
imported automatically. Changing `DATA_DIR` or a volume mount selects a different
local database; it does not transfer data. Preserve the original directory or
volume while validating any replacement.

For a new installation:

```sh
docker compose build
docker compose run --rm --no-deps copilot-api admin --setup-code
docker compose up -d
```

For an existing configured volume, omit `admin --setup-code`. Both setup and the
serving process must use the same volume. Keep the host port bound to loopback
unless the deployment explicitly requires otherwise. Configure the exact
`COPILOT_ADMIN_ORIGIN` and `COPILOT_TRUSTED_PROXY_CIDRS` for a reverse proxy.

Database exports need temporary space for a complete snapshot inside the
writable data volume. The image also has a writable temporary directory by
default. A deployment using `--read-only` must provide a writable `/tmp` mount
for large debug captures' temporary buffers, which are removed after collection.

## Initial setup and credentials

For a source checkout, issue a setup code and start the server with the same
`DATA_DIR`:

```sh
bun src/main.ts admin --setup-code
bun src/main.ts start --host 127.0.0.1
```

Open `/dashboard`. Supply the one-use code, a new long random gateway key, and
an administrator password. Codes expire after 15 minutes and are issued only
for an unconfigured database. Setup needs no GitHub account. Add GitHub.com or
GitHub Enterprise Cloud accounts, providers, and the optional Groq credential
through the dashboard. The `config` CLI also manages accounts, replacements,
and providers in SQLite.

The accounts page provides **Refresh models** per account and **Refresh all
models**. Each refresh has its own bounded operation. Failed refreshes retain
the previous catalog and do not prevent the remaining accounts from refreshing.
Refresh preserves enablement and routing policy, includes disabled accounts
without enabling them, and excludes accounts being removed.

Gateway keys are recoverable values in `capi_gateway_secrets`, alongside indexed
digests in gateway metadata. OAuth and inference credentials remain digest-only;
administrator passwords use Argon2id. Routine secret listings omit raw values.
Administrators can add, reveal, copy, and permanently delete gateway keys except
the last active key. Provider and Groq reveal endpoints require an administrator
session, CSRF and Origin checks, and return no-store responses.

### Gateway-key schema upgrade

Migration `002` adds the separate gateway-secret table and removes old digest-only
gateway rows. It never reconstructs old keys, accepts a legacy digest as
authentication, or generates a replacement automatically. Preserve a backup and
arrange a replacement raw key before resuming service. Existing administrator
sessions remain valid, but new sign-ins and API clients need a newly provisioned
gateway key. Administrator passwords, accounts, provider credentials,
OAuth/inference records, settings, and history are retained.

`start` does not load JSON credentials or admit credentials from `GITHUB_TOKENS`,
`GH_TOKEN`, `COPILOT_API_KEY_AUTH`, `COPILOT_INFERENCE_CREDENTIAL_SHA256S`,
`COPILOT_ADMIN_PASSWORD_HASH`, `GROQ_API_KEY`, or provider `apiKeyEnv`. The old
`--github-token` and `--api-key-auth` runtime flags are rejected. `auth` performs
browser or device authentication, validates the account and Copilot access, and
saves the account without printing its credential.

If the administrator password is lost, use the trusted local console:

```sh
bun src/main.ts admin --reset
```

Hidden interactive input and confirmation replace the password and revoke all
dashboard sessions. Gateway credentials are retained; login still requires a
valid gateway key. `admin --hash-password` creates an Argon2id verifier for
explicit legacy import, not an environment-managed runtime password.

## Export the database

In Settings, choose **Export database**, enter the current administrator
password, and download the `.sqlite` file. This is a complete, consistent
snapshot of committed state, including committed WAL contents, stored secrets,
administrator state, settings, and history. **The file contains secrets and is
not encrypted.** Keep it in protected storage and never attach it to public
issues or logs.

The API is `POST /dashboard/api/database/export` with JSON
`{ "currentPassword": "..." }`. It requires an authenticated administrator
session, the current password, and the existing same-origin CSRF checks.
Inference credentials alone cannot export the database. The response is a
SQLite attachment with `Cache-Control: no-store`.

A separate local Bun process opens a read-only source connection and creates a
consistent snapshot in a private `.database-export-*` directory inside
`DATA_DIR`. Only one export runs at a time. The process closes its source
connection before streaming the result,
so a slow download does not hold the source snapshot open. Inference continues
during snapshot creation and download. Completion, cancellation, and failure
remove the temporary files. Unflushed telemetry and process-local debug captures
are not committed database state and do not appear in the snapshot.

## Restore a database download

There is no dashboard upload that overwrites a running database. Restore only
an operator-trusted `.sqlite` download, using a stopped service and a separate
replacement directory or volume:

1. Stop every process using the target database, including gateway containers
   and maintenance commands. For the tracked service, run
   `docker compose stop copilot-api`.
2. Preserve the original data directory or volume intact for rollback. Keep the
   database and any remaining WAL/SHM sidecars together. Do not run
   `docker compose down -v` or delete the existing volume.
3. Prepare an empty replacement directory or volume. Copy the downloaded
   database into it as `copilot-api.sqlite`, with permissions allowing the server
   to access it. The download is self-contained: do not copy old WAL/SHM files
   into the replacement. If reusing a stopped directory, first preserve its
   entire old database and sidecar set together, then ensure none of those old
   sidecars remain alongside the replacement file.
4. Validate the replacement file with SQLite's `PRAGMA integrity_check` through
   Bun's built-in driver. It must return `ok`. Configure `DATA_DIR` for the
   replacement directory or explicitly mount the replacement volume at
   `/app/data`. Do not point both old and new deployments at the same writable
   database.
5. Start the replacement and check `/health/ready`, administrator login, account
   identities, providers, settings, and expected history. Retain the original
   until these checks pass. To roll back, stop the replacement and reattach the
   untouched original directory or volume.

For Docker, a local Compose override can select a separately prepared volume
without changing the tracked default. For example, after creating and populating
an empty volume named `copilot-api-restored`, use an operator-owned
`compose.restore.yml`:

```yaml
volumes:
  copilot-data:
    name: copilot-api-restored
    external: true
```

Start it with `docker compose -f docker-compose.yml -f compose.restore.yml up -d`.
Use the same file pair for later lifecycle commands while serving the replacement.
The original `copilot-api_copilot-data` volume remains available for rollback.

A raw database restore preserves the administrator-session records present in
the snapshot. Run `admin --reset` against the restored database if those
sessions should be revoked. Active sockets, bridge jobs, and connection-local
conversation state cannot be resumed from a database download.

## Encrypted CLI archives

The local `storage backup` and `storage restore` commands remain available for
password-encrypted logical archives, including compatible older archives. They
are separate from the native `.sqlite` download. The CLI uses a password-derived
key and authenticated AES-256-GCM encryption, with hidden interactive password
input. It refuses to write binary backup data to a terminal. In a shell that
preserves binary stdout:

```sh
bun src/main.ts storage backup > /operator-owned/copilot-api.backup
```

Do not pass the password in arguments or environment variables; neither is
supported. Preserve binary output when redirecting, especially with older
Windows shells. Protect both archive and password.

Backup and restore have a 30-minute transfer deadline. Unlike the native
database download, the logical archive holds a consistent read snapshot while
streaming. A slow destination can retain the snapshot and grow the SQLite WAL;
allow disk headroom and schedule large archives during quieter write periods.
Frames and page/batch aggregation are bounded, but a single logical row or field
is materialized in memory. Restore only trusted archives with enough memory for
their largest value.

Set `DATA_DIR` to an empty replacement directory before restoring. Do not start
the server against that directory first, since initialized settings make it an
occupied target. Then run:

```sh
bun src/main.ts storage restore --input /operator-owned/copilot-api.backup
```

The importer authenticates the archive, validates its schema and relationships,
and refuses an occupied target. Logical restore preserves account IDs and client
credential state while invalidating administrator sessions. Schema-5 archives
include gateway raw-secret records and validate them against their digests.
Restore also accepts schemas 2, 3, and 4, skipping retired debug and Activity
records. Schema-1 digest-only gateway archives are rejected.

An interrupted or definitely rolled-back transfer leaves an incomplete marker
that blocks readiness. To abandon only that transfer, use the exact reported ID:

```sh
bun src/main.ts storage discard-incomplete --restore-id EXACT_TRANSFER_ID
```

If a commit outcome cannot be confirmed, the CLI reports
`storage_commit_unknown` and an operation ID. A matching receipt permits
reconciliation; do not discard or serve an unverified replacement. Preserve the
source, validate the restored state, and use the same stopped-service cutover
and rollback procedure described above.

## Explicit legacy import

Stop the legacy writer and retain its complete directory. Set `DATA_DIR` to a
new empty replacement directory. Do not start the server against the replacement
before import. Preview reads supported source files without changing them:

```sh
bun src/main.ts storage import-legacy --from /absolute/legacy-data
```

Review `sourceDigest`, `expectedTargetRevision`, counts, and warnings. Apply
with the exact preview values:

```sh
bun src/main.ts storage import-legacy --from /absolute/legacy-data \
  --apply --source-digest SOURCE_DIGEST --expected-revision TARGET_REVISION
```

Source drift, invalid input, duplicate/conflicting identities, occupied targets,
and revision changes reject the transfer. Supported account, configuration,
policy, OAuth, administrator, and usage inputs preserve stable account IDs and
lifetime usage totals and the most recent 24 hours of minute/model usage.
Administrator sessions are invalidated. Source files are never rewritten or
removed.

To include selected legacy environment credentials, add `--from-env` to both
preview and apply with the same environment. It reads `GITHUB_TOKENS` (or
`GH_TOKEN`), `COPILOT_API_KEY_AUTH`, `COPILOT_INFERENCE_CREDENTIAL_SHA256S`,
`COPILOT_ADMIN_PASSWORD_HASH`, `GROQ_API_KEY`, and credential names referenced by
imported providers' `apiKeyEnv`. It does not import the entire process environment.
Referenced provider credentials must be present. After import, validate login,
accounts, providers, readiness, and history before retiring the old deployment.

## History, outages, and readiness

Committed usage and routing minute detail have rolling 24-hour retention.
Older detail is deleted during migration, collector startup, transfer completion,
and idle maintenance. Cleanup uses minute boundaries and runs every 30 seconds
while the collector is active; locks, outages, or a stopped server can defer it.
Future-dated records in compatible imported archives retain their timestamps
rather than being rewritten, and expire as their retention boundary passes.
Only scalar lifetime token/request totals persist beyond that window. The usage
API and dashboard expose Last 24 hours and Lifetime; five-hour and seven-day
sections are removed, and no seven-day rollup is stored. Activity was removed
in version 5.1.0. LLM Debug keeps original request/response text, headers, URLs,
and errors only in the
serving process's capture store. Successful captures expire ten minutes after
`startedAt`; other statuses expire after one hour. The store is capped at 2,000
entries and a shared 128 MiB working budget, with whole-entry eviction and one
oversized entry allowed alone. Clear and restart remove captures.

Migration `003` removes persistent debug captures, `004` adds account integration
IDs, `005` drops Activity, and `006` prunes usage/routing detail to 24 hours and
indexes receipt cleanup by kind and time. The current schema still has
27 application tables.
Existing external archives and operator copies are not erased by migration.

Maintenance compacts collection-gap intervals older than 24 hours into one
set of lifetime loss counters, removes unreferenced clean process-run records,
and deletes expired administrator sessions and temporary login records.
Active credentials and durable mutation receipts remain authoritative and are
not deleted just because they are old. Unclean process identities also remain
so a paused process can resume safely. Configuration, identity, and receipt
growth can still increase database size. SQLite reuses freed pages; history
expiry does not force an immediate reduction in the file's size.

The pending telemetry queue carries usage, routing, and collection-gap records.
It retries writes and is bounded to 2,000 records, 16 MiB, and five minutes.
Outages and pressure can drop records; recent collection gaps remain explicit. This
queue does not make database-backed request admission independent of SQLite
availability. A missing, inaccessible, or locked local database can still affect
request admission.

`GET /health` and `GET /health/health` are metadata-free liveness endpoints.
`GET /health/ready` returns `200` when SQLite is available and no incomplete
transfer exists, or `503` otherwise. Docker and Compose use readiness for their
healthchecks. Check the volume mount, directory permissions, disk space, and
incomplete-transfer status if the container is unhealthy.
