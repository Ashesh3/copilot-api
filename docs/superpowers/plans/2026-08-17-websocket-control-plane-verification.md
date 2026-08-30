# WebSocket, Control Plane, Documentation, and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete current Copilot compatibility with recoverable Responses WebSocket behavior, safe per-turn metadata, model policy and Auto/session routes, durable compatibility documentation, and full automated/live verification.

**Architecture:** The local HTTP-backed Responses WebSocket transport remains in place but gains a typed frame parser, connection-scoped continuation errors compatible with current clients, and event metadata derived from the successful upstream attempt. A focused control-plane service forwards model policy, model-session, Auto, and intent requests through the same account-aware contract without storing token-to-account mappings. Final documentation records the implemented contract and intentional local differences, followed by full verification and independent review.

**Tech Stack:** Bun 1.3.x, strict TypeScript/ESNext, Hono, Bun WebSocket APIs, existing account router, Bun test, live Copilot integration probes.

**Spec:** `docs/superpowers/specs/2026-08-17-copilot-api-contract-parity-design.md`

## Global Constraints

- Requires all three preceding plans.
- Keep the local no-storage, HTTP-backed Responses WebSocket transport; do not introduce direct upstream WebSocket state in this change.
- Accept only JSON text `response.create` frames; validation errors must be recoverable and leave the socket open.
- Only response IDs issued on the current local connection may continue a snapshot.
- Unknown snapshot IDs use code `previous_response_not_found` so clients can replay full history once.
- Never replay after substantive output was sent.
- Per-turn headers use the typed attribution allowlist; authentication/session-token headers in a frame envelope are ignored.
- Control-plane session tokens are secrets, are model-scoped, and must never be logged or persisted by the gateway.
- Multi-account control-plane continuity uses existing affinity only; no session-token-to-account map may be added.
- Preserve protocol-native errors and ordinary-boundary redaction.
- Use TDD, focused commits, full verification, and independent review.

---

## File Map

- Create `src/routes/responses/websocket-protocol.ts`: frame parsing, per-turn attribution extraction, continuation resolution, and output envelope helpers.
- Create `tests/responses-websocket-protocol.test.ts`: pure protocol tests.
- Modify `src/routes/responses/websocket.ts`: use the protocol module, compatible errors, and response metadata envelopes.
- Modify `src/routes/responses/websocket-lifecycle.ts`: run per-turn typed attribution/response-metadata scopes.
- Modify `tests/responses-websocket.test.ts`: end-to-end local transport tests.
- Create `src/services/copilot/control-plane.ts`: policy, model-session, Auto, and intent upstream calls.
- Create `src/routes/copilot-control-plane/route.ts`: authenticated public compatibility routes.
- Create `tests/copilot-control-plane.test.ts`: service and route tests.
- Modify `src/server.ts`: mount control-plane routes behind existing inference authentication.
- Modify `src/routes/models/route.ts`: mount model policy route or delegate to control-plane service.
- Create `docs/copilot-api-compatibility.md`: durable contract report.
- Create `tests/copilot-compatibility-doc.test.ts`: documentation invariants.
- Create or modify `tests/integration/responses-cache-control.test.ts` and `tests/integration/responses-websocket.test.ts` for the exact live probes described below.

### Task 1: Parse and Validate Responses WebSocket Frames Recoverably

**Files:**
- Create: `src/routes/responses/websocket-protocol.ts`
- Create: `tests/responses-websocket-protocol.test.ts`
- Modify: `src/routes/responses/websocket.ts:149-247,268-287,678-694`
- Modify: `tests/responses-websocket.test.ts:409-550,1428-1534`

**Interfaces:**
- Consumes: `ResponsesPayload`, shared typed attribution, and existing `WebSocketRequestError`.
- Produces:

```ts
export interface ParsedResponseCreateFrame {
  attribution: CopilotRequestAttribution
  payload: ResponsesPayload
  requestedModel?: string
}

export type WebSocketFrameParseResult =
  | { ok: true; value: ParsedResponseCreateFrame }
  | {
      ok: false
      error: {
        code: string
        message: string
        status: number
        type: "invalid_request_error"
      }
    }

export function parseResponsesWebSocketFrame(
  message: string | Buffer | Uint8Array,
): WebSocketFrameParseResult
```

- [ ] **Step 1: Write failing pure frame-parser tests**

```ts
import { expect, test } from "bun:test"

import { parseResponsesWebSocketFrame } from "~/routes/responses/websocket-protocol"

test("accepts a response.create frame with nested and top-level fields", () => {
  const result = parseResponsesWebSocketFrame(JSON.stringify({
    type: "response.create",
    model: "gpt-current",
    input: "hello",
    response: { stream: true, max_output_tokens: 128 },
    initiator: "agent",
    agent_task_id: "task-1",
    parent_agent_id: "parent-1",
    headers: {
      "X-Interaction-Type": "conversation-subagent",
      "X-Client-Machine-Id": "machine-1",
      "Authorization": "Bearer must-not-pass",
      "Copilot-Session-Token": "must-not-pass",
    },
  }))
  expect(result).toEqual({
    ok: true,
    value: {
      requestedModel: "gpt-current",
      payload: {
        model: "gpt-current",
        input: "hello",
        stream: true,
        max_output_tokens: 128,
      },
      attribution: {
        agentTaskId: "task-1",
        parentAgentId: "parent-1",
        interactionType: "conversation-subagent",
        clientMachineId: "machine-1",
      },
    },
  })
})

test.each([
  [Buffer.from("binary"), "Binary frames not supported"],
  ["not-json", "Invalid JSON"],
  [JSON.stringify({ type: "response.processed" }), "Unsupported message type"],
  [JSON.stringify({ type: "other" }), "Unsupported message type"],
] as const)("returns a recoverable parse error", (message, expected) => {
  const result = parseResponsesWebSocketFrame(message)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.status).toBe(400)
    expect(result.error.message).toContain(expected)
  }
})

test("rejects explicit stream false before forcing WebSocket streaming", () => {
  const result = parseResponsesWebSocketFrame(JSON.stringify({
    type: "response.create",
    model: "gpt-current",
    input: "hello",
    stream: false,
  }))
  expect(result).toEqual({
    ok: false,
    error: {
      code: "invalid_request_error",
      message: "Responses WebSocket requests must stream.",
      status: 400,
      type: "invalid_request_error",
    },
  })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/responses-websocket-protocol.test.ts`

