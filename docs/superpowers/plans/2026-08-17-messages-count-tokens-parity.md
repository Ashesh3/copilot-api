# Messages and Count-Tokens Contract Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native `/v1/messages` the ordinary path for Messages-capable models, preserve the Anthropic-compatible body and headers, forward token counting to Copilot, and use translated endpoints only when their mappings are explicitly lossless.

**Architecture:** Messages request preparation clones the raw Anthropic-compatible object, removes only gateway-local keys, normalizes nested cache markers during serialization, and forwards client beta/version/provider headers through typed transport options. The handler validates the public boundary, selects native Messages first, and uses existing Responses/Chat translators only after pure translation checks. Count-tokens shares the native request preparation and account routing but has its own upstream service and error adaptation.

**Tech Stack:** Bun 1.3.x, strict TypeScript/ESNext, Hono, existing Anthropic types/translators, account-aware transport, Bun test, live Copilot integration tests.

**Spec:** `docs/superpowers/specs/2026-08-17-copilot-api-contract-parity-design.md`

## Global Constraints

- Requires the contract/model-routing plan and Responses/Chat parity plan.
- Prefer native `/v1/messages` whenever the model advertises it.
- Preserve valid native thinking/signature blocks; do not strip them merely because native routing is selected.
- Forward canonicalized beta identifiers without maintaining a stale local allow/ignore/reject table.
- Preserve root and nested `cache_control`, fallback-credit fields, advanced tool metadata, and unknown Anthropic-compatible fields unless they are explicitly gateway-local.
- Use upstream `/v1/messages/count_tokens` for Copilot models; never return a fabricated constant count.
- Preserve Messages named SSE events and remove the backend's extra bare `[DONE]` before clients see it.
- Preserve hash-only account affinity and never replay after streamed output.
- Keep upstream bodies raw only in administrator-only LLM Debug.
- Follow red-green TDD and commit each reviewable behavior group.

---

## File Map

- Create `src/services/copilot/messages-contract.ts`: boundary validation, clone-and-denylist preparation, beta canonicalization, and native serializer.
- Create `tests/messages-contract.test.ts`: pure request/body/header contract tests.
- Create `src/services/copilot/count-anthropic-tokens.ts`: native Copilot count-tokens transport.
- Create `tests/count-anthropic-tokens.test.ts`: request/header/error transport tests.
- Create `src/routes/messages/translation-fidelity.ts`: Messages-to-Responses and Messages-to-Chat blocker scans.
- Create `tests/messages-endpoint-routing.test.ts`: full endpoint route matrix.
- Modify `src/routes/messages/anthropic-types.ts`: forward-compatible top-level, usage, billing, and recommendation types.
- Modify `src/services/copilot/create-anthropic-messages.ts`: use prepared native body and forwarded header options.
- Modify `src/routes/messages/handler.ts`: validate, route native first, and preserve/recover thinking safely.
- Modify `src/routes/messages/count-tokens-handler.ts`: call upstream count-tokens for Copilot models.
- Modify `src/routes/messages/native-handler.ts`: preserve usage/recommendation metadata and strict stream framing.
- Modify `src/routes/messages/stream-translation.ts` and `responses-translation.ts`: preserve cumulative usage/billing fields where translated.
- Modify focused native, handler, token-count, stream, and integration tests.

### Task 1: Make the Anthropic Payload Types Forward-Compatible

**Files:**
- Modify: `src/routes/messages/anthropic-types.ts:3-40,42-167,172-248`
- Modify: `tests/anthropic-request.test.ts`
- Modify: `tests/anthropic-response.test.ts`

**Interfaces:**
- Consumes: current Anthropic request/response translators and native handlers.
- Produces:

```ts
export interface AnthropicMessagesPayload extends Record<string, unknown> {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens?: number
  // existing typed fields remain
  cache_control?: AnthropicCacheControl
  fallback_credit_token?: string
}

export interface AnthropicCacheControl {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  [key: string]: unknown
}

export interface AnthropicResponse extends Record<string, unknown> {
  // existing fields
  copilot_usage?: unknown
  recommended_auto_tier?: "eco" | "balanced"
  stop_details?: Record<string, unknown>
}
```

Add optional `cache_control?: AnthropicCacheControl` and `[key:string]:unknown` to text blocks, tools, and other extensible content records where upstream accepts extra fields.

