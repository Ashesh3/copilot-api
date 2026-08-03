# Usage Routing Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, process-memory routing telemetry and redesign the Usage page to show client requests, actual upstream calls, retries, failovers, per-model traffic, account balance, and route breakdowns without changing the existing three usage cards.

**Architecture:** A new `routing-telemetry` module aggregates requests, upstream sends, and account selections into rolling minute buckets plus process-lifetime totals. Request-scoped async context correlates final HTTP/WebSocket requests with centrally instrumented Copilot and custom-provider sends; an authenticated snapshot endpoint feeds a separately polling Usage dashboard surface.

**Tech Stack:** Bun, strict TypeScript, Hono, AsyncLocalStorage, Bun test, React 19, Astryx Design System, CSS.

---

## File Structure

- Create `src/lib/routing-telemetry.ts`: bounded aggregation, normalization, recording, request-scoped correlation state, snapshot generation, and test reset hooks.
- Modify `src/lib/request-session.ts`: expose request-scoped routing telemetry storage alongside the existing session/account stores.
- Modify `src/server.ts`: initialize routing telemetry context before the request logger so post-response recording can read it.
- Modify `src/lib/request-logger.ts`: record one completed model request for HTTP requests and logical WebSocket turns.
- Modify `src/routes/responses/websocket-lifecycle.ts`: give each Responses WebSocket turn a persistent telemetry context.
- Modify `src/lib/token-pool.ts`: expose eligible account IDs without changing selection behavior.
- Modify `src/lib/account-router.ts`: attach model/account/send metadata and record eligibility-weighted initial selections.
- Modify `src/services/copilot/copilot-client.ts`: record every actual Copilot network attempt and its reason/outcome.
- Modify `src/lib/custom-providers.ts`: record every custom-provider network send and outcome.
- Modify `src/routes/dashboard/api.ts` and `src/routes/dashboard/route.ts`: expose the authenticated routing snapshot endpoint.
- Modify `ui/src/lib/types.ts`: mirror the routing snapshot contract.
- Modify `ui/src/screens/Usage.tsx`: preserve the cards and add polling, range controls, pulse metrics, model routing, account balance, and route breakdown.
- Modify `ui/src/global.css`: add responsive, theme-token-based styles for the new usage visualization.
- Regenerate `src/routes/dashboard/page-generated.ts`: embed the rebuilt dashboard.
- Create `tests/routing-telemetry.test.ts`: aggregation, retention, bounding, sorting, and empty-state coverage.
- Modify `tests/copilot-client.test.ts`, `tests/account-router.test.ts`, and `tests/custom-providers.test.ts`: transport and selection instrumentation coverage.
- Modify the relevant request/WebSocket test files: exactly-once request recording coverage.
- Create `tests/dashboard-usage-routing.test.ts`: endpoint validation, sensitive-field checks, and UI source-contract coverage.

### Task 1: Bounded In-Memory Aggregation Core

**Files:**
- Create: `src/lib/routing-telemetry.ts`
- Create: `tests/routing-telemetry.test.ts`

- [ ] **Step 1: Write failing aggregation and retention tests**

Add tests using the public wished-for API:

```ts
import {
  getRoutingTelemetrySnapshot,
  recordRoutingRequest,
  recordRoutingSelection,
  recordUpstreamCall,
  resetRoutingTelemetryForTest,
} from "~/lib/routing-telemetry"

test("separates client requests from retries and failovers", () => {
  const now = Date.UTC(2026, 7, 3, 12)
  recordRoutingRequest({
    model: "gpt-5.6-sol",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    status: 200,
    timestamp: now,
  })
  recordUpstreamCall({
    model: "gpt-5.6-sol",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    accountId: 0,
    reason: "initial",
    outcome: "server_error",
    timestamp: now,
  })
  recordUpstreamCall({
    model: "gpt-5.6-sol",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    accountId: 0,
    reason: "http_retry",
    outcome: "success",
    timestamp: now,
  })

  const snapshot = getRoutingTelemetrySnapshot({
    now,
    window: "1h",
    multiToken: true,
    accounts: [{ id: 0, healthy: true, accountType: "individual" }],
  })
  expect(snapshot.totals).toMatchObject({
    requests: 1,
    upstreamCalls: 2,
    retries: 1,
    failovers: 0,
  })
  expect(snapshot.models[0]).toMatchObject({
    model: "gpt-5.6-sol",
    requests: 1,
    upstreamCalls: 2,
  })
})

test("retains lifetime totals while pruning minute detail after 24 hours", () => {
  const now = Date.UTC(2026, 7, 3, 12)
  recordRoutingRequest({
    model: "old-model",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    status: 200,
    timestamp: now - 25 * 60 * 60_000,
  })
  const snapshot = getRoutingTelemetrySnapshot({
    now,
    window: "24h",
    multiToken: false,
    accounts: [],
  })
  expect(snapshot.totals.requests).toBe(0)
  expect(snapshot.lifetime.requests).toBe(1)
})
```