Expected: module does not exist; current dispatcher silently accepts `response.processed` and forces `stream:true` after parsing.

- [ ] **Step 3: Implement the pure parser**

Rules:

- binary input returns a recoverable error;
- JSON must decode to a record;
- only `type:"response.create"` is accepted;
- merge top-level and nested `response` fields, excluding protocol envelope keys `type`, `headers`, `initiator`, `agent_task_id`, and `parent_agent_id`;
- explicit `stream:false` returns an error; omitted/true is accepted;
- top-level initiator/task fields override same-purpose header-envelope values;
- top-level `initiator` accepts only `user` or `agent` and is applied to the typed header options used by `createResponses()`; invalid values return a recoverable 400;
- header envelope is passed through `resolveCopilotRequestAttribution()` after removing auth/session-token headers;
- return requested model from nested response first, then top level.

- [ ] **Step 4: Replace inline parsing in the WebSocket dispatcher**

On parse failure, call `sendWebSocketError()` and return without creating a turn. On success, create the turn, force `payload.stream = true`, and pass the parsed attribution into the lifecycle scope.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
bun test tests/responses-websocket-protocol.test.ts tests/responses-websocket.test.ts -t "unsupported|binary|Invalid JSON|stream false|response.processed"
```

Expected: PASS; the socket remains usable after each error.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/routes/responses/websocket-protocol.ts src/routes/responses/websocket.ts tests/responses-websocket-protocol.test.ts tests/responses-websocket.test.ts
git commit -m "fix: validate Responses WebSocket frames"
```

### Task 2: Return Compatible Continuation Errors and Preserve No-Storage Rehydration

**Files:**
- Modify: `src/routes/responses/websocket-protocol.ts`
- Modify: `src/routes/responses/websocket.ts:268-287,480-523,700-758,959-997`
- Modify: `tests/responses-websocket-protocol.test.ts`
- Modify: `tests/responses-websocket.test.ts:1060-1140,1535-1640`

**Interfaces:**
- Consumes: connection-local snapshot map and parsed payload.
- Produces:

```ts
export type ContinuationResolution =
  | { ok: true; payload: ResponsesPayload }
  | {
      ok: false
      code: "invalid_request_error" | "previous_response_not_found"
      message: string
      status: 400
    }

export function resolveResponsesContinuation(
  snapshots: ReadonlyMap<string, ResponsesPayload>,
  payload: ResponsesPayload,
): ContinuationResolution
```

- [ ] **Step 1: Write failing continuation tests**

```ts
test("starts a new thread when previous_response_id is omitted", () => {
  expect(resolveResponsesContinuation(new Map(), {
    model: "gpt-current",
    input: "hello",
  })).toEqual({
    ok: true,
    payload: { model: "gpt-current", input: "hello" },
  })
})

test("rehydrates a known connection-local response id", () => {
  const snapshots = new Map([["resp_1", {
    model: "gpt-current",
    instructions: "stable",
    input: [{ role: "user", content: "first" }],
    tools: [{ type: "function", name: "run" }],
  } as ResponsesPayload]])
  const result = resolveResponsesContinuation(snapshots, {
    model: "gpt-current",
    previous_response_id: "resp_1",
    input: [{ role: "user", content: "second" }],
  })
  expect(result).toMatchObject({
    ok: true,
    payload: {
      instructions: "stable",
      previous_response_id: undefined,
      tools: [{ type: "function", name: "run" }],
    },
  })
})

test("returns previous_response_not_found for a stale local id", () => {
  expect(resolveResponsesContinuation(new Map(), {
    model: "gpt-current",
    input: "delta",
    previous_response_id: "resp_stale",
  })).toEqual({
    ok: false,
    code: "previous_response_not_found",
    message: "The previous response is not available on this WebSocket connection.",
    status: 400,
  })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/responses-websocket-protocol.test.ts tests/responses-websocket.test.ts -t "previous_response"`

Expected: stale IDs currently map to `bad_request` with the raw ID in the message.

- [ ] **Step 3: Move continuation resolution into the protocol module**

Reuse existing merge/snapshot behavior. Fixed errors must not echo the stale ID. Preserve only current-connection snapshots. Document in a code comment that external IDs cannot be resolved without direct upstream state or storage.

When a result is not ok, throw `WebSocketRequestError` with an explicit `errorCode` property in addition to `errorType`; update the class signature:

```ts
constructor(
  message: string,
  status: number,
  errorType: string,
  errorCode = "bad_request",
)
```

- [ ] **Step 4: Preserve the explicit error code in `sendWebSocketError()`**

`normalizeWebSocketError()` returns `WebSocketRequestError.errorCode` rather than deriving `bad_request` from status 400.

- [ ] **Step 5: Run focused continuation tests and verify GREEN**

```powershell
bun test tests/responses-websocket-protocol.test.ts tests/responses-websocket.test.ts -t "previous_response|continuation|warmup"
```

Expected: PASS. Known continuations still clear the upstream stateful field and payload recovery remains active after rehydration.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/routes/responses/websocket-protocol.ts src/routes/responses/websocket.ts src/routes/responses/websocket-lifecycle.ts tests/responses-websocket-protocol.test.ts tests/responses-websocket.test.ts
git commit -m "fix: align WebSocket continuation errors"
```

### Task 3: Apply Per-Turn Attribution and Emit Safe Event Metadata

**Files:**
- Modify: `src/routes/responses/websocket-lifecycle.ts:1-156`
- Modify: `src/routes/responses/websocket.ts:298-389,959-1016`
- Modify: `src/routes/responses/websocket-protocol.ts`
- Modify: `tests/responses-websocket.test.ts`
- Modify: `tests/request-id.test.ts`

**Interfaces:**
- Consumes: `CopilotRequestAttribution`, safe response metadata storage, and raw upstream Responses events.
- Produces:

```ts
export function runWithWebSocketRequestContext<T>(
  affinity: RoutingAffinity | undefined,
  attribution: CopilotRequestAttribution,
  turn: ResponsesWebSocketTurn,
  callback: () => Promise<T>,
): Promise<T>

