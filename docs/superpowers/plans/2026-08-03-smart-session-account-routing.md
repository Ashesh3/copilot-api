# Smart Session Account Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route independent Claude, Copilot, and Codex conversations evenly across eligible Copilot accounts while preserving account affinity across turns, model changes, WebSocket traffic, and successful failovers.

**Architecture:** Resolve a bounded, typed routing-affinity key at HTTP/WebSocket ingress and from protocol-specific body metadata. Rank eligible accounts with rendezvous hashing, use a bounded in-memory lease after successful failover, and expose only aggregate affinity-source categories through existing routing telemetry.

**Tech Stack:** Bun, TypeScript, Hono, Node `AsyncLocalStorage` and `crypto`, React, Bun test runner.

---

## File Structure

- Create `src/lib/routing-affinity.ts`: normalize identifiers, resolve headers/body metadata, define safe source categories, and manage request-scoped affinity state.
- Modify `src/lib/request-session.ts`: re-export compatibility session access through routing affinity while retaining unrelated request contexts.
- Modify `src/server.ts`: resolve HTTP affinity headers at ingress.
- Modify `src/routes/messages/handler.ts` and `src/routes/messages/count-tokens-handler.ts`: install Claude body fallback after parsing.
- Modify `src/routes/responses/handler.ts`, `src/routes/responses/compact-handler.ts`, and `src/routes/responses/websocket.ts`: install Responses/Codex body fallback for HTTP and logical WS turns.
- Modify `src/routes/responses/websocket-lifecycle.ts`: run WS turns inside typed affinity context.
- Modify `src/lib/token-pool.ts`: rendezvous rank eligible accounts and retain conservative unidentified behavior.
- Create `src/lib/routing-affinity-leases.ts`: bounded 24-hour successful-failover overrides.
- Modify `src/lib/account-router.ts`: select via typed affinity and update lease only after successful failover.
- Modify `src/lib/routing-telemetry.ts`: aggregate redacted affinity-source selection counts.
- Modify `ui/src/lib/types.ts` and `ui/src/screens/Usage.tsx`: render redacted affinity-source summary.
- Modify generated `src/routes/dashboard/page-generated.ts` after the UI build.
- Create/modify focused tests under `tests/` for each behavior before production changes.

### Task 1: Resolve safe protocol affinity identities

**Files:**
- Create: `src/lib/routing-affinity.ts`
- Modify: `src/lib/request-session.ts`
- Modify: `src/server.ts`
- Test: `tests/routing-affinity.test.ts`
- Test: `tests/request-id.test.ts`

- [ ] **Step 1: Write failing unit tests for normalization and precedence**

Add tests proving `resolveRoutingAffinityFromHeaders()` selects, in order,
`x-claude-code-session-id`, `x-client-session-id`, `session-id`, and
`thread-id`; trims values; rejects empty and values longer than 512 code units;
and reports the exact safe source enum. Add body tests for Claude
`metadata.user_id` JSON and Responses `client_metadata` object/JSON-string
fallbacks, including malformed metadata.

- [ ] **Step 2: Run the unit test and verify RED**

Run: `bun test tests/routing-affinity.test.ts`
Expected: FAIL because `~/lib/routing-affinity` does not exist.

- [ ] **Step 3: Implement the affinity module**

Define `RoutingAffinitySource`, `RoutingAffinity`, a mutable request store,
normalization, header/body resolvers, `runWithRoutingAffinity()`,
`getRoutingAffinity()`, and `installRoutingAffinityFallback()`. The fallback
must never overwrite an existing higher-priority value. Preserve
`getClientSessionId()` as a compatibility accessor.

- [ ] **Step 4: Run the unit test and verify GREEN**

Run: `bun test tests/routing-affinity.test.ts`
Expected: PASS.

- [ ] **Step 5: Write and verify an HTTP ingress regression test RED**

Extend `tests/request-id.test.ts` so a request with `X-Client-Session-Id` reaches
the mocked routed provider with `getRoutingAffinity()` equal to
`{ source: "copilot_session", key: "..." }`. Run the single file and confirm it
fails while middleware still captures only Claude's header.

- [ ] **Step 6: Wire HTTP ingress and verify GREEN**