Also cover exact cutoff inclusion, 15m/1h/6h/24h chart intervals, eligibility-weighted expected selections, deterministic model sorting, custom-provider account omission, non-finite/invalid inputs, the dimension cap folding into `Other`, and a zero-valued snapshot.

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test tests/routing-telemetry.test.ts`

Expected: FAIL because `~/lib/routing-telemetry` does not exist.

- [ ] **Step 3: Implement the telemetry store**

Define these stable public types and entry points:

```ts
export type RoutingWindow = "15m" | "1h" | "6h" | "24h"
export type UpstreamOutcome =
  | "success"
  | "client_error"
  | "server_error"
  | "transport_error"
  | "aborted"
export type UpstreamSendReason =
  | "initial"
  | "http_retry"
  | "transport_retry"
  | "token_refresh"
  | "failover"
export type RoutingSelectionMode = "sticky" | "default" | "single"

export function recordRoutingRequest(event: RoutingRequestEvent): void
export function recordUpstreamCall(event: UpstreamCallEvent): void
export function recordRoutingSelection(event: RoutingSelectionEvent): void
export function getRoutingTelemetrySnapshot(
  options: RoutingSnapshotOptions,
): RoutingTelemetrySnapshot
export function isRoutingWindow(value: string): value is RoutingWindow
export function resetRoutingTelemetryForTest(startedAt?: number): void
```

Use a `Map<number, MinuteBucket>` keyed by minute. Store counters and dimension maps, never raw events. Prune timestamps older than `now - 24h` on writes and reads. Keep process-lifetime totals separately. Normalize strings to bounded lengths and cap model/provider combinations at 200, folding further combinations into `{ model: "Other", provider: "Other" }`. Recording functions wrap their internals in `try/catch` and return without throwing.

Build chart points at 1, 5, 30, and 120 minute intervals for 15m, 1h, 6h, and 24h respectively. Calculate account balance status as `not_applicable`, `insufficient_data`, `within_range`, or `skewed`, with skew requiring at least 30 selections and an absolute expected-share delta of at least 10 percentage points.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `bun test tests/routing-telemetry.test.ts`

Expected: all routing telemetry tests pass with zero warnings.

- [ ] **Step 5: Commit the aggregation core**

```powershell
git add src/lib/routing-telemetry.ts tests/routing-telemetry.test.ts
git commit -m "feat: add in-memory routing telemetry store"
```

### Task 2: Request Correlation and Exactly-Once Request Counts

**Files:**
- Modify: `src/lib/request-session.ts`
- Modify: `src/server.ts`
- Modify: `src/lib/request-logger.ts`
- Modify: `src/routes/responses/websocket-lifecycle.ts`
- Modify: `tests/request-id.test.ts`
- Modify: `tests/responses-websocket.test.ts`

- [ ] **Step 1: Write failing request-correlation tests**

Add an HTTP test that runs a model route through the real server middleware, then asserts one selected-window request in the routing snapshot. Add a logical lifecycle test that finalizes twice and asserts the WebSocket turn increments requests once. Verify a dashboard request with no model context is ignored.

The logical test uses an explicit state object so close-path finalization works outside the AsyncLocal callback:

```ts
const telemetryState = createRoutingTelemetryRequestState(
  "Responses WebSocket",
)
const lifecycle = startLogicalRequestLog({
  inputLength: 10,
  method: "POST",
  model: "gpt-test",
  path: "/responses",
  transport: "Responses WebSocket",
  turnId: "turn-1",
  telemetryState,
})
expect(lifecycle.finalize({ status: 200, terminalStatus: "COMPLETE" })).toBe(true)
expect(lifecycle.finalize({ status: 500, terminalStatus: "ERROR" })).toBe(false)
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test tests/request-id.test.ts tests/responses-websocket.test.ts`

Expected: FAIL because request telemetry context and lifecycle recording are missing.

- [ ] **Step 3: Implement request-scoped correlation**

Add a request state that stores only transient correlation data:

```ts
export interface RoutingTelemetryRequestState {
  sourceProtocol: string
  lastDestination?: string
  lastProvider?: string
  lastModel?: string
  requestRecorded?: boolean
}
```

Expose `routingTelemetryStorage`, `createRoutingTelemetryRequestState`, `getRoutingTelemetryRequestState`, and a helper that updates the last upstream destination. In `server.ts`, add the storage middleware before `requestLogger`:

```ts
server.use("*", async (c, next) => {
  const telemetryState = createRoutingTelemetryRequestState(
    getSourceProtocol(c.req.path),
  )
  await routingTelemetryStorage.run(telemetryState, next)
})
```

At HTTP request completion, record only when `ctx.model` exists and the state has not already been recorded. Prefer the last upstream model/provider/route from state and fall back to the structured request context. Extend `startLogicalRequestLog` to retain an explicit telemetry state and record during its idempotent `finalize` path.

Create each Responses WebSocket turn with its own state and run it inside the telemetry storage in `runWithWebSocketRequestContext`. Never store `turnId`, request ID, session ID, or client address in aggregate telemetry.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/request-id.test.ts tests/responses-websocket.test.ts tests/routing-telemetry.test.ts`