export function addResponsesWebSocketMetadata(
  frame: string,
  headers: Record<string, string>,
): string
```

- [ ] **Step 1: Write failing per-turn attribution tests**

Send two turns on one socket with different `X-Agent-Task-Id`, parent ID, interaction type, and client experiment context. Assert captured upstream HTTP headers reflect each turn independently while `X-Interaction-Id` and account affinity remain stable for the connection/session.

Add a spoof control containing `Authorization`, `Copilot-Session-Token`, and `X-GitHub-User` inside the frame header envelope; assert none reaches upstream.

- [ ] **Step 2: Write failing output metadata tests**

Queue an upstream stream whose successful HTTP response includes:

```ts
{
  "x-copilot-service-request-id": "service-1",
  "x-copilot-api-exp-assignment-context": "flight:1;",
  "x-quota-snapshot-premium_interactions": "ent=100&rem=50",
}
```

Assert outward `response.created` and terminal response frames contain:

```ts
headers: {
  "x-copilot-service-request-id": "service-1",
  "x-copilot-api-exp-assignment-context": "flight:1;",
}
copilot_quota_snapshots: {
  premium_interactions: "ent=100&rem=50"
}
```

Do not add metadata to arbitrary delta frames unless the first/terminal frame is unavailable; preserve raw event order and body fields.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `bun test tests/responses-websocket.test.ts -t "per-turn|metadata|quota|spoof"`

Expected: frame attribution is stripped by the Responses allowlist and no metadata envelope is emitted.

- [ ] **Step 4: Add attribution storage to the WebSocket lifecycle scope**

Nest the callback scopes in this order:

1. request ID;
2. routing affinity;
3. typed Copilot request attribution;
4. safe response metadata storage;
5. routed account/telemetry storage.

Each turn receives a fresh safe-response metadata store so concurrent turns cannot leak headers.

- [ ] **Step 5: Add safe event metadata**

Parse each JSON frame as a record. For `response.created`, `response.completed`, `response.incomplete`, and `response.failed`, spread the record and add:

- `headers`: safe non-quota metadata;
- `copilot_quota_snapshots`: keys derived by removing `x-quota-snapshot-` from safe metadata; and
- retain an existing `copilot_usage` field untouched.

Return the original frame if parsing fails, the type is not eligible, or no metadata exists. Never include `retry-after` or usage-ratelimit fields in the WebSocket body; they remain HTTP metadata only.

When a Chat or buffered Messages fallback produces an internal SSE iterable, consume `[DONE]` as a local terminator and never forward it as a raw WebSocket text frame. Add an assertion that every outgoing fallback frame parses as JSON and the final type is `response.completed`, `response.failed`, or `error`, never `[DONE]`.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
bun test tests/responses-websocket.test.ts tests/request-id.test.ts tests/copilot-request-context.test.ts
```

Expected: PASS, including concurrent-turn isolation and existing lifecycle logging.

- [ ] **Step 7: Commit Task 3**

```powershell
git add src/routes/responses/websocket-lifecycle.ts src/routes/responses/websocket.ts src/routes/responses/websocket-protocol.ts tests/responses-websocket.test.ts tests/request-id.test.ts
git commit -m "feat: preserve WebSocket turn metadata"
```

### Task 4: Add Account-Aware Model Policy and Auto/Session Services

**Files:**
- Create: `src/services/copilot/control-plane.ts`
- Create: `src/routes/copilot-control-plane/route.ts`
- Create: `tests/copilot-control-plane.test.ts`
- Modify: `src/lib/token-pool.ts`
- Modify: `src/lib/account-router.ts`
- Modify: `tests/token-pool.test.ts`
- Modify: `src/routes/models/route.ts`
- Modify: `src/server.ts`
- Modify: `src/lib/error.ts`

**Interfaces:**
- Consumes: `routedFetch()`, current contract headers, routing affinity, safe response metadata, and `Copilot-Session-Token` typed header support.
- Produces:

```ts
export interface EnableModelPolicyResult {
  can_be_enabled?: boolean
  error?: string
  success: boolean
}

export async function enableCopilotModelPolicy(
  modelId: string,
  signal?: AbortSignal,
): Promise<EnableModelPolicyResult>

export async function createCopilotModelSession(options: {
  existingToken?: string
  signal?: AbortSignal
}): Promise<Record<string, unknown>>

export async function createCopilotAutoSession(options: {
  hasImage: boolean
  multiTurn?: Record<string, unknown>
  prompt: string
  signal?: AbortSignal
  tier?: string
}): Promise<Record<string, unknown>>

export async function predictCopilotIntent(options: {
  availableModels: Array<string>
  hasImage: boolean
  payload: Record<string, unknown>
  sessionToken: string
  signal?: AbortSignal
}): Promise<Record<string, unknown>>

export function getHealthyAccountBySession(
  clientSessionId?: string,
): Account | undefined

export function getAccountAdvertisingModelBySession(
  modelId: string,
  clientSessionId?: string,
): Account | undefined

export async function routedControlPlaneFetch(options: {
  body?: Record<string, unknown>
  copilotSessionToken?: string
  modelId?: string
  path: string
  signal?: AbortSignal
}): Promise<{ account: Account | undefined; response: Response }>
```

- [ ] **Step 1: Write failing service tests for exact paths, bodies, and secrets**