Replace the header-specific server middleware with
`runWithRoutingAffinity(resolveRoutingAffinityFromHeaders(...), ...)`, retaining
all request ID, quota, account, and routing telemetry scopes. Run:
`bun test tests/request-id.test.ts tests/routing-affinity.test.ts`.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/routing-affinity.ts src/lib/request-session.ts src/server.ts tests/routing-affinity.test.ts tests/request-id.test.ts
git commit -m "feat: resolve client routing affinity"
```

### Task 2: Use rendezvous hashing for identified sessions

**Files:**
- Modify: `src/lib/token-pool.ts`
- Test: `tests/token-pool.test.ts`

- [ ] **Step 1: Write failing selection tests**

Build test accounts directly in `TokenPool`. Prove that one affinity key is
stable, distinct generated keys are reasonably balanced across three accounts,
the same key preserves its preferred account across two models when eligible,
removing one account remaps only sessions assigned to it, adding one account
keeps most prior assignments, and `undefined` still selects the first eligible
account.

- [ ] **Step 2: Run and verify RED**

Run: `bun test tests/token-pool.test.ts`
Expected: the distribution/minimal-remapping expectations fail under modulo
hashing and first-account fallback remains green.

- [ ] **Step 3: Implement rendezvous ranking**

Use SHA-256 of `affinityKey + "\0" + account.id`, compare digest bytes without
integer truncation, and select the highest score among the model's current
eligible accounts. Do not include model ID in the hash. Keep the existing
first-account behavior when affinity is absent.

- [ ] **Step 4: Run and verify GREEN**

Run: `bun test tests/token-pool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/token-pool.ts tests/token-pool.test.ts
git commit -m "fix: balance identified sessions across accounts"
```

### Task 3: Preserve successful account failovers

**Files:**
- Create: `src/lib/routing-affinity-leases.ts`
- Modify: `src/lib/account-router.ts`
- Test: `tests/routing-affinity-leases.test.ts`
- Test: `tests/account-router.test.ts`
- Test: `tests/account-router-telemetry.test.ts`

- [ ] **Step 1: Write failing bounded-lease tests**

Test lease set/get, 24-hour expiry, 10,000-entry cap with oldest eviction,
replacement refresh, reset helper, and that keys never appear in exported
snapshots (the module should expose no snapshot API).

- [ ] **Step 2: Run and verify RED**

Run: `bun test tests/routing-affinity-leases.test.ts`
Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement the bounded store and verify GREEN**

Implement synchronous, non-throwing `get`, `set`, and test reset functions.
Expired or invalid values return `undefined`; capacity eviction removes the
oldest insertion. Run the lease test.

- [ ] **Step 4: Write failing router integration tests**

Prove a successful 401/403/429 failover becomes the next request's initial
account for the same affinity; an unsuccessful failover does not set a lease;
an ineligible leased account is ignored; unidentified calls never lease; and
selection telemetry still records one sticky initial selection rather than a
second selection for failover.

- [ ] **Step 5: Run and verify RED**

Run: `bun test tests/account-router.test.ts tests/account-router-telemetry.test.ts`
Expected: follow-up calls return to the hash winner because the router does not
consult leases.

- [ ] **Step 6: Integrate leases and verify GREEN**

Select an eligible leased account before rendezvous. Record a replacement only
after its failover response is successful (`2xx`). Keep existing retry budgets,
unhealthy marking, model eligibility, selection accounting, and last-used
account behavior unchanged. Run all three focused test files.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/routing-affinity-leases.ts src/lib/account-router.ts tests/routing-affinity-leases.test.ts tests/account-router.test.ts tests/account-router-telemetry.test.ts
git commit -m "fix: retain successful session failovers"
```

### Task 4: Install body fallbacks and WebSocket affinity