Expected: all tests pass; HTTP and WebSocket requests increment exactly once.

- [ ] **Step 5: Commit request correlation**

```powershell
git add src/lib/request-session.ts src/server.ts src/lib/request-logger.ts src/routes/responses/websocket-lifecycle.ts tests/request-id.test.ts tests/responses-websocket.test.ts
git commit -m "feat: record routed model requests"
```

### Task 3: Copilot Attempts, Retries, Failovers, and Account Balance

**Files:**
- Modify: `src/lib/token-pool.ts`
- Modify: `src/lib/account-router.ts`
- Modify: `src/services/copilot/copilot-client.ts`
- Modify: `tests/copilot-client.test.ts`
- Modify: `tests/account-router.test.ts`

- [ ] **Step 1: Write failing transport and selection tests**

Reset telemetry in each relevant test setup. Extend the existing queued-fetch tests to assert:

```ts
expect(snapshot.totals).toMatchObject({
  upstreamCalls: 2,
  retries: 1,
  failovers: 0,
})
expect(snapshot.models[0]?.accounts).toEqual([
  { accountId: 1001, upstreamCalls: 2, share: 1 },
])
```

For the existing `401 -> refresh -> 401 -> failover -> success` case, assert three Copilot model sends are classified as `initial`, `token_refresh`, and `failover`, and that the token-exchange HTTP request is not counted. For a transport retry, assert both attempts remain on the same account and the second is `transport_retry`. For initial account selection, assert one actual selection plus equal expected credit across eligible accounts and the correct sticky/default mode.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test tests/copilot-client.test.ts tests/account-router.test.ts`

Expected: FAIL because Copilot attempts and selections are not instrumented.

- [ ] **Step 3: Expose eligible account IDs**

Add read-only token-pool methods:

```ts
getEligibleAccountIdsForModel(modelId: string): Array<number>
getHealthyAccountIds(): Array<number>
```

Return new sorted arrays so callers cannot mutate the internal model index. Do not change `getAccountForModelBySession` or round-robin state.

- [ ] **Step 4: Attach outer-send metadata in the account router**

Add telemetry metadata to each `copilotFetch` call:

```ts
interface CopilotTelemetryOptions {
  accountId?: number
  model: string
  provider: "GitHub Copilot"
  destination: string
  reason: UpstreamSendReason
}
```

Use `initial` for the first send, `token_refresh` for the multi-token refresh resend, and `failover` for the alternative-account send. Before the initial send, call `recordRoutingSelection` with the chosen account, current eligible account IDs, and `sticky`, `default`, or `single` mode. Unknown-model fallback uses healthy account IDs for expected credits. A disabled known model that produces no upstream send produces neither a call nor a selection.

- [ ] **Step 5: Record every actual network attempt in `copilotFetch`**

At the actual `fetch(url, transportInit)` boundary, update request correlation and record one terminal outcome in `finally`-equivalent success/error paths. Initialize the attempt reason from outer metadata; before retrying set the next attempt reason to `http_retry`, `transport_retry`, or `token_refresh` as appropriate. Classify `2xx/3xx` as success, `4xx` as client error, `5xx` as server error, abort-like errors as aborted, and other thrown errors as transport errors.

Calls without telemetry metadata, including startup model discovery and GitHub token exchange, remain unrecorded.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `bun test tests/copilot-client.test.ts tests/account-router.test.ts tests/routing-telemetry.test.ts`

Expected: existing retry-budget tests and new telemetry assertions all pass.

- [ ] **Step 7: Commit Copilot instrumentation**

```powershell
git add src/lib/token-pool.ts src/lib/account-router.ts src/services/copilot/copilot-client.ts tests/copilot-client.test.ts tests/account-router.test.ts
git commit -m "feat: observe Copilot routing attempts"
```

### Task 4: Custom-Provider Calls

**Files:**
- Modify: `src/lib/custom-providers.ts`
- Modify: `tests/custom-providers.test.ts`

- [ ] **Step 1: Write failing custom-provider tests**

Extend the shared-fetch tests to assert one call for a successful chat or embedding request, no account ID, the configured provider name and upstream model, and the correct endpoint route. Add thrown transport-error and non-2xx response assertions.

```ts
expect(snapshot.models[0]).toMatchObject({
  model: "qwen3-embedding",
  provider: "Nebius",
  upstreamCalls: 1,
  accounts: [],
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test tests/custom-providers.test.ts`

Expected: FAIL because custom-provider sends do not update routing telemetry.

- [ ] **Step 3: Instrument the shared custom-provider fetch**

Before `fetch`, update transient request routing state with provider, model, and destination. After a response, record the status-class outcome. On a thrown error, record `aborted` or `transport_error` and rethrow the original error. Use reason `initial`; custom-provider code currently performs no automatic resend.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `bun test tests/custom-providers.test.ts tests/routing-telemetry.test.ts`

Expected: all custom-provider behavior and telemetry tests pass.

- [ ] **Step 5: Commit custom-provider instrumentation**

```powershell
git add src/lib/custom-providers.ts tests/custom-providers.test.ts
git commit -m "feat: observe custom provider calls"
```

### Task 5: Authenticated Routing Snapshot API

**Files:**
- Modify: `src/routes/dashboard/api.ts`
- Modify: `src/routes/dashboard/route.ts`
- Create: `tests/dashboard-usage-routing.test.ts`

- [ ] **Step 1: Write failing endpoint tests**

Use the existing dashboard session helper and real `server.request` path. Cover:

```ts
const response = await server.request(
  "/dashboard/api/usage-routing?window=15m",
  { headers: await createAdminSessionHeaders(server) },
)
expect(response.status).toBe(200)
expect(await response.json()).toMatchObject({
  window: "15m",
  retentionMinutes: 1440,
  totals: { requests: 0, upstreamCalls: 0 },
})
```

Assert unauthenticated access is `401`, invalid/multiple/empty window values are `400`, the default is `1h`, configured account health and optional GitHub username are returned, and serialized output contains no token, authorization, request ID, session ID, prompt, or header fields.

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test tests/dashboard-usage-routing.test.ts`

Expected: FAIL with `404` because the route is absent.

- [ ] **Step 3: Implement the handler and route**

Add:

```ts
export function handleGetUsageRouting(c: Context) {
  const window = c.req.query("window") ?? "1h"
  if (!isRoutingWindow(window)) {
    return c.json({ error: "window must be one of 15m, 1h, 6h, or 24h" }, 400)
  }
  return c.json(
    getRoutingTelemetrySnapshot({
      window,
      multiToken: state.isMultiToken,
      accounts: tokenPool.getAllAccounts().map(toSafeAccountMetadata),
    }),
  )
}
```

Register `GET /api/usage-routing` beside the existing usage route. Return only numeric IDs, account type, health, and optional GitHub username; never spread an `Account` object into JSON.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `bun test tests/dashboard-usage-routing.test.ts tests/admin-auth.test.ts`

Expected: endpoint and auth regression tests pass.

- [ ] **Step 5: Commit the API**

```powershell
git add src/routes/dashboard/api.ts src/routes/dashboard/route.ts tests/dashboard-usage-routing.test.ts
git commit -m "feat: expose routing usage snapshot"
```

### Task 6: Usage Page Redesign

**Files:**
- Modify: `ui/src/lib/types.ts`
- Modify: `ui/src/screens/Usage.tsx`
- Modify: `ui/src/global.css`
- Modify: `tests/dashboard-usage-routing.test.ts`
- Regenerate: `src/routes/dashboard/page-generated.ts`

- [ ] **Step 1: Add failing UI source-contract tests**

Read the source files in the existing dashboard-test style and assert the Usage screen retains `UsageSectionCard`, `five_hour`, `seven_day`, and `lifetime` rendering while adding:

- `/dashboard/api/usage-routing?window=` loading.
- `15m`, `1h`, `6h`, and `24h` controls.
- `usePolling` with a 10-second interval and `reloadSilently`.
- Routing Pulse metrics for requests, upstream calls, retries, and failovers.
- Model/provider filtering and account distribution.
- Account Balance and Route Breakdown sections.
- The `N/A` custom-provider account state.
- A restart/in-memory disclosure.

- [ ] **Step 2: Run UI contract and typecheck; verify RED**

Run: `bun test tests/dashboard-usage-routing.test.ts`

Run: `npm run typecheck` from `ui/`.

Expected: source-contract assertions fail because the redesign is absent; existing UI typecheck still passes.

- [ ] **Step 3: Add strict UI payload types**

Mirror the API with `RoutingTelemetrySnapshot`, totals, chart point, model row, account row, route row, window, outcome, and balance-status interfaces. Use arrays rather than index signatures for table rows and keep all optional account metadata explicit.

- [ ] **Step 4: Build the independently polling routing surface**

Keep `UsageSectionCard` and the existing usage fetch unchanged. Add a separate routing loader keyed by selected window and silent polling:

```ts
const [window, setWindow] = useState<RoutingWindow>("1h")
const routing = useAsyncData(() => loadRoutingUsage(window), [window])
usePolling(routing.reloadSilently, 10_000, [window])
```

Manual refresh invokes both reload functions. Render:

- A range control and four pulse metric cards.
- A CSS time-series chart with accessible labels and request/extra-call bars.
- A compact `DataTable` of effective model/provider rows, sorted by calls and filtered by a `TextInput`.
- A responsive pair containing Account Balance and Route Breakdown.
- Scoped loading, error, empty, single-token, insufficient-sample, and process-reset states.

Calculate display-only percentages defensively when denominators are zero. Use the API's account shares and balance status rather than reimplementing routing math in React.

- [ ] **Step 5: Add responsive theme-token styles**

Add `.usage-*` classes using existing CSS variables for borders, surfaces, text, success/warning/error colors, spacing, and radii. Do not hardcode a second theme. Ensure tables and account distribution bars shrink without forcing page-wide horizontal overflow.

- [ ] **Step 6: Run UI tests and typecheck; verify GREEN**

Run: `bun test tests/dashboard-usage-routing.test.ts`

Run: `npm run typecheck` from `ui/`.

Expected: all source-contract/API tests and TypeScript checks pass.

- [ ] **Step 7: Build and regenerate the embedded page**

Run: `npm run build` from `ui/`.

Expected: Vite succeeds and updates `src/routes/dashboard/page-generated.ts` with the Usage routing UI.

- [ ] **Step 8: Commit the dashboard redesign**

```powershell
git add ui/src/lib/types.ts ui/src/screens/Usage.tsx ui/src/global.css src/routes/dashboard/page-generated.ts tests/dashboard-usage-routing.test.ts
git commit -m "feat: redesign usage routing dashboard"
```

### Task 7: Full Verification and Review

**Files:**
- Verify all modified files

- [ ] **Step 1: Run focused feature tests**

Run:

```powershell
bun test tests/routing-telemetry.test.ts tests/copilot-client.test.ts tests/account-router.test.ts tests/custom-providers.test.ts tests/request-id.test.ts tests/responses-websocket.test.ts tests/dashboard-usage-routing.test.ts
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 2: Run the complete test suite**

Run: `bun test`

Expected: zero failed tests.

- [ ] **Step 3: Run strict typechecks and builds**

Run from the repository root:

```powershell
bun run typecheck
bun run build
```

Run from `ui/`:

```powershell
npm run typecheck
npm run build
```

Expected: every command exits zero.

- [ ] **Step 4: Lint the changed source files**

Run:

```powershell
bun run lint -- src/lib/routing-telemetry.ts src/lib/request-session.ts src/lib/request-logger.ts src/lib/token-pool.ts src/lib/account-router.ts src/services/copilot/copilot-client.ts src/lib/custom-providers.ts src/routes/responses/websocket-lifecycle.ts src/routes/dashboard/api.ts src/routes/dashboard/route.ts tests/routing-telemetry.test.ts tests/dashboard-usage-routing.test.ts ui/src/lib/types.ts ui/src/screens/Usage.tsx
```

Expected: zero lint errors.

- [ ] **Step 5: Inspect the final diff and formatting**

Run:

```powershell
git diff --check
git status --short
git diff --stat b3be96e..HEAD
```

Expected: no whitespace errors; only the planned feature files plus pre-existing `.superpowers/` content are present.

- [ ] **Step 6: Request code review and address findings**

Provide the reviewer the approved design, this plan, the base SHA before implementation, and current HEAD. Fix all critical and important findings, add regression tests for behavioral fixes, and rerun the affected focused tests.

- [ ] **Step 7: Run fresh final verification**

Repeat the full tests, UI typecheck/build, repository typecheck/build, changed-file lint, and `git diff --check` after review fixes. Only then report completion.
