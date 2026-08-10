# Hash-Only Session Affinity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every identified conversation on its rendezvous-hashed account and deterministic upstream identity across pod restarts, while fully reinitializing that same account after a 401 without any stored mapping or cross-session health mutation.

**Architecture:** Request-scoped affinity remains the only session input. A pure domain-separated SHA-256 helper converts it to an RFC-4122-shaped upstream UUID, while rendezvous hashing continues to select positional account IDs from the stable eligible set. The token pool gains atomic single-flight control-plane reinitialization; the router distinguishes identified from unidentified requests, forbids identified failover, and throws structured local errors after same-account recovery fails.

**Tech Stack:** Bun 1.3.x, strict TypeScript/ESNext, Hono, Bun test, Node `crypto`, Sentry/Consola logging.

---

## File Map

- Create `src/lib/upstream-session-affinity.ts`: pure hash-to-UUID derivation.
- Create `tests/upstream-session-affinity.test.ts`: deterministic UUID tests.
- Modify `src/services/copilot/copilot-client.ts`: request-scoped upstream IDs.
- Modify `src/lib/llm-debug-log.ts`: preserve raw upstream session headers in
  the administrator-only LLM Debug record, as required by the later Raw LLM
  Debug Capture design.
- Modify `src/lib/token-pool.ts`: atomic single-flight reinitialization.
- Modify `src/lib/account-router.ts`: strict identified-session behavior.
- Delete `src/lib/routing-affinity-leases.ts`: remove session mapping.
- Delete `tests/routing-affinity-leases.test.ts`: remove obsolete lease tests.
- Modify focused router, token, HTTP, WebSocket, and privacy tests.

### Task 1: Deterministic Upstream Identity and Raw Debug Capture

**Files:**
- Create: `src/lib/upstream-session-affinity.ts`
- Create: `tests/upstream-session-affinity.test.ts`
- Modify: `src/services/copilot/copilot-client.ts:1-127`
- Modify: `src/lib/llm-debug-log.ts:102-113`
- Modify: `tests/copilot-client.test.ts`
- Modify: `tests/llm-debug-log.test.ts`

- [ ] **Step 1: Write the pure derivation test first**

```ts
import { expect, test } from "bun:test"

import { deriveUpstreamSessionId } from "~/lib/upstream-session-affinity"

test("derives a stable RFC-4122 version-5 identity", () => {
  const first = deriveUpstreamSessionId("conversation-a")
  const second = deriveUpstreamSessionId("conversation-a")
  expect(first).toBe(second)
  expect(first).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
})

test("separates different conversations", () => {
  expect(deriveUpstreamSessionId("conversation-a")).not.toBe(
    deriveUpstreamSessionId("conversation-b"),
  )
})
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/upstream-session-affinity.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure helper**

```ts
import { createHash } from "node:crypto"

const UPSTREAM_SESSION_DOMAIN = "copilot-api/upstream-session/v1"

