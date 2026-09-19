# Database table review

This source audit covers the 31 application tables in schema 7. Schema 3 removed
`capi_debug`, schema 4 added per-account integration IDs, and schema 5 removed
`capi_activity`. Schema 6 adds selective receipt indexing and 24-hour detail
retention without adding a table. Schema 7 adds account percentage policy,
allocations, scheduler state and permanent conversation ownership. The table definitions come from
[migration 001](../src/lib/storage/migrations/001-initial.ts),
[migration 002](../src/lib/storage/migrations/002-gateway-secrets.ts), and the
[current schema](../src/lib/storage/schema.ts).

Tables are created regardless of whether their associated feature is used.
Their existence does not establish live use or stored row counts. No live
database was queried for this review. SQLite system objects and indexes
are excluded from the count. Every baseline application table has a source
consumer; none is wholly unused.

LLM Debug remains outside the database. Usage/routing detail now has rolling
24-hour retention, and retired operational detail is compacted or removed.
Remaining proposals below are separate from the implemented retention policy.
"Keep" means needed for the current feature and behavior; it does not mean every
installation uses that feature.

| Table | Why it exists / what it stores | Actual retention | Review direction |
| --- | --- | --- | --- |
| [capi_metadata](../src/lib/storage/migrations.ts) | Store identity, schema/config revisions, transfer markers, and routing lifetime counters. Startup and configuration reads/writes use these values. | Persistent small set; temporary transfer markers removed on completion. | Keep. Remove only retired keys through migrations. |
| [capi_schema_migrations](../src/lib/storage/migrations.ts) | Applied migration versions, names, checksums, and timestamps. Startup checks database compatibility. | One row per applied migration. | Keep. |
| [capi_applied_operations](../src/lib/storage/operations.ts) | Mutation receipts: operation ID, actor, input digest, committed revision, and safe result metadata. Used to reconcile uncertain commits and avoid duplicate writes. | History-batch receipts pruned after 24 hours at startup and during idle maintenance; other receipts have no routine cleanup. | Keep the mechanism; non-history receipts preserve durable retry/unknown-commit identities. |
| [capi_settings](../src/lib/storage/settings-repository.ts) | Current app configuration, replacements, model redirects/settings/routing/fallbacks, feature flags, and Statsig overrides, with revisions. | Current values overwritten; persistent. | Keep. Already consolidates eight settings domains. |
| [capi_accounts](../src/lib/storage/accounts-repository.ts) | Stable upstream account IDs, domain/user/login/label, enabled/deletion state, and validation/credential revisions. Used by account management and routing. | Persistent; deleted accounts leave metadata tombstones. | Keep for Copilot accounts. Stable IDs preserve associations. |
| [capi_account_credentials](../src/lib/storage/accounts-repository.ts) | Recoverable upstream OAuth token for each account. Loaded into the account pool for upstream authentication. | Replaced on credential changes; deleted on account removal. | Keep data. Separate table permits metadata reads without tokens. |
| [capi_account_distribution](../src/lib/storage/account-distribution-repository.ts) | Dedicated version of the applied percentage policy. | One row after activation. | Keep separate from request-level writes and global configuration revision. |
| [capi_account_allocations](../src/lib/storage/account-distribution-repository.ts) | Positive configured percentage per stable account ID; absent accounts have 0%. | Replaced atomically on an explicit save; deleted account metadata remains referentially valid. | Keep. |
| [capi_conversation_accounts](../src/lib/storage/account-distribution-repository.ts) | 32-byte identity digest and permanent numeric account owner, in a WITHOUT ROWID table. | No automatic expiry or eviction; grows with distinct conversations. | Keep to preserve ownership through percentage edits and restarts. |
| [capi_account_scheduler](../src/lib/storage/account-distribution-repository.ts) | Small weighted round-robin credits scoped to model, eligible accounts and allocation version. | Cleared on a changed allocation policy; otherwise persists through restart. | Keep atomic with new conversation assignment. |
| [capi_providers](../src/lib/storage/providers-repository.ts) | Custom provider identity, base URL, model/alias configuration, enabled/deleted state, and revision. Used by routing and provider settings. | Persistent; removal leaves a metadata tombstone. | Keep if custom providers are wanted. |
| [capi_provider_secrets](../src/lib/storage/providers-repository.ts) | Recoverable provider API key and custom header values. Used for outgoing calls and explicit credential reveal. | Replaced on edit; deleted when provider removed. | Keep data for custom providers; separate metadata/secret access is useful. |
| [capi_service_secrets](../src/lib/storage/providers-repository.ts) | Service credentials; currently only the Groq transcription key. | Until replaced or explicitly cleared. | Optional feature; possible shared-secret-table candidate. |
| [capi_gateway_credentials](../src/lib/storage/credentials-repository.ts) | Gateway-key IDs, digests, labels, and timestamps. Used for gateway authentication and credential management. | Until explicitly deleted; the last active key cannot be deleted. | Keep for gateway access. `last_used_at` is currently unused. |
| [capi_gateway_secrets](../src/lib/storage/credentials-repository.ts) | Recoverable gateway-key values linked to metadata, supporting reveal/copy and current authentication checks. | Deleted with the parent gateway credential. | Keep for current behavior. A digest cannot provide reveal/copy. |
| [capi_inference_credentials](../src/lib/storage/policy-repository.ts) | Hashed inference-only credentials, principal/scopes, kind, label, and enabled/revoked state. Used for managed JWT digests and OAuth-issued API keys. | No expiry; explicit revocation. Managed entries can be deleted. | Keep if these client credentials are wanted. Already shares two credential kinds. |
| [capi_ip_allowlist](../src/lib/storage/policy-repository.ts) | Allowed IPs, enabled/source state, and timestamps. Read by access policy and updated by administrators or authenticated promotion. | Until removed/cleared; no automatic expiry. | Keep if retaining IP allowlisting. |
| [capi_admin](../src/lib/storage/admin-repository.ts) | Singleton administrator password hash and session version. Used by dashboard setup/login/password changes. | Persistent singleton. | Keep for administrator authentication. |
| [capi_admin_sessions](../src/lib/storage/admin-repository.ts) | Hashed session/CSRF tokens, session version, and expiry. Used for dashboard authentication, logout, and invalidation. | Rolling 30-day validity; login and idle maintenance delete expired/old-version rows, logout deletes its row, password change deletes all. | Keep for restart-persistent logins; memory-only would require login after restart. |
| [capi_setup_codes](../src/lib/storage/admin-repository.ts) | Hashed one-time CLI setup codes and consumed/invalidated timestamps. Connects a separate CLI setup command to the dashboard. | Valid 15 minutes; records expired for over 24 hours are deleted by maintenance. Restore clears them. | Keep cross-process setup; expired records are now pruned. |
| [capi_device_login_intents](../src/lib/storage/device-login-repository.ts) | Pending GitHub device-login codes, owner, polling lease, expiry, and resulting account. Used by dashboard account onboarding. | Upstream-defined expiry; codes cleared on completion/cancel/failure. rows expired for over 24 hours are deleted by maintenance. | Keep coordination; expired rows now receive routine cleanup. |
| [capi_oauth_codes](../src/lib/storage/oauth-repository.ts) | Hashed temporary authorization codes, client/redirect/scopes/state, and PKCE binding. Used for code exchange. | Valid 2 minutes and single-use. records expired for over 24 hours are removed by maintenance. | Keep OAuth exchange; expired grants are now pruned. |
| [capi_oauth_families](../src/lib/storage/oauth-repository.ts) | Groups related access/refresh tokens under one client/principal/grant for collective revocation. | Until revoked; revoked rows retained. | Keep grant grouping if OAuth remains. |
| [capi_oauth_access](../src/lib/storage/oauth-repository.ts) | Access-token digests with family/client/principal/scopes. Used to authorize OAuth clients. | Valid until explicit revocation; each refresh adds an access token; no cleanup. | Keep data; consider combining access and refresh rows in a typed-token table. |
| [capi_oauth_refresh](../src/lib/storage/oauth-repository.ts) | Refresh-token digests and grant binding. Used to issue additional access tokens. | Deliberately reusable until explicit revocation; no cleanup. | Possible consolidation with access tokens while preserving their distinct authority. |
| [capi_usage_minutes](../src/lib/storage/history-repository.ts) | Minute/model input/output token totals and request counts; no request or response bodies. Powers the Last 24 hours summary. | At most the recent 24-hour window for normal runtime timestamps; older detail deleted during migration, startup/idle maintenance and transfer completion. | Keep recent counters; lifetime numbers use the singleton below. |
| [capi_usage_lifetime](../src/lib/storage/history-repository.ts) | Singleton lifetime token/request totals and first-request time. Used by usage summaries. | Persistent singleton. | Keep if lifetime totals are wanted; permits independent pruning of old minute detail. |
| [capi_routing_minutes](../src/lib/storage/history-repository.ts) | Minute aggregates of calls, retries, failovers, outcomes, models, routes, and accounts. Powers the routing dashboard. | 24-hour detail, pruned at startup and during idle maintenance; lifetime totals retained in metadata. | Optional analytics. Simplify unused dimension/account columns if kept. |
| [capi_imports](../src/lib/storage/legacy-import.ts) | Completed legacy-import receipt with source digest, revision, timestamp, and counts. Prevents duplicate import of the same source. | Permanent; used by import commands. | Could move into metadata or an existing receipt store while preserving deduplication. |
| [capi_process_runs](../src/lib/storage/history-repository.ts) | History-collector startup, last flush, clean shutdown, and end timestamps. Detects potentially unflushed prior runs. | Clean ended runs older than 24 hours are removed when no retained gap references them. Unclean identities remain so a paused process can resume. | Clean history is bounded; unclean process identities need explicit recovery semantics before deletion. |
| [capi_collection_gaps](../src/lib/storage/history-repository.ts) | Lost-record/byte counts and unknown intervals after queue drops, uncertain writes, or unclean shutdowns. Feeds collection-status indicators. | Intervals older than 24 hours are atomically replaced by fixed lifetime numeric counters in metadata. Recent interval detail remains. | Implemented compaction preserves lifetime loss reporting; expired time-window details are intentionally unavailable. |

