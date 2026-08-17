# Copilot Contract, Model Discovery, and Endpoint Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one current Copilot API contract, preserve complete upstream model metadata, and provide a pure endpoint-support router that every protocol handler can use without changing client-visible protocol behavior yet.

**Architecture:** A new contract module owns API version, integration identity, safe upstream headers, and typed request attribution. Request attribution is captured once in AsyncLocalStorage and consumed by the existing account-aware transport. Model discovery clones upstream records before adding aliases and gateway annotations. A pure endpoint-routing module interprets `supported_endpoints` and returns explicit native, translated, or unsupported decisions for later protocol plans.

**Tech Stack:** Bun 1.3.x, strict TypeScript/ESNext, Hono, AsyncLocalStorage, Bun test, existing account router and Copilot transport.

**Spec:** `docs/superpowers/specs/2026-08-17-copilot-api-contract-parity-design.md`

## Global Constraints

- Send `X-GitHub-Api-Version: 2026-08-01` on every upstream Copilot request.
- Default `COPILOT_INTEGRATION_ID` to `vscode-chat`; never impersonate `copilot-developer-cli` implicitly.
- Preserve deterministic hash-only account affinity and deterministic upstream conversation identity.
- Never forward arbitrary inbound headers; only typed, length-bounded, CR/LF-free values may reach Copilot.
- Preserve complete upstream model objects before adding aliases, virtual rows, and local annotations.
- Treat omitted `supported_endpoints` as `/chat/completions` only.
- Do not expose credentials, session tokens, raw upstream bodies, cache keys, safety identifiers, or private headers in ordinary logs/Sentry/client errors.
- Use failing-then-passing Bun tests for every behavior change.
- Keep unrelated user changes untouched.

---

## File Map

- Create `src/services/copilot/copilot-contract.ts`: current API version, integration ID resolution, typed attribution fields, header-value sanitization, and safe response-header collection.
- Create `src/lib/copilot-request-context.ts`: request-scoped attribution storage and inbound-header resolution.
- Create `src/lib/endpoint-routing.ts`: pure endpoint support and route-decision primitives.
- Create `tests/copilot-contract.test.ts`: version, configuration, header, and safe response metadata tests.
- Create `tests/copilot-request-context.test.ts`: inbound attribution validation and AsyncLocalStorage isolation tests.
- Create `tests/endpoint-routing.test.ts`: model endpoint interpretation and explicit route-decision tests.
- Modify `src/lib/state.ts`: store the resolved integration ID.
- Modify `src/start.ts`: initialize integration identity from the environment.
- Modify `.env.schema` and `README.md`: document `COPILOT_INTEGRATION_ID`.
- Modify `src/server.ts`: install typed request attribution beside routing affinity.
- Modify `src/lib/request-session.ts`: store safe successful-upstream response headers.
- Modify `src/services/copilot/copilot-client.ts`: use the shared contract and capture final safe response metadata.
- Modify `src/services/copilot/get-models.ts`: parse the cumulative 2026-08 model shape without dropping unknown optional fields.
- Modify `src/routes/models/route.ts`: preserve upstream records and serve single-model discovery.
- Modify focused contract, request-ID, model, and integration tests.

### Task 1: Pin the Current CAPI Contract and Configurable Integration ID

**Files:**
- Create: `src/services/copilot/copilot-contract.ts`
- Create: `tests/copilot-contract.test.ts`
- Modify: `src/lib/state.ts:5-32`
- Modify: `src/start.ts:48-61,454-505`
- Modify: `src/services/copilot/copilot-client.ts:46-131`
- Modify: `src/services/copilot/get-models.ts:1-16`
- Modify: `.env.schema`
- Modify: `README.md`
- Test: `tests/copilot-client.test.ts`

**Interfaces:**
- Consumes: existing `state`, `copilotHeaders()`, `copilotFetch()`, and `getModels()`.
- Produces:

```ts
export const COPILOT_API_VERSION = "2026-08-01"
export const DEFAULT_COPILOT_INTEGRATION_ID = "vscode-chat"

export function resolveCopilotIntegrationId(
  value: string | undefined,
): string

export function sanitizeCopilotHeaderValue(
  value: string | null | undefined,
  maxLength?: number,
): string | undefined
```

- Adds `copilotIntegrationId: string` to `State`.

- [ ] **Step 1: Write the failing contract tests**

Create `tests/copilot-contract.test.ts`:

```ts
import { expect, test } from "bun:test"

import {
  COPILOT_API_VERSION,
  DEFAULT_COPILOT_INTEGRATION_ID,
  resolveCopilotIntegrationId,
} from "~/services/copilot/copilot-contract"

test("pins the reviewed cumulative Copilot API contract", () => {
  expect(COPILOT_API_VERSION).toBe("2026-08-01")
})

test("keeps the compatibility integration default", () => {
  expect(resolveCopilotIntegrationId(undefined)).toBe(
    DEFAULT_COPILOT_INTEGRATION_ID,
  )
  expect(resolveCopilotIntegrationId("   ")).toBe(
    DEFAULT_COPILOT_INTEGRATION_ID,
  )
})

test("accepts a configured integration identifier", () => {
  expect(resolveCopilotIntegrationId("  assigned-integration  ")).toBe(
    "assigned-integration",
  )
})

test("rejects integration identifiers that can inject a header", () => {
  expect(() => resolveCopilotIntegrationId("good\r\nX-Evil: 1")).toThrow(
    "COPILOT_INTEGRATION_ID",
  )
})
```

Extend `tests/copilot-client.test.ts`:

```ts
test.each([
  ["individual", "https://api.githubcopilot.com"],
  ["business", "https://api.business.githubcopilot.com"],
  ["enterprise", "https://api.enterprise.githubcopilot.com"],
] as const)("uses the reviewed %s Copilot host", (accountType, expected) => {
  state.accountType = accountType
  expect(copilotBaseUrl()).toBe(expected)
})

test("uses one current API version and the configured integration id", () => {
  state.copilotToken = "token"
  state.copilotIntegrationId = "assigned-integration"
  const headers = copilotHeaders()
  expect(headers["X-GitHub-Api-Version"]).toBe("2026-08-01")
  expect(headers["Copilot-Integration-Id"]).toBe("assigned-integration")
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
bun test tests/copilot-contract.test.ts tests/copilot-client.test.ts -t "contract|integration id|API version"
```

Expected: FAIL because `copilot-contract.ts` and `state.copilotIntegrationId` do not exist, and existing headers still use older version constants.

- [ ] **Step 3: Implement the contract constants and resolver**

Create `src/services/copilot/copilot-contract.ts`:

```ts
export const COPILOT_API_VERSION = "2026-08-01"
export const DEFAULT_COPILOT_INTEGRATION_ID = "vscode-chat"

const MAX_INTEGRATION_ID_LENGTH = 128

export function sanitizeCopilotHeaderValue(
  value: string | null | undefined,
  maxLength = 1024,
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > maxLength || /[\0\r\n]/.test(trimmed)) {
    return undefined
  }
  return trimmed
}

export function resolveCopilotIntegrationId(
  value: string | undefined,
): string {
  const raw = value?.trim()
  if (!raw) return DEFAULT_COPILOT_INTEGRATION_ID
  const sanitized = sanitizeCopilotHeaderValue(
    raw,
    MAX_INTEGRATION_ID_LENGTH,
  )
  if (!sanitized) {
    throw new Error(
      "COPILOT_INTEGRATION_ID must be 128 characters or fewer and contain no control characters",
    )
  }
  return sanitized
}
```

Modify `src/lib/state.ts`:

```ts
import { DEFAULT_COPILOT_INTEGRATION_ID } from "~/services/copilot/copilot-contract"

export interface State {
  // existing fields
  copilotIntegrationId: string
}

export const state: State = {
  // existing defaults
  copilotIntegrationId: DEFAULT_COPILOT_INTEGRATION_ID,
}
```

Initialize it in `runServer()` before token/model setup:

```ts
state.copilotIntegrationId = resolveCopilotIntegrationId(
  process.env.COPILOT_INTEGRATION_ID,
)
```

Replace both existing API-version constants and the fixed integration ID in `copilot-client.ts` with imports from `copilot-contract.ts`. Make `getModels()` rely on `copilotHeaders()` without overriding the version.

- [ ] **Step 4: Document the environment option**

Add to `.env.schema`:

```dotenv
# Copilot integration identifier assigned to this deployment.
# Defaults to vscode-chat for backwards-compatible entitlement behavior.
COPILOT_INTEGRATION_ID=
```

Add the same option to the README environment-variable table. State that operators should use an assigned integration ID when available and should not copy a first-party client ID merely to imitate that client.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
bun test tests/copilot-contract.test.ts tests/copilot-client.test.ts tests/integration/models.test.ts
```

Expected: PASS. Captured `/models` and inference requests use `2026-08-01` and the configured/default integration ID.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/services/copilot/copilot-contract.ts src/services/copilot/copilot-client.ts src/services/copilot/get-models.ts src/lib/state.ts src/start.ts .env.schema README.md tests/copilot-contract.test.ts tests/copilot-client.test.ts
git commit -m "fix: pin the current Copilot API contract"
```