```ts
test("enables a percent-encoded model policy", async () => {
  const result = await enableCopilotModelPolicy("claude/model 1")
  expect(result).toEqual({ success: true })
  expect(lastUpstreamPath).toBe("/models/claude%2Fmodel%201/policy")
  expect(lastRequestInit?.method).toBe("POST")
})

test("creates and refreshes model sessions", async () => {
  await createCopilotModelSession({})
  expect(lastUpstreamPath).toBe("/models/session")
  expect(lastUpstreamPayload).toEqual({
    auto_mode: { model_hints: ["auto"] },
  })
  expect(lastUpstreamHeaders).not.toHaveProperty("Copilot-Session-Token")

  await createCopilotModelSession({ existingToken: "session-secret" })
  expect(lastUpstreamPayload).toBeUndefined()
  expect(lastUpstreamHeaders["Copilot-Session-Token"]).toBe("session-secret")
})

test("creates Auto sessions with forward-compatible optional fields", async () => {
  await createCopilotAutoSession({
    prompt: "inspect image",
    hasImage: true,
    tier: "balanced",
    multiTurn: { sigma: 1.2 },
  })
  expect(lastUpstreamPath).toBe("/auto")
  expect(lastUpstreamPayload).toEqual({
    prompt: "inspect image",
    has_image: true,
    tier: "balanced",
    multi_turn: { sigma: 1.2 },
  })
})

test("requires and forwards the model session token for intent", async () => {
  await expect(predictCopilotIntent({
    sessionToken: "",
    availableModels: ["gpt-current"],
    hasImage: false,
    payload: { prompt: "refactor" },
  })).rejects.toBeInstanceOf(LocalHTTPError)

  await predictCopilotIntent({
    sessionToken: "session-secret",
    availableModels: ["gpt-current", "claude-current"],
    hasImage: false,
    payload: {
      prompt: "refactor",
      previous_user_messages: ["oldest", "latest"],
      routing_intent: "code",
    },
  })
  expect(lastUpstreamPath).toBe("/models/session/intent")
  expect(lastUpstreamHeaders["Copilot-Session-Token"]).toBe("session-secret")
  expect(lastUpstreamPayload).toMatchObject({
    prompt: "refactor",
    available_models: ["gpt-current", "claude-current"],
    has_image: false,
    previous_user_messages: ["oldest", "latest"],
    routing_intent: "code",
  })
})

test("never logs or returns a session token on errors", async () => {
  queuedResponse = Response.json(
    { error: { message: "session-secret private body" } },
    { status: 400 },
  )
  const errorSpy = spyOn(consola, "error")
  await expect(createCopilotModelSession({
    existingToken: "session-secret",
  })).rejects.toBeInstanceOf(HTTPError)
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("session-secret")
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/copilot-control-plane.test.ts`

Expected: service module does not exist.

- [ ] **Step 3: Write failing raw-membership and healthy-account selection tests**

Add token-pool tests proving:

- policy selection can choose a healthy account whose raw `account.models` advertises the model even when `isModelEnabledForAccount()` excluded it from the inference `modelIndex`;
- identical affinity selects the same healthy control-plane account across calls;
- distinct affinity distributes across healthy accounts;
- no affinity selects the first healthy account; and
- a model advertised by no healthy account returns undefined rather than using an unrelated account.

Run:

```powershell
bun test tests/token-pool.test.ts -t "control-plane|advertising model"
```

Expected: FAIL because these selection methods do not exist.

- [ ] **Step 4: Implement deterministic control-plane selection**

Reuse the token pool's existing private rendezvous score helper. `getHealthyAccountBySession()` hashes across all healthy accounts. `getAccountAdvertisingModelBySession()` hashes only across healthy accounts whose raw `account.models` contains the model ID; it deliberately ignores operator inference enable/disable overrides and the inference `modelIndex`.

These methods are read-only and create no mapping. Account IDs/token order retain the same stability assumptions as inference affinity.

- [ ] **Step 5: Implement `routedControlPlaneFetch()`**

In `account-router.ts`:

- single-token mode uses `copilotHeaders()` and `copilotFetch()`;
- multi-token policy calls (`modelId` supplied) use `getAccountAdvertisingModelBySession(modelId, affinityKey)`;
- multi-token Auto/session/intent calls use `getHealthyAccountBySession(affinityKey)`;
- if no matching account exists, return a local JSON response with status 503 and no upstream send;
- build headers from the selected account token plus typed session-token options;
- set the routed-account request context for diagnostics;
- use one normal `copilotFetch()` retry budget, with no cross-account failover after selection.

Control-plane 401 may reuse the existing same-account reinitialization helper only when it can do so without changing the selected account. It must never fail over a session-token/policy call to another account.

- [ ] **Step 6: Implement typed control-plane JSON calls**

Use a private helper:

```ts
async function routedControlPlaneJson(options: {
  body?: Record<string, unknown>
  copilotSessionToken?: string
  modelId: string
  path: string
  signal?: AbortSignal
}): Promise<Record<string, unknown>>
```

`modelId` is supplied only for policy. Session/Auto/intent omit it and therefore select from all healthy accounts. In multi-account mode, deterministic routing requires the request's existing affinity. Do not add a token map.

Validate success JSON is a record. On error, throw `HTTPError` with a fixed safe message and retain the response for status/error classification. Never read/log the upstream body in the service.

Policy compatibility:

- 2xx -> `{success:true}`;
- 403 -> `{success:false,can_be_enabled:false,error:"This model cannot be enabled. Your organization or subscription may not permit self-service model enablement."}`;
- other failures -> throw the sanitized `HTTPError` rather than constructing a status-text message.

- [ ] **Step 7: Add exact authenticated routes**

Create `src/routes/copilot-control-plane/route.ts`:

```ts
export const copilotControlPlaneRoutes = new Hono()

copilotControlPlaneRoutes.post("/models/session", handleModelSession)
copilotControlPlaneRoutes.post("/models/session/intent", handleIntent)
copilotControlPlaneRoutes.post("/auto", handleAuto)
```

Mount after `apiKeyGuard` and `createAuthMiddleware()`.

Add `modelRoutes.post("/:model/policy", ...)` so both `/models/:model/policy` and `/v1/models/:model/policy` work through existing route mounts.

Route validation:

- model session body may be empty; use inbound `Copilot-Session-Token` for refresh;
- Auto requires non-empty prompt, boolean/default-false `has_image`, and passes optional `tier`, `multi_turn`, and `previous_user_messages` if JSON-compatible;
- intent requires non-empty `Copilot-Session-Token`, non-empty prompt, array of non-empty `available_models`, boolean/default-false `has_image`, and forwards optional current CLI routing fields;
- local errors use OpenAI/Copilot JSON envelope.

- [ ] **Step 8: Add route and multi-account affinity tests**

Assert all routes are behind inference auth, use the same account for identical affinity, may differ for distinct affinity, return no secret in errors, and do not create any storage/map keyed by session token.

- [ ] **Step 9: Run focused tests and verify GREEN**

```powershell
bun test tests/copilot-control-plane.test.ts tests/models-route.test.ts tests/token-pool.test.ts tests/account-router.test.ts tests/integration/middleware.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 4**

```powershell
git add src/services/copilot/control-plane.ts src/routes/copilot-control-plane/route.ts src/lib/token-pool.ts src/lib/account-router.ts src/routes/models/route.ts src/server.ts src/lib/error.ts tests/copilot-control-plane.test.ts tests/token-pool.test.ts tests/models-route.test.ts tests/account-router.test.ts
git commit -m "feat: proxy Copilot control-plane routes"
```

### Task 5: Forward Model-Scoped Session Tokens to Matching Inference Requests

**Files:**
- Create: `src/lib/copilot-session-token.ts`
- Create: `tests/copilot-session-token.test.ts`
- Modify: `src/services/copilot/copilot-client.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `tests/create-chat-completions.test.ts`
- Modify: `tests/create-responses.test.ts`
- Modify: `tests/messages-handler.test.ts`

**Interfaces:**
- Consumes: inbound opaque `Copilot-Session-Token`, final normalized/redirected model, and typed `CopilotHeaderOptions.copilotSessionToken`.
- Produces:

```ts
export interface CopilotSessionTokenClaims {
  availableModels: Array<string>
  selectedModel?: string
}

export function inspectCopilotSessionToken(
  token: string,
): CopilotSessionTokenClaims | undefined

export function sessionTokenMatchesModel(options: {
  finalModel: string
  requestedModel: string
  token: string | undefined
}): boolean
```

- [ ] **Step 1: Write failing token-inspection tests**

```ts
import { expect, test } from "bun:test"

import {
  inspectCopilotSessionToken,
  sessionTokenMatchesModel,
} from "~/lib/copilot-session-token"

const jwt = (payload: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`

test("reads only model-binding hints from an opaque session token", () => {
  const token = jwt({
    selected_model: "gpt-current",
    available_models: ["gpt-current", "claude-current"],
    sub: "must-not-expose",
  })
  expect(inspectCopilotSessionToken(token)).toEqual({
    selectedModel: "gpt-current",
    availableModels: ["gpt-current", "claude-current"],
  })
})

test("treats malformed tokens as unusable", () => {
  expect(inspectCopilotSessionToken("not-a-jwt")).toBeUndefined()
})

