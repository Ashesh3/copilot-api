# Phase 4 Task 3 Report: Per-Turn Attribution and Safe WebSocket Metadata

## Outcome

Implemented per-turn Responses WebSocket attribution and safe successful-response metadata in `9023138` (`feat: preserve WebSocket turn metadata`). Each accepted turn now runs inside fresh request ID, routing affinity, typed Copilot attribution, safe response metadata, routed-account, and routing-telemetry scopes.

Frame attribution is resolved independently for every turn. Agent task ID, parent agent ID, interaction type, client machine ID, and client experiment context may vary while the connection's interaction/session identity and deterministic account affinity remain stable. Frame-envelope authentication, Copilot session-token, and GitHub-user spoofing do not reach upstream.

Outgoing eligible JSON events receive only successful-attempt metadata from the per-turn safe store. Safe non-quota headers use the `headers` field; quota snapshots use `copilot_quota_snapshots`. Retry and usage-ratelimit fields remain HTTP metadata only. Invalid JSON and noneligible delta events remain byte-for-byte unchanged. Chat and Messages fallback `[DONE]` sentinels are consumed locally.

## Files

- Updated `src/routes/responses/websocket-lifecycle.ts` with the explicit per-turn attribution and response-metadata scope order.
- Updated `src/routes/responses/websocket-protocol.ts` with eligible event metadata reconstruction.
- Updated `src/routes/responses/websocket.ts` so native Responses, synthetic warmup, Messages fallback, Chat fallback, and Chat web-search fallback use the per-turn metadata store and never forward fallback `[DONE]`.
- Updated `src/services/copilot/responses-terminal-sanitizer.ts` in review fix round 1 to preserve safe top-level `copilot_usage` on native terminal events.
- Updated `tests/responses-websocket.test.ts` with per-turn attribution, spoof resistance, lifecycle isolation, metadata category, concurrent isolation, fallback terminator, reserved-field, and native terminal usage coverage.

## Original RED Evidence

The original Task 3 tests were written before production changes.

- `bun test tests/responses-websocket.test.ts -t "per-turn|metadata|quota|spoof|lifecycle contexts|noneligible|Chat Completions fallback"`
  - Initial module load failed because `addResponsesWebSocketMetadata` did not exist.
  - After adding only the helper shell, lifecycle tests failed because the lifecycle API did not accept attribution.
  - Native and concurrent output tests received no metadata envelope.
  - The failures isolated the missing transformer, missing lifecycle ownership, and missing send-path integration.

## Original GREEN and Verification Evidence

- Focused Task 3 matrix: 8 pass, 0 fail.
- Affected WebSocket/request-context suites:
  - `bun test tests/responses-websocket.test.ts tests/request-id.test.ts tests/copilot-request-context.test.ts`
  - 129 pass, 0 fail, 563 assertions.
- Full repository suite:
  - 2,345 pass, 3 expected media skips, 0 fail, 9,023 assertions across 120 files.
- `bun run typecheck`: exit 0.
- `bun run build`: exit 0.
- `bun run lint:all`: 0 errors and the same 5 existing warnings outside Task 3.
- `git diff --check`: exit 0.
- Original commit: `9023138c10d922301f20422bf2769b590064669c`.

## Fix Round 1: Reserved Metadata Reconstruction and Terminal Usage

### Review findings

1. Eligible events spread the source record before conditionally adding trusted `headers` and `copilot_quota_snapshots`. A hostile source field survived whenever that trusted category was absent.
2. The native terminal sanitizer rebuilt completed, incomplete, and failed events without retaining a valid top-level `copilot_usage`.

### RED evidence

A mutation check removed both review fixes and ran:

`bun test tests/responses-websocket.test.ts -t "reconstructs|replaces reserved|copilot_usage through"`

Result: 2 pass, 9 fail.

- End-to-end neither/non-quota/quota cases exposed frame-supplied Authorization, Cookie, private header, or private quota data whenever the matching trusted category was absent.
- Helper-level neither/non-quota/quota cases reproduced the same reserved-field survival.
- Native `response.completed`, `response.incomplete`, and `response.failed` terminal events all produced `copilot_usage: undefined` after sanitizer, ID synchronization, and WebSocket metadata processing.

### Fix

- For every eligible event, detect reserved fields, clone the parsed record, delete source `headers` and `copilot_quota_snapshots`, then add only categories reconstructed from the per-turn safe store.
- If neither trusted category exists but the source supplied a reserved field, serialize the cleaned record with both fields absent.
- Preserve the original frame only for invalid JSON, noneligible event types, or eligible events with no source reserved fields and no trusted metadata.
- Allow only record-shaped top-level `copilot_usage` through the terminal sanitizer. All other arbitrary top-level fields remain excluded.

### GREEN and affected-suite evidence

- Exact review matrix after restoration:
  - 11 pass, 0 fail, 103 assertions.
- Affected protocol, WebSocket, terminal sanitizer, request metadata, and attribution suites:
  - 264 pass, 0 fail, 901 assertions.
- Exact final candidate full repository suite:
  - 2,354 pass, 3 expected media skips, 0 fail, 9,112 assertions across 120 files.
- Whole-repository lint: 0 errors and the same 5 existing warnings outside Task 3.
- `bun run typecheck`: exit 0.
- `bun run build`: exit 0.
- Changed-file lint passed after consolidating the test fixture options into one parameter object and explicitly typing the metadata matrices.
- `git diff --check`: exit 0.

## Self-Review

- Confirmed two turns on one socket independently forward task, parent, interaction, machine, and experiment attribution.
- Confirmed `X-Interaction-Id`, `X-Client-Session-Id`, and selected account continuity remain stable.
- Confirmed frame Authorization, Copilot session token, and GitHub user cannot override trusted upstream values.
- Confirmed request ID, affinity, attribution, response metadata, routed account, and telemetry scopes are fresh and isolated for concurrent turns.
- Confirmed only `response.created`, `response.completed`, `response.incomplete`, and `response.failed` receive metadata.
- Confirmed invalid JSON and noneligible delta frames are unchanged.
- Confirmed neither/non-quota/quota/both cases remove all source reserved fields and emit only the trusted categories that exist.
- Confirmed retry-after and usage-ratelimit metadata never enter WebSocket JSON bodies.
- Confirmed native completed/incomplete/failed events preserve record-shaped `copilot_usage` through terminal sanitization, ID synchronization, and metadata attachment.
- Confirmed arbitrary other top-level terminal fields remain absent.
- Confirmed fallback output is JSON only and `[DONE]` remains internal.

## Limitations

- No authenticated live WebSocket probe was requested for Task 3; later Phase 4 verification tasks own live contract coverage.
- The report lives under the ignored SDD evidence directory and must be force-added intentionally.