### Task 2: Capture Typed Request Attribution Without Arbitrary Header Passthrough

**Files:**
- Create: `src/lib/copilot-request-context.ts`
- Create: `tests/copilot-request-context.test.ts`
- Modify: `src/server.ts:87-122`
- Modify: `src/services/copilot/copilot-contract.ts`
- Modify: `src/services/copilot/copilot-client.ts:84-131`
- Test: `tests/copilot-client.test.ts`
- Test: `tests/routing-affinity.test.ts`

**Interfaces:**
- Consumes: `runWithRoutingAffinity()`, `getClientSessionId()`, and the deterministic upstream UUID already produced by `copilotHeaders()`.
- Produces:

```ts
export interface CopilotRequestAttribution {
  agentTaskId?: string
  clientExperimentAssignment?: string
  clientMachineId?: string
  harnessId?: string
  interactionType?: string
  openaiIntent?: string
  parentAgentId?: string
  repositoryHost?: string
  repositoryNwo?: string
  subsystemId?: string
}

export function resolveCopilotRequestAttribution(
  headers: Headers,
): CopilotRequestAttribution

export function runWithCopilotRequestAttribution<T>(
  attribution: CopilotRequestAttribution,
  callback: () => T,
): T

export function getCopilotRequestAttribution():
  | CopilotRequestAttribution
  | undefined

export function mergeCopilotRequestAttribution(
  base: CopilotRequestAttribution | undefined,
  override: CopilotRequestAttribution | undefined,
): CopilotRequestAttribution
```

`CopilotHeaderOptions` gains:

```ts
attribution?: CopilotRequestAttribution
anthropicBeta?: string
copilotSessionToken?: string
modelProviderPreference?: string
```

- [ ] **Step 1: Write failing context and sanitization tests**

Create `tests/copilot-request-context.test.ts`:

```ts
import { expect, test } from "bun:test"

import {
  getCopilotRequestAttribution,
  resolveCopilotRequestAttribution,
  runWithCopilotRequestAttribution,
} from "~/lib/copilot-request-context"
import { sanitizeCopilotHeaderValue } from "~/services/copilot/copilot-contract"

test("resolves only the reviewed attribution headers", () => {
  const headers = new Headers({
    "x-agent-task-id": "task-123",
    "x-parent-agent-id": "parent-456",
    "x-client-machine-id": "machine-abc",
    "x-github-repository-nwo": "owner/repo",
    "x-github-repository-host": "github.example",
    "copilot-harness-id": "copilot",
    "copilot-subsystem-id": "cli",
    "openai-intent": "conversation-agent",
    "x-copilot-client-exp-assignment-context": "client_flight:1;",
    "x-unreviewed-header": "must-not-pass",
  })
  expect(resolveCopilotRequestAttribution(headers)).toEqual({
    agentTaskId: "task-123",
    parentAgentId: "parent-456",
    clientMachineId: "machine-abc",
    repositoryNwo: "owner/repo",
    repositoryHost: "github.example",
    harnessId: "copilot",
    subsystemId: "cli",
    openaiIntent: "conversation-agent",
    clientExperimentAssignment: "client_flight:1;",
  })
})

test("drops blank oversized and control-character attribution values", () => {
  const headers = new Headers()
  headers.set("x-agent-task-id", " ")
  headers.set("x-parent-agent-id", "x".repeat(1025))
  expect(resolveCopilotRequestAttribution(headers)).toEqual({})
  expect(sanitizeCopilotHeaderValue("machine\ninvalid")).toBeUndefined()
})

test("isolates overlapping request attribution scopes", async () => {
  const observed = await Promise.all([
    runWithCopilotRequestAttribution({ agentTaskId: "one" }, async () => {
      await Promise.resolve()
      return getCopilotRequestAttribution()?.agentTaskId
    }),
    runWithCopilotRequestAttribution({ agentTaskId: "two" }, async () => {
      await Promise.resolve()
      return getCopilotRequestAttribution()?.agentTaskId
    }),
  ])
  expect(observed).toEqual(["one", "two"])
})
```

Extend `tests/copilot-client.test.ts`:

```ts
test("keeps conversation identity stable while preserving task attribution", () => {
  state.copilotToken = "token"
  const headers = runWithRoutingAffinity(
    { key: "conversation", source: "codex_session" },
    () =>
      runWithCopilotRequestAttribution(
        { agentTaskId: "task-123", parentAgentId: "parent-456" },
        () => copilotHeaders(),
      ),
  )
  expect(headers["X-Agent-Task-Id"]).toBe("task-123")
  expect(headers["X-Parent-Agent-Id"]).toBe("parent-456")
  expect(headers["X-Interaction-Id"]).toBe(
    headers["X-Client-Session-Id"],
  )
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
bun test tests/copilot-request-context.test.ts tests/copilot-client.test.ts -t "attribution|task"
```

Expected: FAIL because the context module and expanded header options do not exist.

- [ ] **Step 3: Implement request-scoped attribution**

Create `src/lib/copilot-request-context.ts` with one `AsyncLocalStorage<CopilotRequestAttribution>` and the shared sanitizer imported from `copilot-contract.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks"

export interface CopilotRequestAttribution {
  agentTaskId?: string
  clientExperimentAssignment?: string
  clientMachineId?: string
  harnessId?: string
  interactionType?: string
  openaiIntent?: string
  parentAgentId?: string
  repositoryHost?: string
  repositoryNwo?: string
  subsystemId?: string
}

const storage = new AsyncLocalStorage<CopilotRequestAttribution>()
```

Map only the exact reviewed headers from the test. Include `x-interaction-type`; do not read raw interaction/client-session IDs here because routing affinity already normalizes those identities.

Wrap the existing request-ID/routing-affinity middleware callback in `runWithCopilotRequestAttribution(resolveCopilotRequestAttribution(c.req.raw.headers), ...)`.

- [ ] **Step 4: Expand `copilotHeaders()` without changing stable affinity**

In `copilot-client.ts`:

```ts
const attribution = mergeCopilotRequestAttribution(
  getCopilotRequestAttribution(),
  options?.attribution,
)
const agentTaskId = attribution.agentTaskId ?? upstreamSessionId

const headers: Record<string, string> = {
  // existing required headers
  "X-Interaction-Id": upstreamSessionId,
  "X-Client-Session-Id": upstreamSessionId,
  "X-Agent-Task-Id": agentTaskId,
  "X-Interaction-Type":
    attribution.interactionType
    ?? (initiator === "user" ? "conversation-user" : "conversation-agent"),
}
```

Conditionally add the remaining attribution fields. Add `Anthropic-Beta`, `X-Model-Provider-Preference`, and `Copilot-Session-Token` only from explicit typed options. Reject CR/LF or overlength option values through the same sanitizer exported by `copilot-contract.ts`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
bun test tests/copilot-request-context.test.ts tests/copilot-client.test.ts tests/routing-affinity.test.ts
```

Expected: PASS. Existing deterministic session-header tests remain green; task and parent attribution are independent.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/lib/copilot-request-context.ts src/server.ts src/services/copilot/copilot-contract.ts src/services/copilot/copilot-client.ts tests/copilot-request-context.test.ts tests/copilot-client.test.ts tests/routing-affinity.test.ts
git commit -m "feat: preserve typed Copilot request attribution"
```

### Task 3: Preserve Safe Final-Upstream Response Metadata

**Files:**
- Modify: `src/services/copilot/copilot-contract.ts`
- Modify: `src/lib/request-session.ts:12-88`
- Modify: `src/services/copilot/copilot-client.ts:134-175,543-598`
- Modify: `src/server.ts:102-122`
- Test: `tests/copilot-contract.test.ts`
- Test: `tests/request-id.test.ts`

**Interfaces:**
- Consumes: final `Response` selected by `copilotFetch()` after retry/refresh/failover classification, whether success or terminal error.
- Produces:

```ts
export function collectSafeCopilotResponseHeaders(
  headers: Headers,
): Record<string, string>

export const copilotResponseHeadersStorage: AsyncLocalStorage<
  Record<string, string>
>

export function clearCopilotResponseHeaders(): void
export function getCopilotResponseHeaders(): Record<string, string>
export function setCopilotResponseHeader(name: string, value: string): void
```

Keep compatibility aliases `getQuotaHeaders()`, `setQuotaHeader()`, and `clearQuotaHeaders()` until all existing callers/tests are migrated.

- [ ] **Step 1: Write failing allowlist tests**

Add to `tests/copilot-contract.test.ts`:

