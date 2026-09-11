# Storage and Admission Performance Plan

> **For agentic workers:** Execute independent tasks with superpowers:subagent-driven-development and review the integrated diff.

**Goal:** Reduce avoidable work and latency before inference while preserving storage durability and authentication semantics.

**Architecture:** Keep the current SQLite repositories and request snapshots. Make lock acquisition asynchronous, remove duplicate per-admission reads, return SQL usage totals, selectively prune receipts, and cache immutable compiled replacement rules.

**Tech Stack:** Bun 1.4.0, built-in SQLite, TypeScript, Hono, existing RE2JS and Bun tests.

**Spec:** `docs/superpowers/specs/2026-09-11-performance-storage-admission-design.md`

## Constraints

- Base is merged master `52f2d17`; work only in `copilot-api-performance`.
- No new package or external database. Use the approved internal registry for existing package setup.
- Preserve WAL/FULL durability, transaction callback exactly-once execution and unknown-commit rules.
- Preserve fresh new-turn OAuth revocation, scopes, invalid credentials and account disable/remove semantics.
- Preserve old archive restoration, pending telemetry reconciliation and replacement output. The user explicitly selected only 24-hour/lifetime usage, so replace previous window fields and update the dashboard.
- Do not change transport pooling, retry behavior or diagnostics in this implementation.
- No push, merge, release or production mutation is implied by this task.

## Task 1: Asynchronous SQLite acquisition

Own `src/lib/storage/local-sqlite.ts` and related new/local SQLite tests. Add a small storage helper only if it clarifies ownership.

- [x] Write and run real external-lock regressions: 100ms deadline does not block timers, an ordinary read can proceed while writer retries, release admits exactly one callback, failed acquisition leaves no transaction or poisoned queue.
- [x] Replace native busy waiting with asynchronous acquisition under the existing absolute deadline. Release the queue between failed BEGIN attempts; serialize the entire callback after successful BEGIN. Preserve rollback and statement safeguards.
- [x] Cover readSnapshot busy behavior and orderly close, then run local-sqlite, storage-contract, operations, migration, backup and export tests.
- [x] Re-run the audit contention probe and report timer/max-gap/queue measurements.

## Task 2: One authentication and revision check per admission

Own credential resolution, API guards, admission/snapshot/account refresh code and new admission query-count regressions. Coordinate any `types.ts` change with other tasks.

- [x] Add a real HTTP and WebSocket fixture counting domain SQL. Assert lower read counts and valid completion without weakening auth.
- [x] Deduplicate HTTP credential resolution and IP trust within one admission; avoid duplicate gateway classification. Preserve independently invoked middleware behavior.
- [x] Reuse a fresh observed config revision for accounts instead of issuing three reads. Preserve concurrent fresh-admission and backwards-revision guards.
- [x] Prove OAuth revocation with unchanged config revision, same-request reused WebSocket turns, managed disable, gateway removal, distinct requests/scopes, account changes and injected custom guards.
- [x] Run auth/admission/account suites and audit comparison.

## Task 3: SQL usage totals and receipt maintenance

Own history-repository, usage-tracker, telemetry-writer, new index migration/schema updates and their tests. Existing migration constants must remain immutable.

- [x] Add equivalent totals and pending/uncertain-batch regressions plus upgrade/index-preservation tests.
- [x] Add an aggregate usage repository API and switch `getUsageResponse` to it; retain detail reads where needed.
- [x] Delete usage/model and routing detail older than 24 hours, preserve lifetime scalars, and remove seven-day/five-hour totals. Do not introduce a rollup table. Reflect new windows in Usage UI and regenerated bundle.
- [x] Add migration `006` for selective history receipt lookup. Retain schema5 compatibility in restore/migration validation and update existing current-version assertions.
- [x] Prune on a bounded successful maintenance cadence, not each batch, and yield between full drain chunks so ordinary timers can advance. Preserve explicit prune and one-day receipt horizon.
- [x] Run usage/history/migration/restore suites and scaling probes.

