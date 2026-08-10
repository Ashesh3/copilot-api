# Hash-Only Session Affinity and Account Reinitialization Design

**Date:** 2026-08-10
**Status:** Approved with no-storage revision

## Problem

An identified Responses WebSocket conversation completed 319 recorded turns on
Account #0. It then produced eight consecutive rejections on Account #1. The
conversation did not choose Account #1: unrelated inference requests received
401 responses, and the router globally marked Account #3 and then Account #0
unhealthy. Account #2 was disabled for the affected models, so changing the
global healthy set forced this established conversation onto Account #1.

The first 401 warning said the server was "refreshing Copilot token." That was
misleading. The refresh successfully exchanged the already-loaded GitHub token
for another short-lived Copilot bearer, but the same account-bound request
remained rejected. A pod restart appeared to repair authentication because it
did more than a bearer refresh: it reloaded every account, fetched each model
list, rebuilt the routing index, restored health, and cleared process-local
failover leases. Direct post-incident control-plane probes confirmed that all
four GitHub credentials could exchange tokens and fetch models, including the
affected models.

After restart, the conversation returned to its deterministic Account #0 home
but received an explicit encrypted-content verification error. The proxy also
uses a process-random `state.sessionId` as upstream `X-Interaction-Id`,
`X-Client-Session-Id`, and `X-Agent-Task-Id`; restarting changes all three even
when the incoming conversation and routed account stay the same.

These are routing and identity-continuity failures, not evidence that the
configured GitHub tokens expired.

## Goals

- Derive the same account from the same identified conversation on every turn
  and after every process restart.
- Keep independent conversations balanced across the configured eligible
  accounts without storing session-to-account mappings.
- Never let one request's 401 or 403 remove an account from other sessions.
- Never silently fail an identified conversation over to another account.
- Reproduce restart-level account initialization for the selected account when
  its inference request returns 401, without restarting the pod.
- Send a deterministic per-conversation identity upstream so process restarts
  do not change the identity associated with encrypted history.
- Distinguish a successful credential refresh followed by request rejection
  from an actually invalid configured credential.
- Preserve bounded retry behavior and avoid raw affinity IDs in logs,
  telemetry, or persisted data.

## Non-goals

- Persisting any session ID, session hash, account binding, failover lease, or
  upstream session identity.
- Supporting account-token reordering without remapping existing sessions.
- Preserving assignments if the configured account roster or per-model
  eligibility changes.
- Recovering ciphertext already tied to a lost account or old process-random
  upstream identity.
- Changing custom-provider routing.
- Treating client-supplied affinity identifiers as authentication.

## Operating Invariant

Hash-only routing is stable only while all of the following remain stable:

1. `GITHUB_TOKENS` contains the same accounts in the same order.
2. The same accounts remain enabled for each model.
3. Each account continues advertising the same relevant models.
4. The rendezvous hash version and account-ID assignment do not change.

This is an explicit deployment contract. Account IDs are the positional IDs
assigned from the configured token order. Reordering tokens, adding/removing an
account, or changing model eligibility intentionally changes part of the hash
ring and can remap sessions. The operator has accepted this constraint in
exchange for having no mapping storage.

## Hash-Only Account Selection

Continue using model-independent rendezvous hashing:

```text
score = SHA-256(affinityKey + NUL + accountId)
selected = eligible account with the lexicographically greatest digest
```

Eligibility is evaluated from the initialized account model lists plus
operator model-routing overrides. Inference responses must not mutate that
set. In particular, a 401 or 403 from `/responses`, `/chat/completions`, or
`/v1/messages` must not call `markUnhealthy()` or rebuild the model index.

The existing process-local affinity lease is removed. Identified routing must
not consult or create a session-to-account map before or after failover. Every
turn recomputes the same answer from the affinity key and stable eligible set.

The model remains absent from the hash input. A conversation therefore keeps
one global account preference order across model changes and stays on the same
account whenever that account is eligible for both models.

Unidentified traffic retains the existing conservative first-eligible
selection. Its behavior is not used to provide conversation-continuity
guarantees.

