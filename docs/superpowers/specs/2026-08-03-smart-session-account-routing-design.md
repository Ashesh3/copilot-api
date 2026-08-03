# Smart Session Account Routing Design

**Date:** 2026-08-03
**Status:** Approved

## Problem

Multi-token account routing currently recognizes only
`X-Claude-Code-Session-Id`. When that header is absent,
`TokenPool.getAccountForModelBySession()` always returns the first eligible
account. The Usage dashboard exposed the resulting production skew: 882
headerless selections chose Account #0 while the other eligible accounts were
idle.

The dominant affected client is GitHub Copilot CLI/runtime. It sends a stable
`X-Client-Session-Id`, but the server ignores it. Codex CLI/Desktop similarly
sends stable `session-id` and `thread-id` values that HTTP routing ignores.
Per-request round-robin is not a safe replacement because encrypted reasoning
and thinking signatures can be tied to the account that produced them.

## Goals

- Distribute independent conversations evenly across all healthy accounts that
  support the effective model.
- Keep every turn in a conversation on one account whenever it remains
  eligible.
- Keep a Codex root task and its subagents on one account.
- Minimize session movement when accounts become eligible or ineligible.
- Keep a successful account failover sticky for later turns.
- Retain a conservative stable fallback for clients with no conversation ID.
- Never persist affinity IDs or expose their raw values through telemetry.

## Non-goals

- Persisting affinity across process restarts.
- Perfectly equal request counts. A long or busy conversation is intentionally
  sticky, so balance is measured across independent sessions.
- Changing custom-provider routing.
- Treating client-supplied affinity identifiers as authentication.
- Pinning by request, turn, machine, installation, or upstream response IDs.

## Client Evidence and Affinity Precedence

The resolver normalizes non-empty strings and uses the first valid value in
this order:

1. `X-Claude-Code-Session-Id` — Claude Code and Claude Desktop/Cowork's embedded
   Claude Code engine; stable across turns and resume.
2. `X-Client-Session-Id` — GitHub Copilot CLI/runtime; stable for the persisted
   conversation and present on HTTP and Responses WebSocket traffic.
3. `session-id` — Codex CLI/Desktop root session-tree ID; inherited by
   subagents and restored on resume.
4. Body fallback `metadata.user_id.session_id` for Anthropic Messages.
5. Body fallback `client_metadata.session_id` for Responses HTTP/WebSocket.
6. `thread-id`, then `client_metadata.thread_id`, as a Codex compatibility
   fallback when the session-tree ID is unavailable.

Header values take precedence because they are available before request-body
translation. Body fallbacks are installed after the route parses a payload and
before any provider call. The body resolver accepts `client_metadata` as either
an object or a JSON string because compatible clients may use either encoding.
Malformed metadata is ignored rather than failing inference.

Do not use `X-Request-Id`, `X-Client-Request-Id`, `X-Interaction-Id`,
`X-Agent-Task-Id`, turn IDs, machine/installation IDs,
`X-Copilot-WebSocket-Session-Id`, `previous_response_id`, or
`prompt_cache_key` as the primary affinity key. Their lifetimes are too short,
too broad, provider-generated, or overrideable for safe conversation routing.

## Request Context

Replace the string-only client session context with a request-scoped affinity
object:

```ts
type RoutingAffinitySource =
  | "claude_session"
  | "copilot_session"
  | "codex_session"
  | "claude_metadata"
  | "codex_metadata"
  | "codex_thread"

interface RoutingAffinity {
  key: string
  source: RoutingAffinitySource
}
```

The middleware resolves supported headers. Route handlers may install a body
fallback only when no higher-priority affinity already exists. WebSocket
upgrade code resolves headers, while each `response.create` frame may supply a
body fallback before dispatch. Raw keys stay inside `AsyncLocalStorage` and
must not be logged or included in API responses.

Existing `getClientSessionId()` remains as a compatibility accessor returning
the key. New routing code uses `getRoutingAffinity()` so telemetry can record
only the source category.

## Account Selection

### Identified conversations

Use rendezvous (highest-random-weight) hashing over the stable account identity:

```text
score = SHA-256(affinityKey + NUL + accountId)
selected = eligible account with the lexicographically greatest digest
```

The model is intentionally not part of the score. This gives a session one
global account preference order, so model changes stay on the same account when
that account supports both models. Filtering happens before ranking, so only
healthy, enabled accounts advertising the effective model participate.

Cryptographic hashing avoids the visible low-bit bias of simple modulo hashes.
Rendezvous hashing also minimizes remapping when the eligible set changes:
sessions remain on their previous winner unless that winner disappears or a
new account outranks it.

### Unidentified clients

Keep returning the first eligible account. Round-robin per HTTP request could
switch an unknown multi-turn client between credentials and invalidate
encrypted history. Telemetry continues to label these selections `default`,
making unsupported clients visible rather than silently risking correctness.

## Failover Lease

On a 401/403/429 failover, store a bounded, process-local lease from affinity
key to the successful replacement account. A later request consults the lease
before rendezvous hashing and reuses it only when that account is still
healthy and eligible for the requested model.

- TTL: 24 hours since the latest successful failover assignment.
- Capacity: 10,000 entries.
- Eviction: delete expired entries on access; when over capacity, evict the
  oldest insertion.
- No key or account mapping is persisted.
- A failed failover must not overwrite the lease.
- Single-token and unidentified requests do not create leases.

The lease is deliberately keyed by conversation only, not model. This keeps a
conversation on the replacement account across model changes where possible.
If the replacement does not support a later model, normal rendezvous selection
chooses among that model's eligible accounts without deleting the lease; it may
become usable again on a supported model.

## WebSocket Behavior

Responses WebSocket routing captures supported affinity headers during the
upgrade. Codex and Copilot send their stable IDs on that handshake. For clients
that send identity only inside `response.create`, the per-turn body resolver
installs the fallback before provider routing.

The account is selected per logical turn from the same stable affinity key,
not from the connection request ID. Concurrent turns on one socket therefore
remain consistent without sharing mutable request state.

## Telemetry and Dashboard

Extend routing selection telemetry with an optional redacted affinity source.
Aggregate counts by source and expose only categories such as
`copilot_session`, `codex_session`, and `unidentified`; never expose IDs or
hashes. The Usage page adds a compact affinity summary near Account balance so
operators can distinguish:

- healthy distribution across many identified sessions,
- one intentionally hot sticky session, and
- a client population still missing supported identifiers.

Selection mode remains:

- `sticky` for identified affinity, including leases;
- `default` for unidentified multi-token traffic;
- `single` for single-token mode.

## Error Handling and Security

- Trim identifiers and reject empty or excessively large values (maximum 512
  UTF-16 code units) to bound hashing and memory use.
- Metadata parsing is best-effort and never causes an inference failure.
- Affinity IDs do not grant access and are evaluated only after normal request
  authentication for provider dispatch.
- Telemetry and logs contain the source category but never the raw key.
- Routing/telemetry failures must not prevent provider calls.

## Testing

Tests must prove:

- the production skew regression: repeated unidentified requests retain the
  conservative fallback, while distinct Copilot/Codex sessions distribute;
- every supported header/body source and precedence rule;
- malformed, blank, and oversized identifiers are ignored;
- one affinity key selects the same account across turns and model changes;
- rendezvous distribution is reasonably even and minimally remaps when one
  account is added or removed;
- failover leases are recorded only after a successful failover and ignored
  when the leased account is ineligible;
- HTTP and Responses WebSocket paths install the correct affinity context;
- telemetry exposes source counts without raw IDs;
- existing retry budgets, model eligibility, and single-token behavior remain
  unchanged.