- [ ] **Step 1: Write failing compile/runtime preservation tests**

Add request fixture assertions:

```ts
test("types and preserves current native Messages extensions", () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-current",
    max_tokens: 512,
    cache_control: { type: "ephemeral", ttl: "5m" },
    fallback_credit_token: "opaque-token",
    messages: [{ role: "user", content: "hello" }],
    future_native_field: { enabled: true },
  }
  expect(payload.future_native_field).toEqual({ enabled: true })
})
```

Add response fixture assertions for `copilot_usage`, `recommended_auto_tier`, `stop_details`, `usage.cache_creation`, and unknown optional fields.

- [ ] **Step 2: Run typecheck/tests and verify RED**

```powershell
bun run typecheck
bun test tests/anthropic-request.test.ts tests/anthropic-response.test.ts
```

Expected: the new fixture fields do not typecheck under the current closed interfaces.

- [ ] **Step 3: Broaden only extensible wire interfaces**

Add index signatures to wire records, not internal state types. Keep discriminant fields (`type`, `role`, `stop_reason`) strongly typed. Extend usage with:

```ts
cache_creation?: {
  ephemeral_5m_input_tokens?: number
  ephemeral_1h_input_tokens?: number
}
```

Extend `AnthropicMessageDeltaEvent` with optional `copilot_usage` and the response/message start type with optional recommendation metadata.

- [ ] **Step 4: Run typecheck/tests and verify GREEN**

```powershell
bun run typecheck
bun test tests/anthropic-request.test.ts tests/anthropic-response.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/routes/messages/anthropic-types.ts tests/anthropic-request.test.ts tests/anthropic-response.test.ts
git commit -m "refactor: broaden native Messages wire types"
```

### Task 2: Prepare Native Messages with Clone-and-Denylist Semantics

**Files:**
- Create: `src/services/copilot/messages-contract.ts`
- Create: `tests/messages-contract.test.ts`
- Modify: `src/services/copilot/create-anthropic-messages.ts:41-143,161-218`
- Modify: `tests/create-anthropic-messages.test.ts`

**Interfaces:**
- Consumes: `AnthropicMessagesPayload`, nested cache-control serializer requirements, and typed header options from the foundation plan.
- Produces:

```ts
export interface AnthropicRequestHeaders {
  anthropicBeta?: string
  anthropicVersion: string
  modelProviderPreference?: string
}

export interface PreparedAnthropicMessagesRequest {
  body: Record<string, unknown>
  headers: AnthropicRequestHeaders
}

export function canonicalizeAnthropicBeta(
  value: string | undefined,
): string | undefined

export function prepareAnthropicMessagesRequest(options: {
  anthropicBeta?: string
  anthropicVersion?: string
  modelProviderPreference?: string
  payload: AnthropicMessagesPayload
  requireMaxTokens: boolean
}): PreparedAnthropicMessagesRequest

export function serializeAnthropicMessagesRequest(
  body: Record<string, unknown>,
): string
```

- [ ] **Step 1: Write failing body/header preservation tests**

Create `tests/messages-contract.test.ts`:

```ts
import { expect, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import {
  canonicalizeAnthropicBeta,
  prepareAnthropicMessagesRequest,
  serializeAnthropicMessagesRequest,
} from "~/services/copilot/messages-contract"

test("canonicalizes beta whitespace and duplicates without renaming ids", () => {
  expect(
    canonicalizeAnthropicBeta(
      " interleaved-thinking-2025-05-14,claude-code-20250219, interleaved-thinking-2025-05-14 ",
    ),
  ).toBe("interleaved-thinking-2025-05-14,claude-code-20250219")
})

test("preserves native top-level fields and removes only gateway-local keys", () => {
  const payload = {
    model: "claude-current",
    max_tokens: 512,
    messages: [{ role: "user", content: "hello" }],
    cache_control: { type: "ephemeral", ttl: "5m" },
    fallback_credit_token: "opaque",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    future_native_field: { enabled: true },
    _gateway_compaction: true,
  } as AnthropicMessagesPayload
  const prepared = prepareAnthropicMessagesRequest({
    payload,
    requireMaxTokens: true,
    anthropicBeta: "claude-code-20250219",
    anthropicVersion: "2023-06-01",
    modelProviderPreference: "anthropic",
  })
  expect(prepared.body).toMatchObject({
    cache_control: { type: "ephemeral", ttl: "5m" },
    fallback_credit_token: "opaque",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    future_native_field: { enabled: true },
  })
  expect(prepared.body).not.toHaveProperty("_gateway_compaction")
  expect(payload).toHaveProperty("_gateway_compaction", true)
  expect(prepared.headers).toEqual({
    anthropicBeta: "claude-code-20250219",
    anthropicVersion: "2023-06-01",
    modelProviderPreference: "anthropic",
  })
})

test("normalizes every ephemeral cache marker without mutating the source", () => {
  const body = {
    cache_control: { type: "ephemeral", ttl: "5m", scope: "global" },
    system: [{
      type: "text",
      text: "stable",
      cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
    }],
  }
  const serialized = serializeAnthropicMessagesRequest(body)
  expect(JSON.parse(serialized)).toEqual({
    cache_control: { type: "ephemeral", ttl: "5m" },
    system: [{
      type: "text",
      text: "stable",
      cache_control: { type: "ephemeral", ttl: "1h" },
    }],
  })
  expect(body.cache_control).toHaveProperty("scope", "global")
})

test.each([
  ["model", { model: "", messages: [], max_tokens: 1 }],
  ["messages", { model: "claude", messages: [], max_tokens: 1 }],
  ["max_tokens", { model: "claude", messages: [{ role: "user", content: "x" }] }],
] as const)("validates required inference field %s", (param, payload) => {
  expect(() =>
    prepareAnthropicMessagesRequest({
      payload: payload as AnthropicMessagesPayload,
      requireMaxTokens: true,
    }),
  ).toThrow(LocalHTTPError)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/messages-contract.test.ts`

Expected: module does not exist; current allowlist drops root cache control and future fields.

- [ ] **Step 3: Implement clone-and-denylist preparation**

Use `structuredClone(payload as Record<string, unknown>)`. Deny only exact gateway-local keys:

```ts
const GATEWAY_ONLY_MESSAGES_FIELDS = new Set([
  "_gateway_compaction",
  "_json_schema",
])
```

Do not delete sampling or `output_config.effort`; current CAPI owns provider/model transformations and validation.

Required validation:

- non-empty string model;
- non-empty messages array;
- positive integer `max_tokens` only when `requireMaxTokens` is true;
- valid no-CR/LF optional header values, using the shared contract sanitizer.

Local validation errors use Anthropic shape:

```ts
{
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "max_tokens is required for Messages requests.",
  },
}
```

- [ ] **Step 4: Integrate native creation**

Expand `createAnthropicMessages()` options:

```ts
anthropicBeta?: string
anthropicVersion?: string
modelProviderPreference?: string
```

Call `prepareAnthropicMessagesRequest()` and pass its header values through `routedFetch.headerOptions`. Keep compaction fitting after preparation and before serialization.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
bun test tests/messages-contract.test.ts tests/create-anthropic-messages.test.ts
```

Expected: PASS, including existing scoped cache normalization and compaction fitting.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/services/copilot/messages-contract.ts src/services/copilot/create-anthropic-messages.ts tests/messages-contract.test.ts tests/create-anthropic-messages.test.ts
git commit -m "fix: preserve native Messages requests"
```

### Task 3: Forward Native Messages Headers Through Every Native Call

**Files:**
- Modify: `src/routes/messages/handler.ts:162-365`
- Modify: `src/routes/messages/native-handler.ts:98-365`
- Modify: `src/routes/chat-completions/anthropic-bridge.ts`
- Modify: `src/routes/responses/messages-bridge.ts`
- Modify: `tests/messages-handler.test.ts`
- Modify: `tests/create-anthropic-messages.test.ts`
- Modify: `tests/chat-completions-responses-fallback.test.ts`

**Interfaces:**
- Consumes: prepared native header options from Task 2.
- Produces:

```ts
export interface NativeMessagesRequestOptions {
  anthropicBeta?: string
  anthropicVersion?: string
  initiatorOverride?: "agent" | "user"
  modelProviderPreference?: string
  requestedModel?: string
}
```

- [ ] **Step 1: Write failing header-forwarding tests**

In `tests/messages-handler.test.ts`, send:

```ts
headers: {
  "content-type": "application/json",
  "anthropic-beta":
    "advanced-tool-use-2025-11-20, fallback-credit-2026-07-01",
  "anthropic-version": "2023-06-01",
  "x-model-provider-preference": "anthropic",
}
```