```ts
test("collects only safe Copilot response metadata", () => {
  const headers = new Headers({
    "x-quota-snapshot-premium_interactions": "ent=100&rem=50",
    "retry-after": "Sun, 17 Aug 2026 12:00:00 GMT",
    "x-copilot-api-exp-assignment-context": "capi_flight:1;",
    "x-copilot-service-request-id": "service-123",
    "x-github-request-id": "github-456",
    "x-github-copilot-request-te": "false",
    "x-usage-ratelimit-remaining": "42",
    "set-cookie": "secret=1",
    authorization: "Bearer secret",
    "x-provider-deployment": "private-name",
  })
  expect(collectSafeCopilotResponseHeaders(headers)).toEqual({
    "retry-after": "Sun, 17 Aug 2026 12:00:00 GMT",
    "x-copilot-api-exp-assignment-context": "capi_flight:1;",
    "x-copilot-service-request-id": "service-123",
    "x-github-copilot-request-te": "false",
    "x-github-request-id": "github-456",
    "x-quota-snapshot-premium_interactions": "ent=100&rem=50",
    "x-usage-ratelimit-remaining": "42",
  })
})
```

Extend `tests/request-id.test.ts` with queued retry responses:

```ts
test("publishes safe metadata from only the final returned attempt", async () => {
  queuedResponses.push(
    new Response("retry", {
      status: 503,
      headers: { "x-copilot-service-request-id": "failed-attempt" },
    }),
    createChatCompletionResponse(200, {
      "x-copilot-service-request-id": "successful-attempt",
      "x-copilot-api-exp-assignment-context": "flight:1;",
    }),
  )
  const response = await postChatRequest()
  expect(response.headers.get("x-copilot-service-request-id")).toBe(
    "successful-attempt",
  )
  expect(response.headers.get("x-copilot-api-exp-assignment-context")).toBe(
    "flight:1;",
  )
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
bun test tests/copilot-contract.test.ts tests/request-id.test.ts -t "response metadata|final returned attempt"
```

Expected: FAIL because only quota headers are currently stored and returned.

- [ ] **Step 3: Implement the safe response-header collector**

In `copilot-contract.ts`, accept exact names plus prefixes:

```ts
const SAFE_RESPONSE_HEADERS = new Set([
  "retry-after",
  "x-copilot-api-exp-assignment-context",
  "x-copilot-service-request-id",
  "x-github-copilot-request-te",
  "x-github-request-id",
])
const SAFE_RESPONSE_PREFIXES = [
  "x-quota-snapshot-",
  "x-usage-ratelimit-",
]
```

Ignore values containing CR/LF/NUL or longer than 8 KiB. Return lowercase keys so HTTP and WebSocket consumers use one canonical representation.

- [ ] **Step 4: Capture metadata only when `copilotFetch()` returns**

Replace the quota-only recorder with:

```ts
function recordFinalResponseHeaders(response: Response): void {
  clearCopilotResponseHeaders()
  for (const [name, value] of Object.entries(
    collectSafeCopilotResponseHeaders(response.headers),
  )) {
    setCopilotResponseHeader(name, value)
  }
}
```

Call it only on the response selected for return to the route, including a non-retryable or retry-exhausted error response so `Retry-After`, quota, and request IDs remain available to the client. Clear storage before each logical routed call and before retrying a failed attempt so superseded-attempt metadata cannot leak.

Update the server middleware to append `getCopilotResponseHeaders()` after the handler completes. Keep the gateway's own `x-request-id` authoritative.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
bun test tests/copilot-contract.test.ts tests/request-id.test.ts tests/copilot-client.test.ts
```

Expected: PASS. Existing quota-header tests still pass through compatibility aliases.

- [ ] **Step 6: Commit Task 3**

```powershell
git add src/services/copilot/copilot-contract.ts src/lib/request-session.ts src/services/copilot/copilot-client.ts src/server.ts tests/copilot-contract.test.ts tests/request-id.test.ts tests/copilot-client.test.ts
git commit -m "feat: preserve safe Copilot response metadata"
```

### Task 4: Preserve Complete Upstream Model Records and Add Single-Model Discovery

**Files:**
- Modify: `src/services/copilot/get-models.ts:41-125`
- Modify: `src/routes/models/route.ts:18-366`
- Modify: `tests/models-route.test.ts`
- Modify: `tests/integration/models.test.ts`

**Interfaces:**
- Consumes: `state.models`, custom-provider models, virtual-model generation, redirect rules, Claude aliases, and one-million-context aliases.
- Produces:

```ts
export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled?: boolean
  name: string
  object: string
  preview?: boolean
  supported_endpoints?: Array<string>
  vendor?: string
  version: string
  [key: string]: unknown
}