export function deriveUpstreamSessionId(affinityKey: string): string {
  const bytes = createHash("sha256")
    .update(`${UPSTREAM_SESSION_DOMAIN}\0${affinityKey}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/upstream-session-affinity.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing outbound-header tests**

```ts
test("derives restart-stable upstream headers from request affinity", () => {
  state.sessionId = "before-restart"
  const first = runWithRoutingAffinity(
    { key: "conversation", source: "codex_session" },
    () => copilotHeaders(),
  )
  state.sessionId = "after-restart"
  const second = runWithRoutingAffinity(
    { key: "conversation", source: "codex_session" },
    () => copilotHeaders(),
  )
  expect(second["X-Client-Session-Id"]).toBe(
    first["X-Client-Session-Id"],
  )
  expect(first["X-Interaction-Id"]).toBe(first["X-Client-Session-Id"])
  expect(first["X-Agent-Task-Id"]).toBe(first["X-Client-Session-Id"])
  expect(first["X-Client-Session-Id"]).not.toBe(state.sessionId)
})

test("uses process identity for unidentified requests", () => {
  state.sessionId = "process-session"
  const headers = copilotHeaders()
  expect(headers["X-Interaction-Id"]).toBe("process-session")
  expect(headers["X-Client-Session-Id"]).toBe("process-session")
  expect(headers["X-Agent-Task-Id"]).toBe("process-session")
})
```

- [ ] **Step 6: Verify header RED**

Run: `bun test tests/copilot-client.test.ts -t "upstream headers|process identity"`

Expected: the identified-request assertion fails.

- [ ] **Step 7: Use request-scoped identity in `copilotHeaders()`**

```ts
const affinityKey = getClientSessionId()
const upstreamSessionId =
  affinityKey ? deriveUpstreamSessionId(affinityKey) : state.sessionId

const headers: Record<string, string> = {
  // existing fields stay unchanged
  "X-Interaction-Id": upstreamSessionId,
  "X-Client-Session-Id": upstreamSessionId,
  "X-Agent-Task-Id": upstreamSessionId,
}
```

Keep `TokenPool.buildCopilotHeaders()` on the process identity because it is a
control-plane model-discovery call.

- [ ] **Step 8: Preserve the exact upstream session headers in LLM Debug**

```ts
expect(entry?.request.headers).toMatchObject({
  "X-Agent-Task-Id": derivedUpstreamSessionId,
  "X-Client-Session-Id": derivedUpstreamSessionId,
  "X-Interaction-Id": derivedUpstreamSessionId,
})
```

Run: `bun test tests/llm-debug-log.test.ts -t "session headers"`

Expected: PASS because the ten-minute administrator-only LLM Debug record is
the intentional raw-data exception. Ordinary logs and telemetry must still not
emit these values.

- [ ] **Step 9: Verify raw capture without adding a redaction pattern**

Do not add these session headers to any LLM Debug redaction pattern. The Raw LLM
Debug Capture design dated 2026-08-10 supersedes the earlier privacy assumption
in this plan.

Run:

```powershell
bun test tests/upstream-session-affinity.test.ts tests/copilot-client.test.ts tests/llm-debug-log.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 1**

```powershell
git add src/lib/upstream-session-affinity.ts src/services/copilot/copilot-client.ts src/lib/llm-debug-log.ts tests/upstream-session-affinity.test.ts tests/copilot-client.test.ts tests/llm-debug-log.test.ts
git commit -m "fix: stabilize upstream session identity"
```

### Task 2: Atomic Single-Flight Account Reinitialization

**Files:**
- Modify: `src/lib/token-pool.ts`
- Modify: `tests/token-pool.test.ts`

- [ ] **Step 1: Write failing account-state tests**

Add tests that prove: token plus models are replaced together; a `/models`
failure leaves the old token/models/health unchanged; and two concurrent calls
for one account issue exactly one token exchange and one model fetch.

Add these explicit helpers beside the tests, using the test file's local pool
and fetch queue:

```ts
function snapshotAccount(account: Account) {
  return {
    copilotToken: account.copilotToken,
    copilotTokenExpiry: account.copilotTokenExpiry,
    healthy: account.healthy,
    models: [...account.models],
    modelsData: account.modelsData,
  }
}

function tokenRequests() {
  return capturedRequests.filter(({ url }) =>
    url.includes("/copilot_internal/v2/token"),
  )
}

function modelRequests() {
  return capturedRequests.filter(({ url }) => url.endsWith("/models"))
}
```

```ts
test("preserves account state when reinitialization fails", async () => {
  const account = createInitializedAccount(pool)
  const before = snapshotAccount(account)
  queueTokenResponse("unused-token")
  queuedResults.push(new Response("model outage", { status: 503 }))
  await expect(pool.reinitializeAccount(account)).rejects.toThrow()
  expect(snapshotAccount(account)).toEqual(before)
})

test("coalesces concurrent account reinitialization", async () => {
  const account = createInitializedAccount(pool)
  const models = createDeferredFetchResponse()
  queueTokenResponse("fresh-token")
  queuedResults.push(models)
  const first = pool.reinitializeAccount(account)
  const second = pool.reinitializeAccount(account)
  await models.requestStarted
  models.resolveResponse(modelsResponse([createModel("fresh-model")]))
  await Promise.all([first, second])
  expect(tokenRequests()).toHaveLength(1)
  expect(modelRequests()).toHaveLength(1)
})
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/token-pool.test.ts -t "reinitialization|coalesces"`

Expected: FAIL because `reinitializeAccount()` does not exist.

- [ ] **Step 3: Implement single-flight staging**

```ts
private accountReinitializations = new Map<number, Promise<void>>()

async reinitializeAccount(account: Account, showToken = false): Promise<void> {
  const existing = this.accountReinitializations.get(account.id)
  if (existing) return await existing
  const current = this.performAccountReinitialization(account, showToken)
  this.accountReinitializations.set(account.id, current)
  try {
    await current
  } finally {
    if (this.accountReinitializations.get(account.id) === current) {
      this.accountReinitializations.delete(account.id)
    }
  }
}
```

Stage both control-plane results before the commit:

```ts
private async performAccountReinitialization(
  account: Account,
  showToken: boolean,
): Promise<void> {
  const tokenData = await this.fetchCopilotToken(account)
  const models = await this.fetchModels(
    account,
    this.getBaseUrl(account),
    tokenData.token,
  )
  account.copilotToken = tokenData.token
  account.copilotTokenExpiry = tokenData.expires_at
  account.modelsData = models.data
  account.models = new Set(models.data.map((model) => model.id))
  account.healthy = true
  this.rebuildModelIndex()
  this.setupRefreshTimer(
    account,
    getTokenRefreshIntervalMs(tokenData.refresh_in),
    showToken,
  )
}
```

Update `fetchModels` and `buildCopilotHeaders` to accept the candidate bearer
without mutating `account` before validation.

- [ ] **Step 4: Make scheduled refresh call full reinitialization**

```ts
const timer = setInterval(() => {
  void this.reinitializeAccount(account, showToken).catch((error: unknown) => {
    consola.error(`Failed to reinitialize account #${account.id}`, {
      errorClass: error instanceof Error ? error.name : "Unknown",
    })
  })
}, intervalMs)
```

Clear timers and the per-account in-flight map in `dispose()`. Do not log
arbitrary error messages.

- [ ] **Step 5: Verify GREEN and commit**

Run: `bun test tests/token-pool.test.ts`

Expected: PASS.

```powershell
git add src/lib/token-pool.ts tests/token-pool.test.ts
git commit -m "fix: reinitialize accounts atomically"
```

### Task 3: Strict Hash-Only Router Behavior

**Files:**
- Modify: `src/lib/account-router.ts`
- Delete: `src/lib/routing-affinity-leases.ts`
- Delete: `tests/routing-affinity-leases.test.ts`
- Modify: `tests/account-router.test.ts`
- Modify: `tests/account-router-telemetry.test.ts`

- [ ] **Step 1: Replace lease tests with production-cascade regressions**

Remove all lease imports, reset calls, and lease-specific tests. Add helpers
that find a key for an account through the real rendezvous selector and that
return only LLM Authorization headers from the existing captured fetches.

```ts
function findKeyForAccount(modelId: string, accountId: number): string {
  const key = Array.from({ length: 1000 }, (_, index) => `session-${index}`)
    .find(
      (candidate) =>
        tokenPool.getAccountForModelBySession(modelId, candidate)?.id
        === accountId,
    )
  if (!key) throw new TypeError(`No affinity key found for account ${accountId}`)
  return key
}