**Files:**
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/messages/count-tokens-handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/responses/compact-handler.ts`
- Modify: `src/routes/responses/websocket.ts`
- Modify: `src/routes/responses/websocket-lifecycle.ts`
- Test: `tests/create-chat-completions.test.ts`
- Test: `tests/create-responses.test.ts`
- Test: `tests/responses-websocket.test.ts`

- [ ] **Step 1: Write failing HTTP body-fallback tests**

Add real handler-path tests showing Claude metadata supplies
`claude_metadata`, Responses `client_metadata.session_id` supplies
`codex_metadata`, and an existing header affinity wins. Assert selected account
stability through captured authorization headers.

- [ ] **Step 2: Run and verify RED**

Run: `bun test tests/create-chat-completions.test.ts tests/create-responses.test.ts`
Expected: metadata-only follow-ups use default selection instead of sticky
selection.

- [ ] **Step 3: Install HTTP body fallbacks and verify GREEN**

Immediately after parsing each payload, call the appropriate resolver and
install only a fallback. Apply it to Messages count-tokens and Responses
compact as well, even where no provider account selection normally occurs, so
future dispatch remains consistent. Run the two focused tests plus existing
Messages/compact tests covering changed handlers.

- [ ] **Step 4: Write failing WebSocket tests**

Prove upgrades recognize `X-Client-Session-Id`, `session-id`, and `thread-id`;
per-frame `client_metadata.session_id` works when handshake headers are absent;
and a handshake header beats conflicting frame metadata.

- [ ] **Step 5: Run and verify RED**

Run: `bun test tests/responses-websocket.test.ts`
Expected: Copilot/header and per-frame affinity expectations fail.

- [ ] **Step 6: Implement WebSocket affinity and verify GREEN**

Store typed handshake affinity in `ResponsesWebSocketData`. Resolve a frame
fallback from the extracted payload and run the logical turn with the effective
affinity. Do not use request/connection IDs as fallback affinity. Run the WS
test.

- [ ] **Step 7: Commit**

```powershell
git add src/routes/messages/handler.ts src/routes/messages/count-tokens-handler.ts src/routes/responses/handler.ts src/routes/responses/compact-handler.ts src/routes/responses/websocket.ts src/routes/responses/websocket-lifecycle.ts tests/create-chat-completions.test.ts tests/create-responses.test.ts tests/responses-websocket.test.ts
git commit -m "feat: route protocol metadata by session"
```

### Task 5: Expose redacted affinity-source observability

**Files:**
- Modify: `src/lib/routing-telemetry.ts`
- Modify: `tests/routing-telemetry.test.ts`
- Modify: `tests/account-router-telemetry.test.ts`
- Modify: `tests/dashboard-usage-routing.test.ts`
- Modify: `ui/src/lib/types.ts`
- Modify: `ui/src/screens/Usage.tsx`
- Modify: `src/routes/dashboard/page-generated.ts`

- [ ] **Step 1: Write failing telemetry aggregation tests**

Extend selection events with an optional safe `affinitySource`. Assert snapshot
counts for every source plus `unidentified`, and recursively assert raw test
session IDs never appear in serialized snapshots.

- [ ] **Step 2: Run and verify RED**

Run: `bun test tests/routing-telemetry.test.ts tests/account-router-telemetry.test.ts tests/dashboard-usage-routing.test.ts`
Expected: types/expectations fail because snapshots have no affinity summary.

- [ ] **Step 3: Implement telemetry aggregation and verify GREEN**

Add bounded enum counters to minute buckets and `RoutingTelemetrySnapshot`.
Record identified sources from `getRoutingAffinity()` and `unidentified` for
default mode. Single-token selections are not counted as affinity. Run the
three tests.

- [ ] **Step 4: Add UI types and rendering**

Add the affinity summary type. In Account balance, replace the opaque sentence
with a compact, wrapping list of source labels/counts plus a clear
`Unidentified` count. Keep sticky/default/single totals accessible in the
supporting text. Do not display IDs.

- [ ] **Step 5: Build UI and regenerate embedded page**

Run: `npm run typecheck --prefix ui && npm run build --prefix ui`
Expected: PASS and update `src/routes/dashboard/page-generated.ts` through the
existing build pipeline.

- [ ] **Step 6: Run dashboard tests and commit**

Run: `bun test tests/dashboard-usage-routing.test.ts tests/routing-telemetry.test.ts tests/account-router-telemetry.test.ts`
Expected: PASS.

```powershell
git add src/lib/routing-telemetry.ts tests/routing-telemetry.test.ts tests/account-router-telemetry.test.ts tests/dashboard-usage-routing.test.ts ui/src/lib/types.ts ui/src/screens/Usage.tsx src/routes/dashboard/page-generated.ts
git commit -m "feat: report routing affinity sources"
```

### Task 6: Full verification and review

**Files:**
- Review all files changed since `origin/master`

- [ ] **Step 1: Run focused routing tests**

```powershell
bun test tests/routing-affinity.test.ts tests/routing-affinity-leases.test.ts tests/token-pool.test.ts tests/account-router.test.ts tests/account-router-telemetry.test.ts tests/create-chat-completions.test.ts tests/create-responses.test.ts tests/responses-websocket.test.ts tests/request-id.test.ts tests/routing-telemetry.test.ts tests/dashboard-usage-routing.test.ts
```

Expected: 0 failures.

- [ ] **Step 2: Run full tests and static verification**

```powershell
bun test
bun run typecheck
npm run typecheck --prefix ui
bun run build
npm run build --prefix ui
```

Expected: all commands exit 0.

- [ ] **Step 3: Run changed-file lint and diff checks**

Run ESLint on changed `.ts`/`.tsx` files, then `git diff --check origin/master...HEAD`. Expected: no errors or whitespace failures.

- [ ] **Step 4: Request independent code review**

Review `origin/master..HEAD` against the approved design, with special attention
to affinity precedence, failover success semantics, cardinality/memory bounds,
secret leakage, WebSocket context isolation, and rendezvous behavior. Resolve
all Critical and Important findings and re-run affected tests.

- [ ] **Step 5: Re-run fresh full verification after review fixes**

Repeat Step 2. Completion claims require this post-review output.

- [ ] **Step 6: Push and open a pull request**

Push `codex/smart-session-routing` and open a PR against `master` summarizing the
root cause, protocol-aware affinity, rendezvous selection, failover leases,
redacted observability, and verification evidence.