## Retention boundaries

Usage and routing have rolling 24-hour retention of minute detail; there is no
seven-day rollup. Only lifetime scalar token/request/loss totals persist beyond
the detail window. LLM Debug and Activity have no runtime database tables.
Startup and idle maintenance remove expired transient login records and compact
old collection gaps. Cleanup uses minute boundaries and a 30-second maintenance
cadence; locks, outages, or a stopped collector can defer it. Compatible imported
future timestamps are preserved and expire as their retention boundary passes.

The database is not a fixed byte-size file: configured accounts, active credential digests, operator settings and reconciliation receipts are durable authority, and their size follows configured use. Deleting an active OAuth token solely by age would break an existing client; dropping a mutation receipt prematurely could replay a previously committed change. Those rows are preserved. SQLite can reuse freed pages; deleting old rows does not force the file to shrink immediately.

Small schema candidates also exist: the routing writer always uses
`dimension_key='aggregate'` and never fills SQL `account_id`; account breakdown
is inside the aggregate JSON. Its account index and gateway `last_used_at` have
no current runtime use.
These should be changed through a schema migration with their consumers, since
startup validates the expected schema.

OAuth access/refresh/family records intentionally remain valid until explicit
revocation, even when imported expiry metadata exists; see the
[OAuth contract](../src/lib/oauth-store.ts). Pruning active tokens based only on
age would change client compatibility. Keep gateway credentials separate from
inference-only authority even if their storage is later consolidated.

History idle maintenance renews process-run leases and prunes usage/routing detail and history-batch receipts even without a nonempty flush. General mutation receipts and active credentials remain available for reconciliation and authorization.

## LLM Debug correction and upgrade

The [capture store](../src/lib/llm-debug-log.ts) and
[capture budget](../src/lib/debug-capture.ts) now use process memory. Migration
003 drops the old table and its generation metadata when the upgraded server
initializes the local SQLite database. Database downloads and CLI archives exclude debug
captures; [restore](../src/lib/storage/restore.ts) accepts schema-2 backups while
skipping their retired debug records and generation metadata.

This does not erase existing backup files or operator retention copies.
A checked-out code change does not establish that a
deployment has run the migration. Console and Sentry payload logging retain
their requested behavior; the correction covers the LLM Debug page and its
database storage. Current setup, native download, and recovery procedures are
in the [SQLite runbook](sqlite-storage.md).