Install a model advertising `/v1/messages`, make an ordinary text request, and assert captured upstream headers contain the canonical beta string, version, and provider preference.

Add bridge tests proving Chat-to-Messages and Responses-to-Messages can pass explicit native options without reading a Hono context directly.

- [ ] **Step 2: Run tests and verify RED**

```powershell
bun test tests/messages-handler.test.ts tests/create-anthropic-messages.test.ts -t "beta|provider preference|anthropic version"
```

Expected: current native creation forwards only fixed `anthropic-version`.

- [ ] **Step 3: Capture native headers once at the public boundary**

In `handleCompletion()`:

```ts
const nativeOptions: NativeMessagesRequestOptions = {
  anthropicBeta: c.req.header("anthropic-beta"),
  anthropicVersion: c.req.header("anthropic-version"),
  modelProviderPreference: c.req.header("x-model-provider-preference"),
  requestedModel,
  ...(initiatorOverride ? { initiatorOverride } : {}),
}
```

Pass `nativeOptions` to `handleWithNativeMessages()`. Do not add these headers to Responses/Chat upstream calls when the route decision selected another dialect.

- [ ] **Step 4: Thread options through native search/retry paths**

Ensure `resolveNativeWebSearch()` uses the same options on every iteration. A retry after a proven native signature error must preserve beta/version/provider preference.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
bun test tests/messages-handler.test.ts tests/create-anthropic-messages.test.ts tests/chat-completions-responses-fallback.test.ts tests/responses-messages-bridge.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```powershell
git add src/routes/messages/handler.ts src/routes/messages/native-handler.ts src/routes/chat-completions/anthropic-bridge.ts src/routes/responses/messages-bridge.ts tests/messages-handler.test.ts tests/create-anthropic-messages.test.ts tests/chat-completions-responses-fallback.test.ts
git commit -m "fix: forward native Messages headers"
```

### Task 4: Route Messages Native-First and Preserve Valid Thinking

**Files:**
- Create: `src/routes/messages/translation-fidelity.ts`
- Create: `tests/messages-endpoint-routing.test.ts`
- Modify: `src/routes/messages/handler.ts:288-365,522-676,1299-1380,1556-1560`
- Modify: `tests/messages-handler.test.ts`
- Modify: `tests/messages-responses-handler.test.ts`
- Modify: `tests/anthropic-request.test.ts`

**Interfaces:**
- Consumes: shared endpoint router, native handler, existing Messages-to-Responses/Chat translators.
- Produces:

```ts
export function checkMessagesToResponsesTranslation(
  payload: AnthropicMessagesPayload,
): TranslationCheck

export function checkMessagesToChatTranslation(
  payload: AnthropicMessagesPayload,
): TranslationCheck

export function selectMessagesUpstreamEndpoint(options: {
  payload: AnthropicMessagesPayload
  selectedModel: Model | undefined
}): EndpointRouteDecision | EndpointRouteFailure
```

- [ ] **Step 1: Write the failing Messages route matrix**

Cover:

- `/v1/messages` plus `/responses` -> native Messages for ordinary text;
- Messages-only -> native;
- Responses-only -> Responses when lossless;
- Chat-only/missing metadata -> Chat when lossless;
- Messages-supported request with valid thinking/signature -> native and signature preserved;
- Responses-only request with a `tool_reference` or unsupported native tool feature -> local `endpoint_translation_unsupported`;
- no endpoint -> local 400 and no upstream call.

Example:

```ts
test("prefers native Messages and preserves signed thinking", async () => {
  installModel({
    id: "claude-current",
    supported_endpoints: ["/responses", "/v1/messages"],
  })
  const response = await postMessages({
    model: "claude-current",
    max_tokens: 256,
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{
          type: "thinking",
          thinking: "prior thought",
          signature: "valid-native-signature",
        }],
      },
      { role: "user", content: "continue" },
    ],
  })
  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(JSON.stringify(lastUpstreamPayload)).toContain(
    "valid-native-signature",
  )
})
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `bun test tests/messages-endpoint-routing.test.ts`

Expected: ordinary dual-endpoint Messages currently route to Responses/Chat, and native selection strips thinking unconditionally.

- [ ] **Step 3: Implement translation blocker scans**

Block Messages-to-Responses/Chat when the target cannot preserve:

- `tool_reference` blocks or advanced deferred tool metadata;
- unknown native tool types without schemas;
- fallback-credit token/stop details that must reach native Anthropic;
- context-management/compaction native fields;
- signed thinking when the translator cannot round-trip its signature;
- root automatic cache control if the target has no explicit mapping; and
- native web fetch/search tool semantics without a supported compatibility loop.

Permit existing mapped text/image/document/function tools/results/system/sampling/effort cases and add round-trip tests for them.

- [ ] **Step 4: Select native first**

Candidate order:

1. Native Messages.
2. Responses when advertised and lossless.
3. Chat when advertised (or endpoint metadata omitted) and lossless.

Replace `usesNativeMessages` attachment/tool-reference special-casing with the route decision.

- [ ] **Step 5: Remove pre-dispatch blanket thinking stripping**

Delete the unconditional `stripThinkingBlocks()` call on native selection. Keep the pure helper for explicit recovery tests and translated-path recovery.

For native non-streaming calls only, if the first upstream response is a deterministic invalid-signature 400, clone the payload, strip historical thinking once, record the existing non-default behavior, and retry on the same account within the shared send budget. Do not retry a generic `Bad Request`; do not retry streaming after headers/output.

To preserve the existing three-send ceiling, extend the shared router contract in this task:

```ts
export interface RoutedFetchOptions {
  // existing fields
  retryBudget?: RetryBudget
}
```

`routedFetch()` uses `options.retryBudget ?? createRetryBudget()`. The native Messages logical call creates one budget before its first dispatch, passes it through `createAnthropicMessages()`, and calls `consumeExtraSend(budget)` before the recovery dispatch. If no extra send remains, return the original 400 without recovery. The same budget therefore covers transport retry, account reinitialization, unidentified failover, and signature recovery.

Add a test that combines an initial transient send plus an invalid-signature response and proves the recovery send is suppressed once the total logical-call budget is exhausted.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
bun test tests/messages-endpoint-routing.test.ts tests/messages-handler.test.ts tests/messages-responses-handler.test.ts tests/anthropic-request.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```powershell
git add src/routes/messages/translation-fidelity.ts src/routes/messages/handler.ts src/services/copilot/create-anthropic-messages.ts src/lib/account-router.ts src/services/copilot/transport-retry.ts tests/messages-endpoint-routing.test.ts tests/messages-handler.test.ts tests/messages-responses-handler.test.ts tests/anthropic-request.test.ts tests/copilot-client.test.ts
git commit -m "feat: route Messages through the native API"
```

### Task 5: Forward Copilot Count-Tokens Requests Upstream

**Files:**
- Create: `src/services/copilot/count-anthropic-tokens.ts`
- Create: `tests/count-anthropic-tokens.test.ts`
- Modify: `src/routes/messages/count-tokens-handler.ts:1-154`
- Modify: `tests/count-tokens-handler.test.ts`
- Modify: `tests/integration/count-tokens.test.ts`

**Interfaces:**
- Consumes: `prepareAnthropicMessagesRequest()`, `serializeAnthropicMessagesRequest()`, model redirect/normalization, custom-provider resolution, and `routedFetch()`.
- Produces:

```ts
export interface CountAnthropicTokensOptions {
  anthropicBeta?: string
  anthropicVersion?: string
  modelProviderPreference?: string
  signal?: AbortSignal
}

export interface AnthropicTokenCountResult {
  input_tokens: number
}

export async function countAnthropicTokens(
  payload: AnthropicMessagesPayload,
  options: CountAnthropicTokensOptions = {},
): Promise<AnthropicTokenCountResult>
```

- [ ] **Step 1: Write failing upstream transport tests**

Create `tests/count-anthropic-tokens.test.ts`:

```ts
test("posts the native token-count body and headers", async () => {
  const result = await countAnthropicTokens({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
    system: [{ type: "text", text: "stable" }],
    tools: [{
      name: "lookup",
      description: "Lookup",
      input_schema: { type: "object", properties: {} },
    }],
  }, {
    anthropicBeta: "claude-code-20250219",
    anthropicVersion: "2023-06-01",
    modelProviderPreference: "anthropic",
  })
  expect(result).toEqual({ input_tokens: 42 })
  expect(lastUpstreamPath).toBe("/v1/messages/count_tokens")
  expect(lastUpstreamHeaders).toMatchObject({
    "anthropic-beta": "claude-code-20250219",
    "anthropic-version": "2023-06-01",
    "x-model-provider-preference": "anthropic",
  })
  expect(lastUpstreamPayload).not.toHaveProperty("max_tokens")
})