export interface ModelDiscoveryListing extends Record<string, unknown> {
  id: string
  object: string
  type: string
}

export async function buildModelDiscoveryListings(): Promise<
  Array<ModelDiscoveryListing>
>
```

- [ ] **Step 1: Write failing metadata-preservation tests**

Extend the model fixture in `tests/models-route.test.ts`:

```ts
state.models = {
  object: "list",
  data: [{
    id: "gpt-current",
    name: "GPT Current",
    object: "model",
    version: "2026-08-01",
    vendor: "OpenAI",
    model_picker_enabled: true,
    auto: true,
    is_chat_default: true,
    is_chat_fallback: false,
    info_messages: [{ type: "info", message: "current" }],
    billing: {
      auto_discount: 0.5,
      token_prices: {
        batch_size: 1_000_000,
        default: {
          input_price: 17.5,
          output_price: 90.25,
          cache_read_price: 1.75,
          cache_write_price: 21.875,
          cache_write_1h_price: 35.5,
          max_prompt_tokens: 128_000,
        },
      },
    },
    capabilities: currentCapabilities,
    supported_endpoints: ["/responses"],
  }],
}
```

Add:

```ts
test("preserves cumulative upstream model metadata", async () => {
  const response = await server.request("/v1/models")
  const body = await response.json() as { data: Array<Record<string, unknown>> }
  const model = body.data.find((entry) => entry.id === "gpt-current")
  expect(model).toMatchObject({
    auto: true,
    is_chat_default: true,
    is_chat_fallback: false,
    info_messages: [{ type: "info", message: "current" }],
    billing: {
      auto_discount: 0.5,
      token_prices: {
        default: {
          input_price: 17.5,
          cache_write_1h_price: 35.5,
        },
      },
    },
  })
})

test("serves the same normalized row from single-model discovery", async () => {
  const list = await server.request("/v1/models")
  const listBody = await list.json() as { data: Array<Record<string, unknown>> }
  const single = await server.request("/v1/models/gpt-current")
  expect(single.status).toBe(200)
  expect(await single.json()).toEqual(
    listBody.data.find((entry) => entry.id === "gpt-current"),
  )
})