function findAnotherKeyForAccount(
  modelId: string,
  accountId: number,
  excluded: string,
): string {
  const key = Array.from({ length: 1000 }, (_, index) => `other-${index}`)
    .find(
      (candidate) =>
        candidate !== excluded
        && tokenPool.getAccountForModelBySession(modelId, candidate)?.id
          === accountId,
    )
  if (!key) throw new TypeError(`No second key found for account ${accountId}`)
  return key
}

function llmAuthorizationHeaders(): Array<string | null> {
  return capturedRequests
    .filter(({ url }) => !url.includes("/copilot_internal/") && !url.endsWith("/models"))
    .map(({ init }) => new Headers(init?.headers).get("authorization"))
}
```

```ts
test("keeps an identified session on its hashed account after persistent 401", async () => {
  const modelId = "identified-401-affinity"
  registerAccount(1201, modelId, "bound-token")
  registerAccount(1202, modelId, "alternate-token")
  tokenPool.rebuildModelIndex()
  const key = findKeyForAccount(modelId, 1201)
  queuePersistent401Reinitialization("fresh-bound-token", [modelId])

  const error = await routedFetchWithAffinity(modelId, key).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).response.status).toBe(409)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      account_id: 1201,
      code: "session_account_rejected",
      type: "session_affinity_error",
    },
  })
  expect(tokenPool.getEligibleAccountForModel(modelId, 1201)).toBeDefined()
  expect(llmAuthorizationHeaders()).not.toContain("Bearer alternate-token")
})