test("throws the upstream HTTP error instead of fabricating one token", async () => {
  queuedResponse = Response.json(
    { type: "error", error: { type: "invalid_request_error", message: "bad" } },
    { status: 400 },
  )
  await expect(countAnthropicTokens(validPayload)).rejects.toHaveProperty(
    "response.status",
    400,
  )
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/count-anthropic-tokens.test.ts`

Expected: module does not exist.

- [ ] **Step 3: Implement native count-tokens transport**

Prepare with `requireMaxTokens:false`, remove inference-only fields that CAPI count-tokens does not accept (`max_tokens`, `stream`, output-only controls) through an exact count-tokens allowlist:

```ts
const COUNT_TOKENS_FIELDS = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
])
```

Preserve nested cache/media/tool metadata inside allowed fields. Dispatch through `routedFetch()` with the same model/account affinity, vision detection, beta/version/provider headers, and abort signal as native inference.

Validate a 200 body contains a finite non-negative integer `input_tokens`; otherwise throw a fixed `HTTPError("Invalid token count response from upstream", ...)` whose client boundary remains sanitized.

- [ ] **Step 4: Replace the handler's local fallback for Copilot models**

Keep existing model suffix/redirect and request-context reporting. After resolving the target:

- if it is a configured custom provider without native token counting, use the existing local estimator and return its meaningful result;
- if the model exists in the Copilot catalog, call `countAnthropicTokens()`;
- if the model is unknown, return an Anthropic-shaped 404/model-not-found error;
- let `forwardError()` handle upstream status instead of catching every exception and returning `1`.

Remove Claude/Grok fudge factors for Copilot models because the upstream endpoint already uses native counting or its own estimator.

- [ ] **Step 5: Update handler tests**

Replace `input_tokens > 1` assertions with exact mocked upstream counts. Add tests for beta/version/provider headers, metadata affinity, model redirect, unknown model, 400 propagation, and custom-provider local estimation.

- [ ] **Step 6: Run focused and live token-count tests**

```powershell
bun test tests/count-anthropic-tokens.test.ts tests/count-tokens-handler.test.ts tests/integration/count-tokens.test.ts
```

Expected: PASS. The live test returns a positive current upstream count and does not require `max_tokens`.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src/services/copilot/count-anthropic-tokens.ts src/routes/messages/count-tokens-handler.ts tests/count-anthropic-tokens.test.ts tests/count-tokens-handler.test.ts tests/integration/count-tokens.test.ts
git commit -m "fix: proxy native Messages token counting"
```

### Task 6: Preserve Cumulative Messages Usage and Stream Metadata

**Files:**
- Modify: `src/routes/messages/native-handler.ts:49-89,368-451`
- Modify: `src/routes/messages/stream-translation.ts`
- Modify: `src/routes/messages/responses-translation.ts`
- Modify: `tests/messages-stream-lifecycle.test.ts`
- Modify: `tests/anthropic-response.test.ts`
- Modify: `tests/responses-stream-translation.test.ts`

**Interfaces:**
- Consumes: broadened Anthropic response/event types.
- Produces: unchanged client-visible Anthropic JSON/SSE with cumulative optional fields preserved.

- [ ] **Step 1: Write failing metadata-preservation tests**

Add a native stream fixture:

```ts
event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-current","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0},"recommended_auto_tier":"eco"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":1}},"copilot_usage":{"total_nano_aiu":123}}

event: message_stop
data: {"type":"message_stop"}

data: [DONE]
```

Assert outward stream preserves recommendation, final usage/cache breakdown, and `copilot_usage`, but contains no `[DONE]`.

Add non-stream and translated-path assertions that unknown optional response fields survive where the translation result format permits them.

- [ ] **Step 2: Run tests and verify RED**

```powershell
bun test tests/messages-stream-lifecycle.test.ts tests/anthropic-response.test.ts tests/responses-stream-translation.test.ts
```

Expected: current tracking types drop cache-creation breakdown/recommendation/copilot usage in some paths.

- [ ] **Step 3: Preserve metadata without reconstructing native frames**

For native streams, keep forwarding raw JSON frames except the requested-model rewrite in `message_start`. That rewrite must parse/spread the full object and modify only `message.model`. Usage tracking reads fields but never deletes them.