test("returns a safe not-found error for an unknown single model", async () => {
  const response = await server.request("/models/not-real")
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: { message: "Model not found", type: "not_found_error" },
  })
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
bun test tests/models-route.test.ts -t "upstream model metadata|single-model"
```

Expected: metadata assertions fail because `toCopilotModelListing()` reconstructs a fixed subset; single routes return 404 from the catch-all.

- [ ] **Step 3: Broaden the model type without rigid validation**

Make model fields optional where live older/newer shapes legitimately omit them and add `[key: string]: unknown`. Preserve typed fields used by routing and UI.

Do not introduce Zod parsing that rejects unknown fields. The upstream authenticated response is the source of truth; tests should prove optional unknown fields survive JSON round trips.

- [ ] **Step 4: Build discovery rows from upstream clones**

Replace the fixed object construction with:

```ts
function toCopilotModelListing(model: Model): ModelDiscoveryListing {
  const supportedEndpoints = supportedEndpointsForClient(model)
  const thinking = toDiscoveryThinking(model)
  return {
    ...structuredClone(model),
    id: model.id,
    object: "model",
    type: "model",
    created: 0,
    created_at: new Date(0).toISOString(),
    owned_by: model.vendor ?? "unknown",
    display_name: model.name,
    ...(supportedEndpoints ? { supported_endpoints: supportedEndpoints } : {}),
    ...(modelHasOneMillionContext(model) ? { supports_1m_context: true } : {}),
    ...(thinking ? { thinking } : {}),
  }
}
```

Extract the existing list composition into `buildModelDiscoveryListings()`. Ensure alias cloning retains unknown metadata with object spread and changes only alias fields.

- [ ] **Step 5: Add list and single routes over one composed snapshot**

```ts
modelRoutes.get("/", async (c) => {
  try {
    return c.json({
      object: "list",
      data: await buildModelDiscoveryListings(),
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

modelRoutes.get("/:model", async (c) => {
  const model = (await buildModelDiscoveryListings()).find(
    (entry) => entry.id === c.req.param("model"),
  )
  if (!model) {
    return c.json(
      { error: { message: "Model not found", type: "not_found_error" } },
      404,
    )
  }
  return c.json(model)
})
```

Keep Google `:generateContent` routes unaffected by requiring this route to match exactly one ordinary path segment.

- [ ] **Step 6: Run focused and integration tests**

Run:

```powershell
bun test tests/models-route.test.ts tests/integration/models.test.ts tests/model-resolver.test.ts
```

Expected: PASS, including aliases, redirects, virtual reasoning models, 1M aliases, custom models, and `/models` plus `/v1/models` list/single variants.

- [ ] **Step 7: Commit Task 4**

```powershell
git add src/services/copilot/get-models.ts src/routes/models/route.ts tests/models-route.test.ts tests/integration/models.test.ts
git commit -m "feat: preserve current Copilot model metadata"
```

### Task 5: Add the Pure Endpoint-Support and Route-Decision Module

**Files:**
- Create: `src/lib/endpoint-routing.ts`
- Create: `tests/endpoint-routing.test.ts`
- Modify: `src/services/copilot/create-anthropic-messages.ts:31-39`
- Modify: `src/routes/chat-completions/responses-fallback-executor.ts:75-81`
- Modify: `src/routes/messages/handler.ts:1556-1560`
- Modify: `src/routes/responses/handler.ts:489-506`
- Modify: `src/routes/responses/websocket.ts:334-349`
- Test: existing endpoint/fallback tests

**Interfaces:**
- Consumes: `Model.supported_endpoints`.
- Produces:

```ts
export type ClientDialect = "chat" | "messages" | "responses"

export type CopilotInferenceEndpoint =
  | "/chat/completions"
  | "/responses"
  | "/v1/messages"

export interface ModelEndpointSupport {
  chat: boolean
  embeddings: boolean
  messages: boolean
  responses: boolean
  responsesWebSocket: boolean
}

export interface TranslationCheck {
  blockers: Array<string>
  supported: boolean
}

export interface EndpointRouteDecision {
  reason: "endpoint_unavailable" | "native" | "payload_requirement"
  source: ClientDialect
  target: CopilotInferenceEndpoint
  translated: boolean
}

export interface EndpointRouteFailure {
  blockers: Array<string>
  code: "endpoint_translation_unsupported"
  source: ClientDialect
}

export function getModelEndpointSupport(
  model: Pick<Model, "supported_endpoints"> | undefined,
): ModelEndpointSupport

export function selectCopilotEndpoint(options: {
  candidates: Array<{
    check: TranslationCheck
    endpoint: CopilotInferenceEndpoint
    reason: EndpointRouteDecision["reason"]
  }>
  source: ClientDialect
  support: ModelEndpointSupport
}): EndpointRouteDecision | EndpointRouteFailure
```

- [ ] **Step 1: Write the failing endpoint interpretation tests**

Create `tests/endpoint-routing.test.ts`:

```ts
import { expect, test } from "bun:test"

import {
  getModelEndpointSupport,
  selectCopilotEndpoint,
} from "~/lib/endpoint-routing"

test("treats an unknown model as supporting no Copilot endpoint", () => {
  expect(getModelEndpointSupport(undefined)).toEqual({
    chat: false,
    embeddings: false,
    messages: false,
    responses: false,
    responsesWebSocket: false,
  })
})

test("treats a known model with missing endpoint metadata as Chat only", () => {
  expect(getModelEndpointSupport({})).toEqual({
    chat: true,
    embeddings: false,
    messages: false,
    responses: false,
    responsesWebSocket: false,
  })
})

test("interprets every advertised inference endpoint independently", () => {
  expect(
    getModelEndpointSupport({
      supported_endpoints: [
        "/responses",
        "ws:/responses",
        "/v1/messages",
        "/embeddings",
      ],
    }),
  ).toEqual({
    chat: false,
    embeddings: true,
    messages: true,
    responses: true,
    responsesWebSocket: true,
  })
})

test("selects native first and the first lossless supported fallback", () => {
  const support = getModelEndpointSupport({
    supported_endpoints: ["/responses", "/v1/messages"],
  })
  expect(
    selectCopilotEndpoint({
      source: "messages",
      support,
      candidates: [
        {
          endpoint: "/v1/messages",
          reason: "native",
          check: { supported: true, blockers: [] },
        },
        {
          endpoint: "/responses",
          reason: "endpoint_unavailable",
          check: { supported: true, blockers: [] },
        },
      ],
    }),
  ).toMatchObject({ target: "/v1/messages", translated: false })
})

test("returns every translation blocker when no candidate is lossless", () => {
  const result = selectCopilotEndpoint({
    source: "responses",
    support: getModelEndpointSupport({
      supported_endpoints: ["/v1/messages"],
    }),
    candidates: [{
      endpoint: "/v1/messages",
      reason: "endpoint_unavailable",
      check: {
        supported: false,
        blockers: ["opaque_reasoning", "custom_tool_grammar"],
      },
    }],
  })
  expect(result).toEqual({
    blockers: ["opaque_reasoning", "custom_tool_grammar"],
    code: "endpoint_translation_unsupported",
    source: "responses",
  })
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test tests/endpoint-routing.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement endpoint interpretation and generic selection**

Implementation rules:

```ts
const endpointEnabled = (
  support: ModelEndpointSupport,
  endpoint: CopilotInferenceEndpoint,
): boolean => {
  switch (endpoint) {
    case "/chat/completions": return support.chat
    case "/responses": return support.responses
    case "/v1/messages": return support.messages
  }
}
```

- An undefined/unknown model supports no endpoint.
- A known model object with missing `supported_endpoints` returns Chat-only support.
- An explicit empty array supports no inference endpoint.
- `ws:/responses` never implies HTTP `/responses`; both are independent flags.
- `selectCopilotEndpoint()` iterates candidates in caller-specified preference order.
- A candidate is usable only when the model advertises its endpoint and `check.supported` is true.
- A route is native when the selected endpoint matches the source dialect's endpoint.
- Failure blockers are unique and preserve first-seen order.

- [ ] **Step 4: Replace duplicated support checks without changing route behavior**

Use `getModelEndpointSupport()` in the existing `modelSupportsNativeMessages()`, Chat-to-Responses check, Messages-to-Responses check, Responses HTTP fallback check, and Responses WebSocket fallback check. Do not yet change their ordering or translation eligibility; this task only centralizes endpoint interpretation.

- [ ] **Step 5: Run focused compatibility tests**

Run:

```powershell
bun test tests/endpoint-routing.test.ts tests/chat-completions-responses-fallback.test.ts tests/messages-handler.test.ts tests/messages-responses-handler.test.ts tests/responses-handler.test.ts tests/responses-websocket.test.ts
```

Expected: PASS with the exact pre-task route behavior, now driven by one support parser.

- [ ] **Step 6: Commit Task 5**

```powershell
git add src/lib/endpoint-routing.ts src/services/copilot/create-anthropic-messages.ts src/routes/chat-completions/responses-fallback-executor.ts src/routes/messages/handler.ts src/routes/responses/handler.ts src/routes/responses/websocket.ts tests/endpoint-routing.test.ts
git commit -m "refactor: centralize Copilot endpoint support"
```

### Task 6: Verify the Foundation Plan as an Independent Deliverable

**Files:**
- Verify only; do not create new production files in this task.

**Interfaces:**
- Consumes: all interfaces produced by Tasks 1-5.
- Produces: a clean, committed foundation ready for protocol-specific plans.

- [ ] **Step 1: Run the complete focused foundation suite**

```powershell
bun test tests/copilot-contract.test.ts tests/copilot-request-context.test.ts tests/copilot-client.test.ts tests/request-id.test.ts tests/models-route.test.ts tests/model-resolver.test.ts tests/endpoint-routing.test.ts tests/routing-affinity.test.ts tests/account-router.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run static checks**

```powershell
bun run typecheck
bun run lint -- src/services/copilot/copilot-contract.ts src/lib/copilot-request-context.ts src/lib/endpoint-routing.ts src/lib/state.ts src/start.ts src/server.ts src/lib/request-session.ts src/services/copilot/copilot-client.ts src/services/copilot/get-models.ts src/routes/models/route.ts tests/copilot-contract.test.ts tests/copilot-request-context.test.ts tests/endpoint-routing.test.ts tests/copilot-client.test.ts tests/request-id.test.ts tests/models-route.test.ts
bun run build
git diff --check
```

Expected: all commands exit 0. Lint emits no new warnings.

- [ ] **Step 3: Run one live model-discovery check**

Run:

```powershell
bun test tests/integration/models.test.ts tests/integration/middleware.test.ts
```

Expected: live `/models` succeeds under API `2026-08-01`, list/single routing tests pass, and authentication middleware remains unchanged.

- [ ] **Step 4: Confirm repository state**

```powershell
git status --short
git log --oneline -6
```

Expected: no uncommitted files from this plan; the task commits are visible above the design/plan commits.