## Deterministic Upstream Session Identity

For an identified request, derive an opaque UUID-shaped upstream identity from
the normalized affinity key:

```text
digest = SHA-256("copilot-api/upstream-session/v1" + NUL + affinityKey)
uuid = RFC-4122-compatible formatting of the first 16 digest bytes
```

Set the UUID version and variant bits before formatting so the value retains
the shape currently sent by the proxy. Use the derived value for:

- `X-Interaction-Id`
- `X-Client-Session-Id`
- `X-Agent-Task-Id`

The derivation is domain-separated, model-independent, account-independent,
and contains no secret. It creates no storage and reveals neither the raw
affinity key nor an account credential. The same incoming conversation gets
the same upstream identity across HTTP, WebSocket turns, token refreshes, and
pod restarts.

For truly unidentified requests, retain the existing process-level
`state.sessionId` fallback. Account model-discovery requests also retain the
process identity because they are control-plane operations rather than client
conversations.

Deployment creates an unavoidable one-time identity boundary: encrypted
content produced under the old process-random identity may not survive the
first restart onto the deterministic scheme. With no persisted old identity,
that ciphertext cannot be rebound. All content produced after deployment uses
the restart-stable identity.

## 401 Reinitialization

An initial 401 on a selected multi-token account follows this sequence:

1. Log that Account #N returned an upstream 401 and is being reinitialized;
   do not claim that its token expired.
2. Coalesce concurrent reinitializations for the same account into one
   in-flight promise.
3. Exchange that account's already-configured GitHub token for a new Copilot
   bearer.
4. Fetch the account's current `/models` response using the new bearer.
5. Atomically replace its bearer, expiry, model data, and refresh timer only
   after the control-plane sequence succeeds.
6. Rebuild the model index without changing account order or operator
   overrides.
7. Resend the original inference request once to the same account, with the
   same deterministic upstream session identity.

The control-plane token exchange and model fetch are not inference sends. The
single same-account resend consumes one extra-send allowance from the existing
shared retry budget.

If reinitialization fails, preserve the last known account metadata, do not
route the request elsewhere, and return a local `503` error with code
`account_reinitialization_failed`. Operator diagnostics record the account ID,
control-plane stage, and HTTP status or error class, but never credentials or
arbitrary response bodies.

If reinitialization succeeds but the same request is still rejected with 401,
the configured credential has just passed the control-plane checks. Classify
the result as a session/account request rejection rather than an expired token.
Return a local `409` error with code `session_account_rejected`, identify only
the numeric account ID, and tell the client that affinity was preserved and no
cross-account retry was attempted.

## 403 and 429 Behavior

- An identified-session 403 is request/account-specific. Do not mark the
  account unhealthy and do not fail over; return a local
  `session_account_rejected` 409.
- An identified-session 429 may use the existing bounded same-account HTTP
  retry. If it remains rate-limited, return the upstream 429; never move the
  conversation to another account.
- Identified 401, 403, and 429 responses never create leases.
- Existing unidentified-request behavior may retain bounded failover because
  no supported affinity key exists to preserve. It must not create a session
  mapping.

## Account Health Semantics

`healthy` means the account passed control-plane initialization. An inference
response cannot prove global credential health because the request may contain
account-bound encrypted history, model-specific policy, or request-specific
authorization state.

Therefore:

- Startup initialization may mark an account unavailable if token exchange or
  model discovery fails.
- A scheduled control-plane refresh may restore an unavailable account after
  successful validation.
- Inference 401/403 responses never toggle global health.
- A successful reinitialization confirms control-plane health even when the
  original inference payload remains rejected.

This prevents unrelated conversations from changing another session's hash
candidate set.

## Error and Protocol Handling

Local routing errors use `LocalHTTPError` so ordinary HTTP and Responses
WebSocket paths receive a structured body rather than the generic "Failed to
create responses" message. The body shape is:

```json
{
  "error": {
    "type": "session_affinity_error",
    "code": "session_account_rejected",
    "message": "The bound account rejected this conversation after successful account reinitialization; affinity was preserved and no cross-account retry was attempted.",
    "account_id": 1
  }
}
```