## Task 4: Compiled replacement cache

Own auto-replace and new compiled-rule regressions.

- [x] Add compile-count regression while asserting real output across many text parts; cover changes, equal-revision runtimes and old admitted snapshots.
- [x] Cache validated immutable compiled patterns by immutable settings value identity, returning defensive copies through public listing APIs. Reuse one rule list per payload and fresh matcher per text.
- [x] Run replacement security, cross-protocol normalization and settings tests; compare compile counts and local timings.

## Task 5: Integration verification

- [x] Review all changes for consistency, correct file ownership and regressions.
- [x] Run appropriate focused suites, full fresh-process unit suite, backend typecheck/lint/build, and Linux tests for lock/migration behavior.
- [x] Compare fresh probes to baseline, noting synthetic timing limitations.
- [x] Record completed tasks, results, outstanding limitations and uncommitted branch state.

## User retention clarification

User selected "Keep only 24-hour and lifetime totals; remove seven-day totals" after the initial plan. This is authoritative over earlier shape-preservation requirements. LLM Debug remains process-local and excluded from SQLite/export. Expired transient records should not accumulate; active configurations/identities remain supported.

## Final verification

- Full fresh-process unit sweep plus isolated reruns after corrected expectations:
  4,197 passed. The 23 opt-in Nginx cases then passed separately, giving
  **4,220 passed, zero failed, zero skipped across 271 files**.
- Backend and UI typechecks and builds passed. Full lint: zero errors and five
  existing warnings in unrelated response/replacement code.
- Linux read-only/network-disabled Docker integration: 56 passed, 217 assertions.
  A separate packaged CLI/server smoke confirmed schema 6, readiness, real
  administrator setup, authorization, correct 24-hour/lifetime usage, collection
  compaction, absence of Debug/Activity tables, and SQLite integrity.
- Independent code and retention reviews have no remaining actionable findings.
  The legacy false-gap compaction regression was reproduced before its fix and
  passed afterward. UI desktop/mobile checks passed; the bundle is regenerated.
- Synthetic comparisons: a 100 ms contention deadline completes in 101 ms rather
  than 5.6 seconds; a queued reader proceeds in 0.6 ms rather than timing out.
  Gateway HTTP admission uses 5 domain SELECTs rather than 15. Warm replacement
  processing compiles zero patterns rather than 2,100 for the audit payload.
  Usage SQL aggregation measured 1.72 ms rather than 28.06 ms for equivalent
  detail materialization. These are local fixture measurements, not production
  latency guarantees; the receipt timing probe predates expanded housekeeping.
- Retention is periodic and minute-aligned, not a hard byte-size cap. Active
  credentials/configuration, durable reconciliation receipts, and unclean run
  identities remain. SQLite reuses deleted pages without necessarily shrinking
  the file. Compatibility preserves future-dated imported timestamps.
- Work remains uncommitted on `codex/performance-storage-admission` in the
  `copilot-api-performance` worktree. No new push, merge, release, or deployment.
  The original master checkout remains clean at `52f2d17`.

Reproducible local evidence is under
`.superpowers/sdd/2026-09-11-performance-storage-admission/verification/`;
`final-validated-results.json` references the original sweep, corrective reruns,
and Nginx results rather than concealing the earlier failed expectations.

## Integration authorization

After the implementation verification above, the user authorized a version
bump, pull request, and merge into the primary branch. The primary branch is
`master`, with required linear history. Bump the root package to `6.0.0` for the
breaking usage API/retention contract and the already-merged, unreleased
SQLite-only backend transition. The private UI package version is independent,
and the Bun lockfile contains no root application version to synchronize.

Rebuild and revalidate the versioned tree, create the PR, wait for CI and
security checks, rebase-merge it, and verify the merged remote and local primary
branch. Do not dispatch the separate manual package or Docker release workflows.