test("forwards only when the requested and final models remain allowed", () => {
  const token = jwt({
    selected_model: "gpt-current",
    available_models: ["gpt-current"],
  })
  expect(sessionTokenMatchesModel({
    token,
    requestedModel: "gpt-current",
    finalModel: "gpt-current",
  })).toBe(true)
  expect(sessionTokenMatchesModel({
    token,
    requestedModel: "gpt-current",
    finalModel: "redirected-model",
  })).toBe(false)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/copilot-session-token.test.ts`

Expected: module does not exist.

- [ ] **Step 3: Implement bounded unverified claim inspection**

Rules:

- reject tokens longer than 16 KiB;
- require exactly three JWT segments;
- base64url-decode only the payload segment;
- parse JSON and retain only string `selected_model` plus unique non-empty string `available_models` entries;
- never verify or treat claims as authorization; Copilot verifies the signature and entitlements;
- never log parse failures, token contents, claims other than model IDs, or raw token text.

Matching rules:

- token absent/malformed -> false;
- local model redirect changed `requestedModel` to a different `finalModel` -> false, even if the token happens to list the target;
- if `selected_model` exists, `finalModel` must equal it;
- otherwise `finalModel` must appear in `available_models`;
- aliases are compared after existing model normalization, not fuzzy display-name matching.

- [ ] **Step 4: Forward the token from each public inference route**

At each route boundary, read `c.req.header("copilot-session-token")`. After replacement, normalization, and model redirect are complete, call `sessionTokenMatchesModel()` using the original requested base model and final upstream model. Pass the opaque token in the protocol service's explicit options only on true.

Update service options:

```ts
interface ChatCompletionsRequestOptions {
  // existing fields
  copilotSessionToken?: string
}

interface ResponsesRequestOptions {
  // existing fields
  copilotSessionToken?: string
}

interface CreateAnthropicMessagesOptions {
  // existing fields
  copilotSessionToken?: string
}

createChatCompletions(payload, { copilotSessionToken, ... })
createResponses(payload, { copilotSessionToken, ... })
createAnthropicMessages(payload, { copilotSessionToken, ... })
```

Each service passes it only through typed `CopilotHeaderOptions`. Translation paths inherit the same matched token only when their final model remains the same; a model-changing fallback/redirect drops it.

- [ ] **Step 5: Write failing/passing route tests**

For Chat, Responses, and Messages assert:

- matching selected model -> upstream contains the token;
- mismatched selected model -> absent;
- local redirect -> absent;
- malformed token -> absent and request still follows ordinary upstream auth;
- ordinary logs, LLM error capture, and returned errors contain no token.

Administrator-only LLM Debug may capture the exact upstream header only when it was actually sent, consistent with the raw-debug exception.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
bun test tests/copilot-session-token.test.ts tests/create-chat-completions.test.ts tests/create-responses.test.ts tests/messages-handler.test.ts tests/llm-debug-log.test.ts tests/error.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src/lib/copilot-session-token.ts src/services/copilot/copilot-client.ts src/routes/chat-completions/handler.ts src/routes/responses/handler.ts src/routes/messages/handler.ts tests/copilot-session-token.test.ts tests/create-chat-completions.test.ts tests/create-responses.test.ts tests/messages-handler.test.ts tests/llm-debug-log.test.ts tests/error.test.ts
git commit -m "feat: forward model-scoped Copilot session tokens"
```

### Task 6: Add Bounded Contract Observability

**Files:**
- Create: `src/lib/copilot-contract-observability.ts`
- Create: `tests/copilot-contract-observability.test.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/responses/websocket.ts`
- Modify: `src/services/copilot/responses-contract.ts`
- Modify: `src/services/copilot/messages-contract.ts`

**Interfaces:**
- Consumes: route decisions, normalization-class arrays, canonical beta string, continuation outcome, and safe response metadata.
- Produces:

```ts
export type CopilotContractEvent =
  | {
      kind: "endpoint_route"
      source: ClientDialect
      target: CopilotInferenceEndpoint
      translated: boolean
      reason: EndpointRouteDecision["reason"]
    }
  | {
      kind: "request_normalization"
      protocol: ClientDialect
      classes: Array<string>
    }
  | {
      kind: "messages_beta"
      count: number
    }
  | {
      kind: "websocket_continuation"
      outcome: "new_thread" | "rehydrated" | "not_found"
    }
  | {
      kind: "response_metadata"
      headerCount: number
      quotaSnapshotCount: number
    }

export function recordCopilotContractEvent(
  event: CopilotContractEvent,
): void
```

- [ ] **Step 1: Write failing privacy and event-shape tests**

```ts
test("records only bounded route and normalization metadata", () => {
  recordCopilotContractEvent({
    kind: "endpoint_route",
    source: "messages",
    target: "/v1/messages",
    translated: false,
    reason: "native",
  })
  recordCopilotContractEvent({
    kind: "request_normalization",
    protocol: "responses",
    classes: ["empty_tool_controls", "gpt56_sampling"],
  })
  expect(recordedBehaviors).toMatchObject([
    { kind: "endpoint_route" },
    { kind: "request_normalization" },
  ])
})

test("never records beta values ids prompts or bodies", () => {
  recordCopilotContractEvent({
    kind: "messages_beta",
    count: 2,
  })
  const output = JSON.stringify(recordedBehaviors)
  expect(output).not.toContain("adaptive-thinking")
  expect(output).not.toContain("session-secret")
  expect(output).not.toContain("prompt")
})
```

Add a compile-time exhaustive switch test or `assertNever` in the module so new event variants require an explicit bounded mapping.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/copilot-contract-observability.test.ts`

Expected: module does not exist.

- [ ] **Step 3: Implement the bounded diagnostic adapter**

Map each event to one `consola.debug("[copilot-contract]", safeData)` entry, one `Sentry.addBreadcrumb({category:"copilot-api.contract",data:safeData})`, and bounded active-span attributes. Use fixed messages and scalar/enum/count data only. Example:

```ts
const safeData = {
  kind: event.kind,
  source: event.source,
  target: event.target,
  translated: event.translated,
  reason: event.reason,
}
consola.debug("[copilot-contract]", safeData)
Sentry.addBreadcrumb({
  category: "copilot-api.contract",
  level: "info",
  message: "Copilot endpoint route selected",
  data: safeData,
})
```

For normalization, sort/deduplicate known class names and join them into one comma-separated string capped at 256 characters. Do not accept arbitrary user-provided class strings; the preparation modules return internal literal class names. Set active-span attributes under `copilot_api.contract.*` only for these bounded values/counts.

Keep using existing `recordNonDefaultBehavior()` separately for actual endpoint translations, model redirects, payload recovery, or compatibility rewrites. A native route decision is ordinary contract telemetry and must not appear as `NON-DEFAULT` in user-visible request logs.

- [ ] **Step 4: Emit events at authoritative boundaries**

- route handlers emit one endpoint route event after selection and before dispatch;
- Responses/Chat/Messages preparation emits normalization events only when a behavior changed the wire request;
- Messages boundary emits beta identifier count after canonicalization, never the value;
- WebSocket continuation emits new-thread/rehydrated/not-found;
- safe response metadata emits counts only after the final selected attempt.

Do not duplicate existing payload-recovery/account-routing telemetry.

- [ ] **Step 5: Run focused privacy and route tests**

```powershell
bun test tests/copilot-contract-observability.test.ts tests/chat-endpoint-routing.test.ts tests/responses-endpoint-routing.test.ts tests/messages-endpoint-routing.test.ts tests/responses-websocket.test.ts tests/request-id.test.ts tests/attachments-logging.test.ts tests/sentry.test.ts
```

Expected: PASS with no secret/raw-value matches.

- [ ] **Step 6: Commit Task 6**

```powershell
git add src/lib/copilot-contract-observability.ts src/routes/chat-completions/handler.ts src/routes/responses/handler.ts src/routes/messages/handler.ts src/routes/responses/websocket.ts src/services/copilot/responses-contract.ts src/services/copilot/messages-contract.ts tests/copilot-contract-observability.test.ts
git commit -m "feat: add bounded Copilot contract diagnostics"
```

### Task 7: Write the Durable Compatibility Report and Documentation Tests

**Files:**
- Create: `docs/copilot-api-compatibility.md`
- Create: `tests/copilot-compatibility-doc.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed implementation behavior and approved design.
- Produces: operator/consumer documentation with no private-source leakage.

- [ ] **Step 1: Write the failing documentation contract test**

```ts
import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const path = new URL("../docs/copilot-api-compatibility.md", import.meta.url)

test("documents the reviewed Copilot compatibility contract", async () => {
  const text = await readFile(path, "utf8")
  for (const required of [
    "2026-08-01",
    "supported_endpoints",
    "/chat/completions",
    "/responses",
    "/v1/messages",
    "/v1/messages/count_tokens",
    "previous_response_not_found",
    "Hash-only account affinity",
    "Intentional gateway extensions",
    "Last audited: 2026-08-17",
  ]) {
    expect(text).toContain(required)
  }
})

test("contains no private source paths or credentials", async () => {
  const text = await readFile(path, "utf8")
  expect(text).not.toMatch(/[A-Z]:\\Projects\\/)
  expect(text).not.toContain("github_pat_")
  expect(text).not.toContain("gho_")
  expect(text).not.toContain("10.0.0.")
  expect(text).not.toContain("internal-host.tld")
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test tests/copilot-compatibility-doc.test.ts`

Expected: FAIL because the document does not exist.

- [ ] **Step 3: Write `docs/copilot-api-compatibility.md`**

Use these exact sections:

1. Contract version and source precedence.
2. Public route and alias table.
3. Model discovery and endpoint routing.
4. Responses accepted/normalized/rejected fields.
5. Messages body/header/count-tokens behavior.
6. Chat compatibility behavior.
7. Streaming and WebSocket termination/continuation semantics.
8. Multi-account and session-token constraints.
9. Intentional gateway extensions.
10. Error privacy and LLM Debug exception.
11. Verification matrix and last-audited date.
12. Residual feature-flag/account/provider limitations.

State explicitly that `ws:/responses` in the gateway model list describes the gateway's local compatibility transport and does not promise direct upstream WebSocket use.

- [ ] **Step 4: Link the report from README**

Add one concise link in the API compatibility section. Do not duplicate the full report in README.

- [ ] **Step 5: Run docs tests and verify GREEN**

```powershell
bun test tests/copilot-compatibility-doc.test.ts tests/local-limit-policy.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```powershell
git add -f docs/copilot-api-compatibility.md README.md tests/copilot-compatibility-doc.test.ts
git commit -m "docs: document Copilot API compatibility"
```

### Task 8: Run the Full Automated Verification Matrix

**Files:**
- Verify all changed files; modify only when a verification failure proves a defect.

**Interfaces:**
- Consumes: all implementation plans and the compatibility document.
- Produces: fresh evidence for every completion claim.

- [ ] **Step 1: Run every focused contract suite together**

```powershell
bun test tests/copilot-contract.test.ts tests/copilot-request-context.test.ts tests/endpoint-routing.test.ts tests/responses-contract.test.ts tests/chat-contract.test.ts tests/translation-fidelity.test.ts tests/messages-contract.test.ts tests/messages-endpoint-routing.test.ts tests/count-anthropic-tokens.test.ts tests/responses-websocket-protocol.test.ts tests/copilot-control-plane.test.ts tests/copilot-compatibility-doc.test.ts
```

Expected: all focused contract tests pass, 0 fail.

- [ ] **Step 2: Run every affected legacy regression suite**

```powershell
bun test tests/copilot-client.test.ts tests/request-id.test.ts tests/models-route.test.ts tests/model-resolver.test.ts tests/routing-affinity.test.ts tests/account-router.test.ts tests/token-pool.test.ts tests/create-responses.test.ts tests/create-responses-payload-recovery.test.ts tests/responses-payload-recovery.test.ts tests/responses-request-normalization.test.ts tests/responses-handler.test.ts tests/responses-translation.test.ts tests/responses-stream-translation.test.ts tests/responses-websocket.test.ts tests/create-chat-completions.test.ts tests/chat-completions-responses-fallback.test.ts tests/create-anthropic-messages.test.ts tests/messages-handler.test.ts tests/messages-responses-handler.test.ts tests/messages-stream-lifecycle.test.ts tests/anthropic-request.test.ts tests/anthropic-response.test.ts tests/count-tokens-handler.test.ts tests/google-ai-handler.test.ts tests/google-request-translation.test.ts tests/google-response-translation.test.ts tests/web-search.test.ts tests/web-search-route.test.ts tests/error.test.ts tests/sentry.test.ts tests/llm-debug-log.test.ts
```

Expected: pass with no new skips.

- [ ] **Step 3: Run the complete repository suite**

```powershell
bun test
```

Expected: 0 failures. Record the exact pass/skip count in the final report; do not reuse the pre-change baseline count.

- [ ] **Step 4: Run full static verification**

```powershell
bun run lint:all
bun run typecheck
bun run build
git diff --check
```

Expected: all commands exit 0. Record existing warnings separately and prove no new warnings were introduced.

- [ ] **Step 5: Run pinned Bun media verification when applicable**

If any media/attachment/payload-recovery file changed, run the existing pinned Bun 1.4.0 verification environment for:

```powershell
bun test tests/responses-webp-normalization.test.ts tests/responses-payload-recovery.test.ts tests/create-responses-payload-recovery.test.ts tests/vision-attachments.test.ts
```

Expected: real WebP transcode, PNG re-encoding, incident-shaped recovery, and vision attachment tests pass without platform skips.

- [ ] **Step 6: Scan the diff for secrets and raw upstream leakage**

```powershell
git diff --name-only HEAD~20..HEAD
rg -n -i "authorization: bearer|copilot-session-token.*(log|error)|github_pat_|gho_|signed url|response body:" src tests docs
```

Review each match. Expected: no newly introduced credential literals, session-token logging, raw upstream-body logging, private filesystem paths in public docs, or unsafe client-error interpolation.

### Task 9: Run the Targeted Authenticated Live Matrix

**Files:**
- Create: `tests/integration/responses-cache-control.test.ts`
- Create: `tests/integration/responses-websocket.test.ts`
- Modify: existing integration fixtures only when a shared helper is required.

**Interfaces:**
- Consumes: current stored/`GH_TOKEN` credentials and live Copilot model catalog.
- Produces: current-service compatibility evidence.

- [ ] **Step 1: Discover current live capabilities**

```powershell
bun test tests/integration/models.test.ts
```

Expected: live discovery succeeds under `2026-08-01`. Record available models by endpoint only in transient test output; do not commit a static model list.

- [ ] **Step 2: Exercise each available native dialect**

```powershell
bun test tests/integration/chat-completions.test.ts tests/integration/responses.test.ts tests/integration/messages.test.ts
```

Expected: one non-streaming and one streaming request succeed through every currently available dialect covered by the integration fixtures.

- [ ] **Step 3: Exercise tools and count-tokens**

```powershell
bun test tests/integration/tool-calling.test.ts tests/integration/count-tokens.test.ts
```

Expected: available function-tool flows and native count-tokens pass.

- [ ] **Step 4: Add focused live cache-control probes if no integration fixture covers them**

Create durable credential-gated integration tests only when needed:

```ts
test("accepts Responses explicit cache controls", async () => {
  const model = firstAvailableModel("/responses")
  const response = await postJSON("/v1/responses", {
    model,
    input: [{
      role: "user",
      content: [{
        type: "input_text",
        text: longStablePrefix,
        prompt_cache_breakpoint: { mode: "explicit" },
      }, { type: "input_text", text: "Reply with OK." }],
    }],
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    max_output_tokens: 32,
  })
  expect(response.status).toBe(200)
})

test("accepts native Messages 5m cache control", async () => {
  const model = firstAvailableModel("/v1/messages")
  const response = await postJSON("/v1/messages", {
    model,
    max_tokens: 32,
    cache_control: { type: "ephemeral", ttl: "5m" },
    messages: [{ role: "user", content: "Reply with OK." }],
  })
  expect(response.status).toBe(200)
})
```

Do not assert that a cache hit occurs.

- [ ] **Step 5: Exercise a two-turn local WebSocket continuation**

Run or add a credential-gated WebSocket integration fixture that sends a first turn, reads its completed response ID, sends a delta continuation, observes completion, then sends one stale ID and receives `previous_response_not_found` without closing the socket.

- [ ] **Step 6: Probe local deterministic rejections without upstream calls**

Run focused route tests with fetch counters for `store:true`, `background:true`, HTTP `previous_response_id`, caller `service_tier`, blocked tool types, invalid context-management types, and lossy endpoint translations.

Expected: safe local 400 and zero upstream calls.

- [ ] **Step 7: Leave unavailable feature branches source/fixture verified**

Do not spend quota probing 1h Messages caching, modern computer/image tools, provider pinning, Auto, or multi-agent unless the authenticated catalog/account already advertises or uses them. List those as feature-flag/account-dependent verification in the final report.

### Task 10: Run Independent Reviews and Fix Findings

**Files:**
- Review all commits from the first implementation-plan base through current HEAD.

**Interfaces:**
- Consumes: approved spec, four plans, full diff, and fresh verification output.
- Produces: no unresolved Critical or Important findings.

- [ ] **Step 1: Record review SHAs**

```powershell
$base = git rev-parse f5e744c
$head = git rev-parse HEAD
Write-Output "BASE=$base"
Write-Output "HEAD=$head"
```

- [ ] **Step 2: Request a spec-compliance review**

Use `superpowers:requesting-code-review` with a clean-context reviewer and provide:

- description: Copilot API contract parity across contract/models/routing, Responses/Chat, Messages/count-tokens, WebSocket/control-plane/docs;
- requirements: the approved design and all four implementation plans;
- base/head SHAs; and
- instruction to identify missing requirements, unintended scope, and unsafe assumptions.

Expected: reviewer returns findings categorized Critical/Important/Minor.

- [ ] **Step 3: Fix all valid Critical and Important spec findings with TDD**

For each behavior defect:

1. add a failing regression;
2. run it and record the expected failure;
3. implement the minimal fix;
4. rerun focused tests; and
5. commit the fix with a natural title.

Push back only with concrete code/test/backend evidence.

- [ ] **Step 4: Request a code-quality/security review**

Use a second clean-context reviewer over the updated SHAs. Ask specifically about:

- arbitrary header forwarding;
- session-token/account-affinity leakage;
- raw error/body/log exposure;
- retries after output;
- stale allowlists or field loss;
- WebSocket concurrency/isolation;
- model endpoint mismatch;
- request mutation; and
- regression of existing local extensions.

- [ ] **Step 5: Fix all valid Critical and Important findings**

Use the same test-first process. Minor findings may remain only when explicitly documented in the final report with rationale.

- [ ] **Step 6: Re-run the full verification matrix after review fixes**

Repeat Tasks 8 and 9 commands from fresh HEAD. Previous outputs do not count after a code change.

### Task 11: Produce the Final Evidence Report and Integration-Ready State

**Files:**
- Modify `docs/copilot-api-compatibility.md` only if final verified behavior differs from its current wording.

**Interfaces:**
- Consumes: final diff, test outputs, live probes, reviewer results, and git state.
- Produces: an evidence-backed handoff ready for branch/PR workflow.

- [ ] **Step 1: Check every acceptance criterion against code/tests**

Create a temporary checklist from the design's Acceptance Criteria and map each item to:

- implementation file/function;
- focused regression test;
- live probe or reason live probing is feature-gated; and
- any intentional local difference.

If any criterion lacks evidence, add the missing test/fix before proceeding.

- [ ] **Step 2: Verify final repository state**

```powershell
git status --short
git diff --check
git log --oneline --decorate -25
```

Expected: clean worktree and all implementation/review commits present.

- [ ] **Step 3: Record exact final verification evidence**

Capture:

- full Bun pass/skip/fail count;
- lint errors/warnings;
- typecheck/build exit status;
- pinned Bun media result when applicable;
- live route matrix results;
- reviewer outcome; and
- current HEAD SHA.

- [ ] **Step 4: Report residual limitations precisely**

List only verified residuals, such as:

- upstream/account feature-flag availability;
- no arbitrary external `previous_response_id` continuation on the local no-storage WebSocket;
- no direct upstream WebSocket/multiplexing migration in this change;
- no HMAC/internal integration support; and
- no guarantee of control-plane token continuity without an affinity key in multi-account mode.

- [ ] **Step 5: Prepare branch/PR handoff**

The Codex worktree is detached. Use the app's native Create Branch action or create a `codex/` branch when the environment permits. Suggested natural title:

```text
Align proxy behavior with current Copilot API contracts
```

Do not create, push, or merge a pull request unless the user explicitly requests publication after reviewing the completed implementation.