test("one request rejection cannot remap another session", async () => {
  const modelId = "cross-session-health-regression"
  registerAccount(1211, modelId, "shared-home")
  registerAccount(1212, modelId, "other-home")
  tokenPool.rebuildModelIndex()
  const rejectedKey = findKeyForAccount(modelId, 1211)
  const unaffectedKey = findAnotherKeyForAccount(
    modelId,
    1211,
    rejectedKey,
  )
  queuePersistent401Reinitialization("refreshed-home", [modelId])
  await routedFetchWithAffinity(modelId, rejectedKey).catch(() => undefined)
  queuedResults.push(new Response("{}", { status: 200 }))
  const result = await routedFetchWithAffinity(modelId, unaffectedKey)
  expect(result.account?.id).toBe(1211)
  expect(tokenPool.getHealthyAccountIds()).toContain(1211)
})
```

Also add explicit identified 403 and 429 tests: 403 must become a local 409
without failover; exhausted same-account 429 retry must return 429 and every
LLM bearer must belong to the hashed home.

- [ ] **Step 2: Verify strict-routing RED**

Run:

```powershell
bun test tests/account-router.test.ts -t "identified|one request rejection"
```

Expected: FAIL because leases/failover/global unhealthy mutation still exist.

- [ ] **Step 3: Add exact local error factories**

```ts
function createSessionAccountRejectedError(account: Account): LocalHTTPError {
  const clientBody = {
    error: {
      account_id: account.id,
      code: "session_account_rejected",
      message:
        "The bound account rejected this conversation after successful account reinitialization; affinity was preserved and no cross-account retry was attempted.",
      type: "session_affinity_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 409 }),
    clientBody,
  )
}

function createAccountReinitializationFailedError(
  account: Account,
): LocalHTTPError {
  const clientBody = {
    error: {
      account_id: account.id,
      code: "account_reinitialization_failed",
      message:
        "The bound account could not be reinitialized; affinity was preserved and no cross-account retry was attempted.",
      type: "account_unavailable",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 503 }),
    clientBody,
  )
}
```

- [ ] **Step 4: Reinitialize and retry the same account after 401**

Replace the token-only refresh helper with:

```ts
async function reinitializeAndRetryAccount(
  options: AccountFetchOptions,
): Promise<Response> {
  const { account, path, retryBudget } = options
  consola.warn(
    `[Account #${account.id}] HTTP 401 on ${path}, reinitializing account credentials and models`,
  )
  try {
    await tokenPool.reinitializeAccount(account, state.showToken)
  } catch (error) {
    consola.warn(
      `[Account #${account.id}] Account reinitialization failed after HTTP 401 on ${path}`,
      error instanceof HTTPError ? { status: error.response.status } : {
        errorClass: error instanceof Error ? error.name : "Unknown",
      },
    )
    throw createAccountReinitializationFailedError(account)
  }
  if (!consumeExtraSend(retryBudget)) return new Response(null, { status: 401 })
  return await fetchWithAccount({ ...options, reason: "token_refresh" })
}
```

After the resend, preserve an identified session:

```ts
const identified = Boolean(context.affinityKey)
if (identified && (response.status === 401 || response.status === 403)) {
  throw createSessionAccountRejectedError(account)
}
if (identified) return { response, account }
```

This also prevents identified 429 failover after `copilotFetch` exhausts its
same-account bounded retry.

- [ ] **Step 5: Remove global inference health mutation and mappings**

Delete the `markUnhealthy()` call from `failoverToAccount`. Delete lease reads,
writes, and imports. Route directly with:

```ts
const account = tokenPool.getAccountForModelBySession(modelId, affinityKey)
```

Delete both lease files. Verify:

Run: `rg -n "routing-affinity-leases|RoutingAffinityLease" src tests`

Expected: no matches.

- [ ] **Step 6: Retain unidentified bounded failover**

Update the existing unidentified 401 test to queue: inference 401, token 200,
models 200, inference 401, alternate inference 200. Assert the alternate wins
but the original account remains healthy. Update telemetry expectations to
three LLM sends: initial, same-account resend, and failover.

- [ ] **Step 7: Cover failed reinitialization**

Queue token exchange success then `/models` 503. Assert local 503 code
`account_reinitialization_failed`, unchanged prior account snapshot, and no
alternate-account send.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```powershell
bun test tests/account-router.test.ts tests/account-router-telemetry.test.ts
```

Expected: PASS.

```powershell
git add src/lib/account-router.ts src/lib/routing-affinity-leases.ts tests/account-router.test.ts tests/account-router-telemetry.test.ts tests/routing-affinity-leases.test.ts
git commit -m "fix: preserve hashed account affinity"
```

### Task 4: Structured HTTP and Responses WebSocket Errors

**Files:**
- Modify: `src/routes/responses/websocket.ts`
- Modify: `tests/create-responses.test.ts`
- Modify: `tests/responses-websocket.test.ts`
- Modify: `tests/error.test.ts`

- [ ] **Step 1: Write the HTTP integration RED test**

Configure two accounts for a test model, send `/v1/responses` with
`client_metadata.session_id`, and queue 401, token 200, models 200, 401.

```ts
expect(response.status).toBe(409)
expect(await response.json()).toMatchObject({
  error: {
    code: "session_account_rejected",
    type: "session_affinity_error",
  },
})
```

Assert every LLM Authorization header belongs to the hashed account and the
raw affinity key is absent from the serialized response.

- [ ] **Step 2: Verify HTTP RED**

Run: `bun test tests/create-responses.test.ts -t "session account rejected"`

Expected: FAIL until the local error propagates through `forwardError`.

- [ ] **Step 3: Write the WebSocket integration RED test**

Run the same sequence through an identified `response.create` and assert:

```ts
expect(errorFrame).toMatchObject({
  type: "error",
  status: 409,
  error: {
    code: "bad_request",
    message:
      "The bound account rejected this conversation after successful account reinitialization; affinity was preserved and no cross-account retry was attempted.",
    type: "session_affinity_error",
  },
})
```

- [ ] **Step 4: Verify WebSocket RED**

Run: `bun test tests/responses-websocket.test.ts -t "session affinity error"`

Expected: FAIL because the frame currently uses the generic fallback message.

- [ ] **Step 5: Preserve only safe local error fields**

```ts
function localWebSocketError(
  error: LocalHTTPError,
): { message?: string; type?: string } {
  const bodyError = error.clientBody.error
  if (!isRecord(bodyError)) return {}
  return {
    ...(typeof bodyError.message === "string" ?
      { message: bodyError.message }
    : {}),
    ...(typeof bodyError.type === "string" ? { type: bodyError.type } : {}),
  }
}
```

Handle `LocalHTTPError` before generic HTTP errors in
`normalizeWebSocketError`, using status mapping plus the safe message/type.
Keep status 409 on the existing default client-error mapping (`bad_request`).

- [ ] **Step 6: Verify GREEN and commit**

Run:

```powershell
bun test tests/error.test.ts tests/create-responses.test.ts tests/responses-websocket.test.ts
```

Expected: PASS, including existing payload-too-large local errors.

```powershell
git add src/routes/responses/websocket.ts tests/create-responses.test.ts tests/responses-websocket.test.ts tests/error.test.ts
git commit -m "fix: report session affinity conflicts"
```

### Task 5: Full Verification

**Files:**
- Modify only exact files required by verification failures.

- [ ] **Step 1: Run the focused regression matrix**

```powershell
bun test tests/upstream-session-affinity.test.ts tests/routing-affinity.test.ts tests/token-pool.test.ts tests/account-router.test.ts tests/account-router-telemetry.test.ts tests/copilot-client.test.ts tests/llm-debug-log.test.ts tests/create-chat-completions.test.ts tests/create-responses.test.ts tests/responses-websocket.test.ts tests/error.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Prove the no-storage invariant**