Update `trackMessageDelta()` to read cache fields without rebuilding the frame. Store only numeric counters needed for local telemetry.

Translated Chat/Responses paths add `copilot_usage` to final `message_delta` and recommendation to `message_start` only when their source protocol supplied them.

- [ ] **Step 4: Run focused tests and verify GREEN**

```powershell
bun test tests/messages-stream-lifecycle.test.ts tests/anthropic-response.test.ts tests/responses-stream-translation.test.ts tests/messages-handler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```powershell
git add src/routes/messages/native-handler.ts src/routes/messages/stream-translation.ts src/routes/messages/responses-translation.ts tests/messages-stream-lifecycle.test.ts tests/anthropic-response.test.ts tests/responses-stream-translation.test.ts tests/messages-handler.test.ts
git commit -m "fix: preserve Messages usage metadata"
```

### Task 7: Return Protocol-Native Safe Messages Errors

**Files:**
- Create: `src/routes/messages/error.ts`
- Create: `tests/messages-error.test.ts`
- Modify: `src/lib/error.ts`
- Modify: `src/routes/messages/route.ts:1-24`
- Modify: `src/routes/messages/stream-translation.ts:606-650`
- Modify: `tests/messages-handler.test.ts`
- Modify: `tests/count-tokens-handler.test.ts`
- Modify: `tests/messages-stream-lifecycle.test.ts`

**Interfaces:**
- Consumes: `HTTPError`, `LocalHTTPError`, gateway request ID, and Hono `Context`.
- Produces:

```ts
export async function forwardMessagesError(
  c: Context,
  error: unknown,
): Promise<Response>

export function createAnthropicStreamError(
  error: unknown,
): AnthropicErrorEvent

export async function inspectSafeHttpError(
  error: HTTPError,
): Promise<{
  clientError?: { code: string; fingerprint: string; message: string }
  safeMessage: string
}>
```

- [ ] **Step 1: Write failing HTTP error-shape tests**

Create `tests/messages-error.test.ts`:

```ts
import { expect, test } from "bun:test"

import { Hono } from "hono"

import { HTTPError, LocalHTTPError } from "~/lib/error"
import { forwardMessagesError } from "~/routes/messages/error"

const app = new Hono()
app.get("/error", async (c) => {
  const kind = c.req.query("kind")
  if (kind === "local") {
    const body = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "max_tokens is required for Messages requests.",
      },
    }
    return await forwardMessagesError(
      c,
      new LocalHTTPError(
        body.error.message,
        Response.json(body, { status: 400 }),
        body,
      ),
    )
  }
  return await forwardMessagesError(
    c,
    new HTTPError(
      "Failed to create native Anthropic messages",
      Response.json(
        { error: { message: "private-upstream-marker" } },
        { status: Number(kind) },
      ),
    ),
  )
})

test("preserves a local Anthropic error body", async () => {
  const response = await app.request("/error?kind=local", {
    headers: { "x-request-id": "req-local" },
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "max_tokens is required for Messages requests.",
    },
  })
})

test.each([
  [400, "invalid_request_error"],
  [401, "authentication_error"],
  [403, "permission_error"],
  [404, "not_found_error"],
  [413, "request_too_large"],
  [429, "rate_limit_error"],
  [500, "api_error"],
] as const)("maps HTTP %s to Anthropic error type %s", async (status, type) => {
  const response = await app.request(`/error?kind=${status}`, {
    headers: { "x-request-id": "req-safe" },
  })
  expect(response.status).toBe(status)
  const body = await response.json() as Record<string, unknown>
  expect(body).toMatchObject({
    type: "error",
    request_id: "req-safe",
    error: { type },
  })
  expect(JSON.stringify(body)).not.toContain("private-upstream-marker")
})
```

- [ ] **Step 2: Write failing in-band stream error tests**

Add a stream lifecycle test that throws a `LocalHTTPError` and an upstream `HTTPError` after headers commit. Assert the emitted named `error` event has Anthropic shape, a fixed safe message, and no raw body/status text.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
bun test tests/messages-error.test.ts tests/messages-stream-lifecycle.test.ts -t "error"
```

Expected: the dedicated adapter does not exist and current route-level errors use the OpenAI envelope.

- [ ] **Step 4: Implement fixed status-to-Anthropic mapping**

