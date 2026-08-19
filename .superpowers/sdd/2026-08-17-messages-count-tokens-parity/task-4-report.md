# Task 4 Report: Native-First Messages Routing

## Outcome

- Added pure Messages-to-Responses and Messages-to-Chat fidelity scans.
- Selected upstream endpoints in native Messages, Responses, then Chat order.
- Preserved valid native thinking blocks and signatures on the first dispatch.
- Added one non-streaming deterministic invalid-signature recovery that strips
  historical thinking on a clone and retains the current thinking controls.
- Shared the three-send retry budget across transport retry, reinitialization,
  failover, and signature recovery.
- Pinned recovery to the account used by the failed native dispatch and
  prevented the recovery dispatch from buying further retries.
- Preserved explicit native beta, version, provider, and initiator options on
  every send.
- Kept custom-provider Messages routing and the native web-search compatibility
  loop intact.

## Verification

- Focused Messages/router/transport suite: 200 passed, 0 failed.
- Full suite: 1,827 passed, 3 expected media skips, 0 failed across 117 files.
- `bun run typecheck`: passed.
- Changed-file lint: passed (with the repository's existing stale
  `baseline-browser-mapping` notice only).
- `bun run build`: passed.
- `git diff --check`: passed.

## Review Remediation Round 2

- Blocked Messages-to-Responses document variants whose `context` or
  `citations` metadata has no Responses mapping, while keeping plain PDF title
  and data eligible for the existing exact mapping.
- Blocked every Messages document block from Chat fallback because the Copilot
  Chat transport downgrades file parts to omission text.
- Kept Responses `tool_result.is_error` eligible through its exact
  completed/incomplete item-status mapping and blocked meaningful/present
  `is_error` on Chat, whose tool-message shape cannot preserve it.
- Added direct scan, converter, route, and native-wire coverage proving both
  the translated loss and native preservation behavior.

### Round 2 Verification

- Focused Messages routing and translation suite: 249 passed, 0 failed.
- Targeted live `tool_result.is_error` Responses mapping: 1 passed, 0 failed.
- Full suite: 1870 passed, 3 expected media skips, 0 failed across 117 files.
- `bun run typecheck`: passed.
- Changed-file lint: passed (with the existing stale
  `baseline-browser-mapping` data notice).
- `bun run build`: passed.
- `git diff --check`: passed.

## Review Remediation Round 1

- Replaced permissive translation checks with exhaustive map-or-block scans for
  accepted root fields, structured controls, messages, content blocks, cache
  controls, thinking signatures, tool declarations, and unknown extensions.
- Kept native Messages forward-compatible while making every translated route
  fail closed for unmapped native data.
- Preserved schema-less native/server tools unchanged on `/v1/messages` and
  moved compatibility web-search rewriting onto an immutable request clone.
- Preserved original streaming semantics for native web-search requests;
  invalid-signature recovery stays inside the internal web-search loop and the
  final result is emitted as Anthropic SSE.
- Added an explicit routed-account pin shared across native web-search
  iterations, including after unidentified failover.
- Kept one RetryBudget instance for the whole logical call: signature recovery
  consumes one extra send while the recovery attempt retains remaining
  transport/reinitialization allowance.
- Replaced substring matching with exact parsing of the two known safe native
  invalid-signature error shapes.

### Remediation Verification

- Focused Task 4, translation, native web-search, account-router, and transport
  suites: 236 passed, 0 failed.
- Full suite: 1,857 passed, 3 expected media skips, 0 failed across 117 files.
- `bun run typecheck`: passed.
- Changed-file lint: passed with only the existing stale
  `baseline-browser-mapping` notice.
- `bun run build`: passed.
- `git diff --check`: passed.