The reinitialization-failure variant uses type `account_unavailable`, code
`account_reinitialization_failed`, status 503, and the same numeric account ID.
WebSocket error frames retain the existing status-to-code translation while
using the structured local error message. No client receives a misleading
gateway-authentication 401 for either case.

## Concurrency and Atomicity

- Account reinitialization is single-flight per account.
- Requests for other accounts do not wait on that promise.
- A failed reinitialization cannot partially replace the old bearer, models,
  expiry, or timer.
- A successful reinitialization swaps the account state as one logical commit
  before rebuilding the index.
- Disposing the token pool clears refresh timers and in-flight bookkeeping.
- Request routing never waits on filesystem I/O because no affinity state is
  persisted.

## Telemetry and Privacy

Add bounded counters/log attributes for:

- selected account and redacted affinity source;
- same-account reinitialization attempt, success, and failure;
- post-reinitialization session/account rejection;
- identified-session failover suppression.

Outside the administrator-only ten-minute LLM Debug store, do not emit affinity
keys, their hashes, derived upstream UUIDs, GitHub tokens, Copilot tokens, or
arbitrary upstream error bodies. LLM Debug is the intentional raw-data
exception and preserves the derived upstream headers exactly. Existing
account/model usage telemetry remains compatible.

## File Boundaries

- `src/lib/account-router.ts`: identified-session no-failover policy,
  same-account reinitialization, local error classification, and routing
  telemetry.
- `src/lib/token-pool.ts`: atomic single-flight account reinitialization while
  retaining the stable configured account IDs and model index.
- `src/services/copilot/copilot-client.ts`: choose deterministic request-scoped
  upstream session headers, with the process fallback for unidentified calls.
- `src/lib/upstream-session-affinity.ts`: pure domain-separated hash-to-UUID
  derivation with no mutable state.
- `src/lib/routing-affinity-leases.ts`: remove the process-local mapping and its
  callers because hash-only routing must not consult leases.
- `src/lib/error.ts` and Responses WebSocket error normalization: preserve
  structured local affinity errors across HTTP and WebSocket protocols.
- `tests/`: focused account-router, token-pool, header, HTTP, WebSocket, and
  privacy regressions.

## Testing

Tests must prove:

1. A session hashes to the same account across turns and simulated process
   restarts when token order and eligibility are unchanged.
2. Distinct sessions still distribute reasonably across eligible accounts.
3. Account order or eligibility changes are the documented events that may
   alter a hash-only assignment.
4. A 401 in one session cannot remove its account from another session's
   candidate set.
5. A 401 performs one atomic full reinitialization and one resend on the same
   account.
6. Concurrent 401s for one account share a single reinitialization.
7. Failed reinitialization preserves prior account state and returns the local
   503 error without failover.
8. Post-reinitialization 401 and identified-session 403 return the local 409
   error without marking unhealthy or trying another account.
9. Identified-session 429 never fails over after same-account retry is
   exhausted.
10. No identified request reads or writes an affinity lease or other mapping.
11. HTTP and Responses WebSocket requests derive the same upstream UUID from
    every supported affinity source.
12. Derived upstream identity is stable across restarts, differs across
    sessions, has valid UUID version/variant bits, and never appears in ordinary
    logs or telemetry; the administrator-only LLM Debug record captures it raw.
13. Unidentified and control-plane requests retain the process-level header
    fallback.
14. Existing retry-budget, model-routing override, single-token, custom
    provider, and request-abort behavior remain intact.

## Acceptance Criteria

- The production sequence "unrelated 401 changes global health, established
  session moves accounts" is covered by a failing-then-passing regression.
- The production sequence "restart changes upstream conversation identity" is
  covered by a failing-then-passing regression.
- No session mapping or lease file, database, environment dependency, or
  in-memory session map exists.
- Focused routing/WebSocket tests, the full Bun suite, typecheck, lint, build,
  and `git diff --check` pass before publication.