First extract the existing upstream-body redaction/classification work in `src/lib/error.ts` into exported `inspectSafeHttpError()`. Both the ordinary OpenAI `forwardError()` path and the new Messages adapter must call this helper so logs/Sentry classification remain identical and raw bodies are read/redacted only once per error boundary. `inspectSafeHttpError()` returns only fixed safe messages and allowlisted validation classes; it never returns raw parsed bodies.

```ts
function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return "invalid_request_error"
    case 401: return "authentication_error"
    case 403: return "permission_error"
    case 404: return "not_found_error"
    case 413: return "request_too_large"
    case 429: return "rate_limit_error"
    default: return "api_error"
  }
}
```

Use fixed messages by status class, for example:

- 400: `"The Copilot Messages request was rejected."`
- 401: `"Copilot authentication failed."`
- 403: `"The Copilot Messages request is not permitted."`
- 404: `"The requested Copilot Messages resource was not found."`
- 413: `"The Copilot Messages request is too large."`
- 429: `"Copilot rate limit exceeded."`
- 402: `"Copilot quota exhausted."`
- 466: `"Copilot client version mismatch."`
- other: `"The Copilot Messages request failed."`

For `LocalHTTPError`, return its `clientBody` unchanged only when it already matches `{type:"error",error:{type:string,message:string}}`; otherwise adapt it through the fixed mapping.

Preserve safe `Retry-After` and quota headers already attached by global middleware. Use `c.req.header("x-request-id")` or the request-session ID for `request_id`.

- [ ] **Step 5: Use the adapter on both Messages routes**

Replace `forwardError()` with `forwardMessagesError()` in `src/routes/messages/route.ts` for `/` and `/count_tokens`.

Make `emitAnthropicStreamError()` delegate to `createAnthropicStreamError()` so HTTP and in-band error types/messages cannot drift.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
bun test tests/messages-error.test.ts tests/messages-handler.test.ts tests/count-tokens-handler.test.ts tests/messages-stream-lifecycle.test.ts tests/error.test.ts
```

Expected: PASS. Ordinary Chat/Responses error behavior remains unchanged.

- [ ] **Step 7: Commit Task 7**

```powershell
git add src/lib/error.ts src/routes/messages/error.ts src/routes/messages/route.ts src/routes/messages/stream-translation.ts tests/messages-error.test.ts tests/messages-handler.test.ts tests/count-tokens-handler.test.ts tests/messages-stream-lifecycle.test.ts tests/error.test.ts tests/sentry.test.ts
git commit -m "fix: return Anthropic-shaped Messages errors"
```

### Task 8: Verify Messages and Token Counting as an Independent Deliverable

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: a clean native-first Messages layer ready for WebSocket/control-plane completion.

- [ ] **Step 1: Run the focused Messages suite**

```powershell
bun test tests/messages-contract.test.ts tests/create-anthropic-messages.test.ts tests/messages-endpoint-routing.test.ts tests/messages-handler.test.ts tests/messages-responses-handler.test.ts tests/messages-stream-lifecycle.test.ts tests/anthropic-request.test.ts tests/anthropic-response.test.ts tests/count-anthropic-tokens.test.ts tests/count-tokens-handler.test.ts tests/responses-messages-bridge.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run live native Messages checks**

```powershell
bun test tests/integration/messages.test.ts tests/integration/count-tokens.test.ts tests/integration/tool-calling.test.ts tests/integration/per-model.test.ts
```

Expected: available native Messages models pass streaming/non-streaming, tools, and token counting. Gated 1h cache/provider pinning is not probed unless already enabled.

- [ ] **Step 3: Run static checks**

```powershell
bun run typecheck
bun run lint -- src/routes/messages/anthropic-types.ts src/services/copilot/messages-contract.ts src/services/copilot/create-anthropic-messages.ts src/services/copilot/count-anthropic-tokens.ts src/routes/messages/translation-fidelity.ts src/routes/messages/handler.ts src/routes/messages/native-handler.ts src/routes/messages/count-tokens-handler.ts src/routes/messages/stream-translation.ts src/routes/messages/responses-translation.ts tests/messages-contract.test.ts tests/messages-endpoint-routing.test.ts tests/count-anthropic-tokens.test.ts tests/count-tokens-handler.test.ts
bun run build
git diff --check
```

Expected: exit 0 with no new warnings.