```powershell
rg -n "routing-affinity-leases|RoutingAffinityLease|session.*account.*Map|affinity.*Map" src tests
rg -n "writeFile|appendFile|Database|bun:sqlite" src/lib/upstream-session-affinity.ts src/lib/account-router.ts
```

Expected: no session mapping/lease or filesystem/database write. Review broad
`Map` matches manually; token-pool's per-account in-flight promise map is
allowed because it stores no session data.

- [ ] **Step 3: Run typecheck and lint**

```powershell
bun run typecheck
bun run lint
```

Expected: exit 0 with no new changed-file warnings.

- [ ] **Step 4: Run the full suite**

Run: `bun test`

Expected: zero failures.

- [ ] **Step 5: Build and check the branch diff**

```powershell
bun run build
git diff --check origin/master...HEAD
git status --short
git diff --stat origin/master...HEAD
```

Expected: build exit 0, no whitespace errors, the unrelated untracked
`.superpowers/` directory untouched, and only approved implementation/test/docs
changes in the branch.

- [ ] **Step 6: Audit against the approved specification**

Re-read `docs/superpowers/specs/2026-08-10-hash-only-session-affinity-design.md`.
Check each acceptance criterion against fresh output. Do not claim completion
unless both production regressions demonstrated RED before implementation and
GREEN afterward.

- [ ] **Step 7: Commit only final corrections, if any**

Run `git status --short`, inspect each modified path, and stage only the exact
files changed to correct a verification failure. Then run
`git commit -m "test: complete session affinity regressions"`. Do not create an
empty commit when no correction was needed.
