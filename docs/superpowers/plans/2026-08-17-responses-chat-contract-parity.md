# Responses and Chat Contract Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Responses and Chat requests follow the current Copilot wire contract, preserve supported client fields, reject deterministic invalid requests locally, and route cross-dialect requests only through lossless translations.

**Architecture:** A pure Responses preparation module classifies top-level fields, stateful controls, reasoning, cache/context settings, and tools before attachment normalization and payload recovery. Chat receives an explicit contract normalizer for modern and deprecated fields. Translation modules expose `TranslationCheck` functions consumed by the shared endpoint router, so handlers select native or translated endpoints without silently discarding unsupported concepts.

**Tech Stack:** Bun 1.3.x, strict TypeScript/ESNext, Hono, existing Responses/Chat translators, `LocalHTTPError`, Bun test, live Copilot integration tests.

**Spec:** `docs/superpowers/specs/2026-08-17-copilot-api-contract-parity-design.md`

## Global Constraints

- Requires completion of `docs/superpowers/plans/2026-08-17-copilot-contract-model-routing.md`.
- Use `getModelEndpointSupport()` and `selectCopilotEndpoint()` for every route decision.
- Preserve unknown nested JSON fields; omit unknown top-level Responses fields because current CAPI top-level decoding is typed.
- Validate deterministic unsupported fields locally with safe protocol-native errors and no upstream call.
- Preserve existing hash-only affinity, retry budget, cancellation, compaction bootstrap, WebP conversion, and 32 MiB Responses recovery.
- Never retry after substantive streamed output.
- Do not expose raw upstream validation bodies outside administrator-only LLM Debug.
- Use red-green TDD and commit each independently reviewable behavior group.

---

## File Map

- Create `src/services/copilot/responses-contract.ts`: current top-level field inventory, local validations, reasoning-none normalization, prompt-cache/context/tool handling, and safe local errors.
- Create `tests/responses-contract.test.ts`: pure preparation/validation tests.
- Create `src/routes/chat-completions/chat-contract.ts`: token-field validation and deprecated-field normalization for direct Chat.
- Create `tests/chat-contract.test.ts`: pure Chat contract tests.
- Modify `src/services/copilot/create-responses.ts`: call the new preparation module before media normalization/recovery and preserve current fields.
- Modify `src/services/copilot/create-chat-completions.ts`: broaden payload types and use Chat contract normalization.
- Modify `src/routes/chat-completions/responses-fallback.ts`: reasoning-none and complete Chat-to-Responses mapping plus translation checks.
- Modify `src/routes/chat-completions/anthropic-bridge.ts`: Chat-to-Messages translation checks.
- Modify `src/routes/chat-completions/handler.ts`: shared endpoint route selection.
- Modify `src/routes/responses/handler.ts`: Responses-to-Chat/Messages translation checks and route selection.
- Modify `src/lib/error.ts`: reusable safe endpoint-translation error constructor or protocol adapter.
- Modify focused normalization, fallback, handler, stream, and integration tests.

### Task 1: Define and Test the Current Responses Top-Level Contract

**Files:**
- Create: `src/services/copilot/responses-contract.ts`
- Create: `tests/responses-contract.test.ts`
- Modify: `src/services/copilot/create-responses.ts:24-55,408-455,673-768`
- Modify: `tests/responses-request-normalization.test.ts`
- Modify: `tests/create-responses.test.ts`

**Interfaces:**
- Consumes: `ResponsesPayload`, model ID, and existing `LocalHTTPError`.
- Produces:

```ts
export type ResponsesWireBody = ResponsesPayload & Record<string, unknown>

export interface PreparedResponsesRequest {
  body: ResponsesWireBody
  normalizationClasses: Array<string>
}

export function prepareResponsesRequest(
  payload: ResponsesPayload,
): PreparedResponsesRequest

export function createResponsesValidationError(options: {
  code: string
  message: string
  param?: string
  status?: 400
}): LocalHTTPError
```

Expand `ResponsesPayload` with typed optional fields:

```ts
background?: boolean | null
context_management?: Array<Record<string, unknown>> | null
multi_agent?: Record<string, unknown> | null
prompt_cache_options?: Record<string, unknown> | null
prompt_cache_retention?: string | null
snippy?: Record<string, unknown> | null
truncation?: string | Record<string, unknown> | null
user?: string | null
```

Reasoning effort becomes `string | number | null` while route-level helpers narrow supported named efforts where required.

Expand the Responses tool-choice string union to include the current documented `"validated"` mode. Preserve object tool choices as forward-compatible records after local blocked-tool validation.

- [ ] **Step 1: Write failing field-preservation and stateful-control tests**

Create `tests/responses-contract.test.ts`:

```ts
import { expect, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import { prepareResponsesRequest } from "~/services/copilot/responses-contract"

test("preserves the reviewed current Responses field inventory", () => {
  const result = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: [{
      role: "user",
      content: [{
        type: "input_text",
        text: "stable prefix",
        prompt_cache_breakpoint: { mode: "explicit" },
      }],
    }],
    context_management: [{ type: "truncate" }],
    truncation: "auto",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "in_memory",
    metadata: { trace: "value" },
    user: "user-1",
    snippy: { enabled: false },
  })
  expect(result.body).toMatchObject({
    context_management: [{ type: "truncate" }],
    truncation: "auto",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "in_memory",
    metadata: { trace: "value" },
    user: "user-1",
    snippy: { enabled: false },
  })
  expect(JSON.stringify(result.body)).toContain("prompt_cache_breakpoint")
})

test.each([
  ["store", { store: true }],
  ["background", { background: true }],
  ["previous_response_id", { previous_response_id: "resp_external" }],
  ["service_tier", { service_tier: "priority" }],
] as const)("rejects unsupported stateful control %s", (param, extra) => {
  expect(() =>
    prepareResponsesRequest({
      model: "gpt-5.6-sol",
      input: "hello",
      ...extra,
    }),
  ).toThrow(LocalHTTPError)
  try {
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "hello", ...extra })
  } catch (error) {
    expect((error as LocalHTTPError).clientBody).toMatchObject({
      error: { code: "unsupported_value", param },
    })
  }
})

test("accepts stateless false and null values without forwarding them", () => {
  const body = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: "hello",
    store: false,
    background: false,
    previous_response_id: null,
  }).body
  expect(body.store).toBe(false)
  expect(body).not.toHaveProperty("background")
  expect(body).not.toHaveProperty("previous_response_id")
})

test("omits unknown top-level fields but preserves unknown nested fields", () => {
  const body = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi", future_nested: 1 }],
      future_item: 2,
    }],
    future_top_level: 3,
  }).body
  expect(body).not.toHaveProperty("future_top_level")
  expect(JSON.stringify(body.input)).toContain("future_nested")
  expect(JSON.stringify(body.input)).toContain("future_item")
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/responses-contract.test.ts`

Expected: FAIL because the module does not exist and current sanitization drops documented fields while forwarding `previous_response_id`.

- [ ] **Step 3: Implement the field inventory and safe errors**

Use an ordered set containing:

```ts
const RESPONSES_TOP_LEVEL_FIELDS = [
  "model", "input", "instructions", "max_output_tokens", "metadata", "user",
  "tools", "tool_choice", "parallel_tool_calls",
  "reasoning", "text", "temperature", "top_p", "include",
  "context_management", "truncation",
  "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention",
  "safety_identifier", "snippy", "multi_agent",
  "store", "background", "previous_response_id", "service_tier", "stream",
  "prompt", "conversation_id", "generate", "client_metadata", "task_budget",
  "copilot_cache_control",
] as const
```

Clone only listed fields into a new object. Do not mutate the caller in this pure module. Normalize accepted stateless values before copying.

Presence rules are exact:

- `store:true` and `background:true` reject; omitted/null/false are accepted;
- non-empty string `previous_response_id` rejects; omitted/null is removed; empty string rejects as `unsupported_value`;
- any present non-null `service_tier` rejects; omitted/null is removed; and
- invalid non-boolean stateful-field types reject with `invalid_type`.

Construct local errors as:

```ts
{
  error: {
    code: "unsupported_value",
    message: "The Copilot Responses endpoint does not support background requests.",
    param: "background",
    type: "invalid_request_error",
  },
}
```

Messages must be fixed strings and must not interpolate user values.

- [ ] **Step 4: Integrate preparation before attachment and size handling**

In `createResponses()`:

1. call `prepareResponsesRequest(payload)`;
2. run attachment normalization on the prepared clone by changing its signature to `normalizeResponsesAttachments(payload: Pick<ResponsesPayload, "input"> & Record<string, unknown>, signal?: AbortSignal, resizeImage?: ResponsesImageResizer): Promise<void>`;
3. apply model defaults/normalizations to the prepared body;
4. run ordinary/compaction payload fitting; and
5. dispatch the exact prepared JSON.

Delete the old `KNOWN_RESPONSES_FIELDS` sanitizer. Keep empty-tool normalization, JSON-schema normalization, minimum output-token clamp, and GPT-5.6 sampling logic by moving them into `responses-contract.ts` as private helpers or applying them to the prepared clone.

- [ ] **Step 5: Update existing previous-response tests**

Change the HTTP test named `preserves previous_response_id when sending Responses API requests` to assert a safe local 400 and zero upstream calls. Keep WebSocket continuation tests unchanged until the WebSocket plan.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
bun test tests/responses-contract.test.ts tests/responses-request-normalization.test.ts tests/create-responses.test.ts
```

Expected: PASS. Existing attachment, payload-recovery, affinity, and safe-error tests stay green.

- [ ] **Step 7: Commit Task 1**

```powershell
git add src/services/copilot/responses-contract.ts src/services/copilot/create-responses.ts tests/responses-contract.test.ts tests/responses-request-normalization.test.ts tests/create-responses.test.ts
git commit -m "fix: align Responses request preparation"
```

### Task 2: Normalize Reasoning, Prompt Caching, and Context Management

**Files:**
- Modify: `src/services/copilot/responses-contract.ts`
- Modify: `src/services/copilot/create-responses.ts:700-768`
- Modify: `tests/responses-contract.test.ts`
- Modify: `tests/responses-request-normalization.test.ts`
- Modify: `tests/responses-translation.test.ts`

**Interfaces:**
- Consumes: `PreparedResponsesRequest` from Task 1 and live model capability helpers.
- Produces:

```ts
export function applyResponsesReasoningDefaults(options: {
  body: ResponsesWireBody
  defaultEffort: string | undefined
  implicitDefault: boolean
}): void

export function validateResponsesContextManagement(
  value: unknown,
): void
```

- [ ] **Step 1: Write failing reasoning-none and integer-effort tests**

Add:

```ts
test("keeps reasoning disabled without requesting summaries or encrypted state", () => {
  const body = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: "hello",
    reasoning: { effort: "none" },
    include: ["code_interpreter_call.outputs"],
  }).body
  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })
  expect(body.reasoning).toEqual({ effort: "none" })
  expect(body.include).toEqual(["code_interpreter_call.outputs"])
})

test("preserves integer reasoning effort", () => {
  const body = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    reasoning: { effort: 2048 },
  }).body
  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })
  expect(body.reasoning).toEqual({ effort: 2048, summary: "auto" })
  expect(body.include).toContain("reasoning.encrypted_content")
})

test("adds encrypted reasoning inclusion once", () => {
  const body = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    include: ["reasoning.encrypted_content"],
  }).body
  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })
  expect(body.include).toEqual(["reasoning.encrypted_content"])
})
```

Add context validation cases:

```ts
test.each(["compaction", "truncate"])(
  "accepts %s context management",
  (type) => {
    expect(() =>
      prepareResponsesRequest({
        model: "gpt-current",
        input: "hello",
        context_management: [{ type }],
      }),
    ).not.toThrow()
  },
)

test("rejects unsupported context management types locally", () => {
  expect(() =>
    prepareResponsesRequest({
      model: "gpt-current",
      input: "hello",
      context_management: [{ type: "future_unknown" }],
    }),
  ).toThrow(LocalHTTPError)
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bun test tests/responses-contract.test.ts tests/responses-request-normalization.test.ts`

Expected: current code always injects `summary:"auto"` and encrypted inclusion, does not type integer effort, and lacks local context validation.

- [ ] **Step 3: Implement reasoning-default semantics**

Rules:

- `reasoning` absent: create an object, omit effort for implicit-default models, otherwise use configured/default effort, then add `summary:"auto"`.
- `effort:"none"`: delete summary and do not inject encrypted inclusion.
- any other string/integer effort: preserve it and default summary to `auto` only when missing.
- `reasoning:null`: treat as absent, not as enabled empty reasoning.
- clone `include` before mutation; add encrypted inclusion once.
- preserve unrelated include values even when reasoning is none.

Update TypeScript response/input types so integer effort compiles without `any`. Update route-level reasoning normalization to return `string | number | undefined`. Apply model suffix and redirect named-effort logic only when the effective effort is a supported string. An integer effort remains on the payload unchanged and passes `undefined` into named-effort redirect selection; model redirects may still change the model, but must not clamp or replace the integer effort.

- [ ] **Step 4: Validate context management before dispatch**

`context_management` must be an array when non-null. Every element must be a record with `type === "compaction" || type === "truncate"`. Preserve every other nested field within an accepted item. Throw `invalid_type` for non-array/non-record and `unsupported_value` for unsupported types.

- [ ] **Step 5: Keep explicit prompt caching byte-for-byte**

Add a request-normalization integration test whose body contains `prompt_cache_options`, `prompt_cache_retention`, and nested `prompt_cache_breakpoint`; assert the captured upstream JSON retains each exact nested object. Do not assert a cache hit.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
bun test tests/responses-contract.test.ts tests/responses-request-normalization.test.ts tests/responses-translation.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/services/copilot/responses-contract.ts src/services/copilot/create-responses.ts tests/responses-contract.test.ts tests/responses-request-normalization.test.ts tests/responses-translation.test.ts
git commit -m "fix: preserve Responses reasoning and cache controls"
```

### Task 3: Enforce Current Responses Tool Restrictions

**Files:**
- Modify: `src/services/copilot/responses-contract.ts`
- Modify: `src/services/copilot/create-responses.ts`
- Modify: `tests/responses-contract.test.ts`
- Modify: `tests/responses-request-normalization.test.ts`
- Modify: `tests/integration/tool-calling.test.ts`

**Interfaces:**
- Consumes: `ResponsesPayload.tools` and the prepared body.
- Produces:

```ts
export function validateResponsesTools(tools: unknown): void
```

- [ ] **Step 1: Write failing blocked/pass-through tool tests**

```ts
const alwaysBlocked = [
  "code_interpreter",
  "computer_use",
  "computer_use_preview",
  "file_search",
  "local_shell",
  "mcp",
  "mcp_list_tools",
]

test.each(alwaysBlocked)("rejects blocked native tool %s", (type) => {
  expect(() =>
    prepareResponsesRequest({
      model: "gpt-current",
      input: "hello",
      tools: [{ type }],
    }),
  ).toThrow(LocalHTTPError)
})

test.each([
  "function",
  "custom",
  "namespace",
  "shell",
  "apply_patch",
  "programmatic_tool_calling",
  "web_search",
  "computer",
  "image_generation",
  "client_future_tool",
])("preserves upstream-authorized tool class %s", (type) => {
  const tool = type === "function" ?
    { type, name: "run", parameters: { type: "object" }, strict: false }
  : { type, name: "run" }
  expect(
    (prepareResponsesRequest({
      model: "gpt-current",
      input: "hello",
      tools: [tool],
    }).body.tools as Array<Record<string, unknown>>)[0]?.type,
  ).toBe(type)
})
```

Retain the existing empty-tool test and add an assertion that a real tool preserves `tool_choice` and `parallel_tool_calls`.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/responses-contract.test.ts tests/responses-request-normalization.test.ts -t "tool"`

Expected: blocked tools are currently forwarded and modern/unknown tool preservation is not explicitly covered.

- [ ] **Step 3: Implement exact tool validation**

Rules:

- `tools` omitted/null/empty removes `tools`, `tool_choice`, and `parallel_tool_calls`.
- non-array tools throw `invalid_type`.
- non-record tools or tools without a string `type` throw `invalid_type`.
- exact blocked types throw `unsupported_value` with `param:"tools"` and a fixed safe message.
- every other tool record is preserved, subject to existing function-parameter normalization.
- never infer authorization for `computer` or `image_generation`; forward them and let upstream feature flags decide.

- [ ] **Step 4: Run focused and live tool tests**

```powershell
bun test tests/responses-contract.test.ts tests/responses-request-normalization.test.ts tests/integration/tool-calling.test.ts
```

Expected: PASS. Live tests exercise only currently available function tools; gated tools remain fixture-only.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/services/copilot/responses-contract.ts src/services/copilot/create-responses.ts tests/responses-contract.test.ts tests/responses-request-normalization.test.ts tests/integration/tool-calling.test.ts
git commit -m "fix: validate Responses tool compatibility"
```

### Task 4: Complete the Direct Chat Contract

**Files:**
- Create: `src/routes/chat-completions/chat-contract.ts`
- Create: `tests/chat-contract.test.ts`
- Modify: `src/services/copilot/create-chat-completions.ts:76-105,614-651`
- Modify: `tests/create-chat-completions.test.ts`
- Modify: `tests/integration/chat-completions.test.ts`

**Interfaces:**
- Consumes: `ChatCompletionsPayload`.
- Produces:

```ts
export function normalizeChatCompletionsRequest(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload
```

Extend `ChatCompletionsPayload` with:

```ts
function_call?: string | { name: string } | null
functions?: Array<Record<string, unknown>> | null
max_completion_tokens?: number | null
prediction?: Record<string, unknown> | null
reasoning_effort?: string | null
thinking_budget?: number | null
top_logprobs?: number | null
```

- [ ] **Step 1: Write failing Chat contract tests**

```ts
import { expect, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import { normalizeChatCompletionsRequest } from "~/routes/chat-completions/chat-contract"

test("preserves current and deprecated Chat fields", () => {
  const payload = normalizeChatCompletionsRequest({
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    max_completion_tokens: 256,
    prediction: { type: "content", content: "known" },
    reasoning_effort: "high",
    thinking_budget: 1024,
    top_logprobs: 3,
    functions: [{ name: "legacy", parameters: { type: "object" } }],
    function_call: { name: "legacy" },
    stop: "END",
  })
  expect(payload).toMatchObject({
    max_completion_tokens: 256,
    reasoning_effort: "high",
    thinking_budget: 1024,
    top_logprobs: 3,
    stop: "END",
  })
  expect(payload.functions).toHaveLength(1)
})

test("rejects max_tokens with max_completion_tokens", () => {
  expect(() =>
    normalizeChatCompletionsRequest({
      model: "gpt-current",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      max_completion_tokens: 128,
    }),
  ).toThrow(LocalHTTPError)
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/chat-contract.test.ts`

Expected: module and typed fields do not exist.

- [ ] **Step 3: Implement immutable Chat normalization**

Clone the payload with `structuredClone`. Validate `messages` is a non-empty array and `model` is a non-empty string. Reject simultaneous token fields with `invalid_request_error` and `param:"max_tokens"`. Preserve string/array/null stop values. Normalize both modern function tools and deprecated functions only where their JSON schema needs the existing `{type:"object",properties:{}}` repair.

Keep existing assistant-prefill rewrite, attachment normalization, JSON-schema downgrade/instruction, stream usage, and prompt caching after the contract normalizer.

Normalize deprecated Chat functions before any endpoint translation:

- each `functions[]` entry becomes `{type:"function",function:{name,description,parameters}}` appended after existing modern tools;
- `function_call:"none"|"auto"` becomes the equivalent string `tool_choice`;
- `function_call:{name}` becomes `{type:"function",function:{name}}`;
- when both deprecated and modern controls are present, modern `tools`/`tool_choice` take precedence and deprecated fields are removed from the outbound clone;
- malformed deprecated entries return a safe local `invalid_request_error` rather than being forwarded.

Add tests proving direct Chat and Chat-to-Responses use the same normalized modern representation.

- [ ] **Step 4: Use the normalized clone in `createChatCompletions()`**

At entry:

```ts
const normalizedPayload = normalizeChatCompletionsRequest(payload)
```

Use `normalizedPayload` for every later mutation, dispatch, retry, and response-format decision. Do not mutate the caller's object.

- [ ] **Step 5: Run focused and live Chat tests**

```powershell
bun test tests/chat-contract.test.ts tests/create-chat-completions.test.ts tests/integration/chat-completions.test.ts tests/integration/tool-calling.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```powershell
git add src/routes/chat-completions/chat-contract.ts src/services/copilot/create-chat-completions.ts tests/chat-contract.test.ts tests/create-chat-completions.test.ts tests/integration/chat-completions.test.ts
git commit -m "fix: complete the Chat Completions contract"
```

### Task 5: Add Explicit Translation-Fidelity Checks

**Files:**
- Create: `src/routes/chat-completions/translation-fidelity.ts`
- Create: `src/routes/responses/translation-fidelity.ts`
- Modify: `src/routes/chat-completions/responses-fallback.ts`
- Modify: `src/routes/chat-completions/anthropic-bridge.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/lib/error.ts`
- Create: `tests/translation-fidelity.test.ts`
- Modify: `tests/chat-completions-responses-fallback.test.ts`
- Modify: `tests/responses-handler.test.ts`

**Interfaces:**
- Consumes: `TranslationCheck`, Chat/Responses payloads, and existing translators.
- Produces:

```ts
export function checkChatToResponsesTranslation(
  payload: ChatCompletionsPayload,
): TranslationCheck

export function checkChatToMessagesTranslation(
  payload: ChatCompletionsPayload,
): TranslationCheck

export function checkResponsesToChatTranslation(
  payload: ResponsesPayload,
): TranslationCheck

export function checkResponsesToMessagesTranslation(
  payload: ResponsesPayload,
): TranslationCheck

export function createEndpointTranslationError(
  failure: EndpointRouteFailure,
): LocalHTTPError
```

- [ ] **Step 1: Write failing translation-check tests**

Create `tests/translation-fidelity.test.ts`:

```ts
import { expect, test } from "bun:test"

import {
  checkChatToMessagesTranslation,
  checkChatToResponsesTranslation,
} from "~/routes/chat-completions/translation-fidelity"
import {
  checkResponsesToChatTranslation,
  checkResponsesToMessagesTranslation,
} from "~/routes/responses/translation-fidelity"

test("allows Chat to Responses with encrypted reasoning and structured tool output", () => {
  expect(checkChatToResponsesTranslation({
    model: "gpt-current",
    messages: [
      {
        role: "assistant",
        content: null,
        reasoning_text: "thinking",
        reasoning_opaque: "rs_1",
        encrypted_content: "encrypted",
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [{ type: "text", text: "done" }],
      },
    ],
  })).toEqual({ supported: true, blockers: [] })
})

test("rejects Chat to Messages when an OpenAI-only custom tool cannot map", () => {
  expect(checkChatToMessagesTranslation({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "custom", format: { type: "grammar" } } as never],
  })).toEqual({
    supported: false,
    blockers: ["custom_tool_grammar"],
  })
})

test("rejects Responses to Chat when opaque reasoning would be lost", () => {
  expect(checkResponsesToChatTranslation({
    model: "chat-only",
    input: [{
      type: "reasoning",
      encrypted_content: "encrypted",
      summary: [],
    }],
  })).toEqual({ supported: false, blockers: ["opaque_reasoning"] })
})

test("rejects Responses to Messages for item references and unsupported hosted tools", () => {
  expect(checkResponsesToMessagesTranslation({
    model: "claude-current",
    input: [{ type: "item_reference", id: "item_1" }],
    tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }],
  })).toEqual({
    supported: false,
    blockers: ["item_reference", "hosted_tool:file_search"],
  })
})
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/translation-fidelity.test.ts`

Expected: modules/functions do not exist; current translators silently drop several concepts.

- [ ] **Step 3: Implement deterministic blocker scans**

Create focused `translation-fidelity.ts` modules beside each route family. Scans must be pure and return unique blockers in input order. They must not transform data or read global state.

Required blockers:

- Chat to Responses: convert deprecated `functions` to modern function tools and deprecated `function_call` to `tool_choice` before checking; block unsupported message content part types and malformed tool-result pairing.
- Chat to Messages: OpenAI encrypted reasoning without a valid Anthropic signature mapping; custom/freeform grammar; hosted Responses-only tools; prediction fields without a Messages equivalent.
- Responses to Chat: opaque reasoning items; item references; namespace/custom/programmatic tool semantics that cannot be preserved; unsupported content phases; native context management.
- Responses to Messages: opaque OpenAI reasoning; unresolved item references; unsupported hosted tools; custom grammar; multi-agent configuration.

If a field is mapped in the translator during implementation, remove its blocker and add a round-trip test instead of leaving a stale conservative rejection.

- [ ] **Step 4: Implement one safe endpoint-translation error**

```ts
export function createEndpointTranslationError(
  failure: EndpointRouteFailure,
): LocalHTTPError {
  const concept = failure.blockers[0] ?? "request_shape"
  const clientBody = {
    error: {
      code: failure.code,
      message:
        "The selected Copilot model cannot accept this request without losing required protocol data.",
      param: concept,
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}
```

Do not include model IDs, tool names, encrypted contents, or raw field values in the message.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
bun test tests/translation-fidelity.test.ts tests/chat-completions-responses-fallback.test.ts tests/responses-handler.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```powershell
git add src/routes/chat-completions/translation-fidelity.ts src/routes/responses/translation-fidelity.ts src/routes/chat-completions/responses-fallback.ts src/routes/chat-completions/anthropic-bridge.ts src/routes/responses/handler.ts src/lib/error.ts tests/translation-fidelity.test.ts tests/chat-completions-responses-fallback.test.ts tests/responses-handler.test.ts
git commit -m "feat: reject lossy protocol translations"
```

### Task 6: Route Chat Through Native or Lossless Upstream Endpoints

**Files:**
- Modify: `src/routes/chat-completions/handler.ts:195-243`
- Modify: `src/routes/chat-completions/responses-fallback-executor.ts`
- Modify: `src/routes/chat-completions/anthropic-bridge.ts`
- Modify: `tests/chat-completions-responses-fallback.test.ts`
- Create: `tests/chat-endpoint-routing.test.ts`

**Interfaces:**
- Consumes: `getModelEndpointSupport()`, `selectCopilotEndpoint()`, `checkChatToResponsesTranslation()`, and `checkChatToMessagesTranslation()`.
- Produces:

```ts
export function selectChatUpstreamEndpoint(options: {
  payload: ChatCompletionsPayload
  selectedModel: Model | undefined
}): EndpointRouteDecision | EndpointRouteFailure
```

- [ ] **Step 1: Write the failing Chat route matrix**

Create table-driven tests in `tests/chat-endpoint-routing.test.ts`:

```ts
test.each([
  {
    name: "keeps an ordinary request on advertised Chat",
    endpoints: ["/chat/completions"],
    expected: "/chat/completions",
  },
  {
    name: "uses Responses for a Responses-only model",
    endpoints: ["/responses"],
    expected: "/responses",
  },
  {
    name: "uses Messages for a Messages-only Claude model",
    endpoints: ["/v1/messages"],
    expected: "/v1/messages",
  },
  {
    name: "prefers Messages for PDF content when Chat and Messages exist",
    endpoints: ["/chat/completions", "/v1/messages"],
    pdf: true,
    expected: "/v1/messages",
  },
  {
    name: "prefers Responses for hosted web search when available",
    endpoints: ["/chat/completions", "/responses"],
    webSearch: true,
    expected: "/responses",
  },
])("$name", async ({ endpoints, expected, pdf, webSearch }) => {
  installModel({ id: "route-model", supported_endpoints: endpoints })
  const response = await postChatRoute({ pdf, webSearch })
  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe(expected)
})
```

Add a Messages-only model with an unsupported custom grammar and assert local 400 plus `fetchMock` not called.

- [ ] **Step 2: Run route tests and verify RED**

Run: `bun test tests/chat-endpoint-routing.test.ts`

Expected: Messages-only ordinary Chat requests currently fall through to `/chat/completions`; lossy cases are not rejected centrally.

- [ ] **Step 3: Implement `selectChatUpstreamEndpoint()`**

Candidate order:

1. Native Chat when advertised and payload has no requirement that Chat cannot carry.
2. Messages when advertised and either Chat is unavailable or the payload has PDF/Anthropic-native requirements.
3. Responses when advertised and either Chat is unavailable or the payload has hosted web-search/OpenAI-native requirements.
4. Remaining lossless advertised translation.

For an ordinary model advertising both Chat and native APIs, retain Chat unless a payload requirement or endpoint deprecation forces migration; this preserves current client behavior while making endpoint metadata authoritative.

- [ ] **Step 4: Dispatch the route decision**

Replace the conditional chain in `dispatchCopilotCompletion()` with a switch on `decision.target`. Use existing executors. If the result is a failure, throw `createEndpointTranslationError()` before manual approval or upstream dispatch.

Record one existing `endpoint_fallback` non-default behavior event only when `translated === true`.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
bun test tests/chat-endpoint-routing.test.ts tests/chat-completions-responses-fallback.test.ts tests/create-chat-completions.test.ts tests/integration/chat-completions.test.ts tests/integration/tool-calling.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```powershell
git add src/routes/chat-completions/handler.ts src/routes/chat-completions/responses-fallback-executor.ts src/routes/chat-completions/anthropic-bridge.ts tests/chat-endpoint-routing.test.ts tests/chat-completions-responses-fallback.test.ts
git commit -m "feat: route Chat by model endpoint support"
```

### Task 7: Route Responses Through Native, Messages, or Chat Without Loss

**Files:**
- Modify: `src/routes/responses/handler.ts:434-570,1033-1121,1522-1770`
- Create: `src/routes/responses/messages-bridge.ts`
- Create: `src/routes/chat-completions/anthropic-conversion.ts`
- Modify: `src/routes/chat-completions/anthropic-bridge.ts`
- Create: `tests/responses-messages-bridge.test.ts`
- Create: `tests/responses-endpoint-routing.test.ts`
- Modify: `tests/responses-handler.test.ts`
- Modify: `tests/integration/responses.test.ts`

**Interfaces:**
- Consumes: endpoint support/selection, Responses translation checks, existing Chat translator, and native Messages transport/response adapters.
- Produces:

```ts
export function selectResponsesUpstreamEndpoint(options: {
  payload: ResponsesPayload
  selectedModel: Model | undefined
}): EndpointRouteDecision | EndpointRouteFailure

export async function responsesPayloadToAnthropic(
  payload: ResponsesPayload,
  signal?: AbortSignal,
): Promise<AnthropicMessagesPayload>

export function anthropicResponseToResponsesResult(
  response: AnthropicResponse,
  requestedModel: string,
): ResponsesResult

// Extracted from anthropic-bridge.ts and shared by both bridges.
export async function convertOpenAIContentPartToAnthropic(
  part: ContentPart,
  signal?: AbortSignal,
): Promise<Array<AnthropicUserContentBlock>>

export function convertOpenAIToolsToAnthropic(
  tools: ChatCompletionsPayload["tools"],
): Pick<AnthropicMessagesPayload, "tools">
```

- [ ] **Step 1: Write failing Responses-to-Messages bridge tests**

Cover the supported subset:

```ts
test("maps text image document function tools and results to Messages", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    instructions: "Be concise.",
    max_output_tokens: 512,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Summarize" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" },
          { type: "input_file", filename: "doc.pdf", file_data: "data:application/pdf;base64,AA==" },
        ],
      },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
    tools: [{
      type: "function",
      name: "lookup",
      description: "Lookup",
      parameters: { type: "object", properties: {} },
      strict: false,
    }],
    tool_choice: "auto",
  })
  expect(payload).toMatchObject({
    model: "claude-current",
    max_tokens: 512,
    system: "Be concise.",
  })
  expect(JSON.stringify(payload)).toContain("tool_use")
  expect(JSON.stringify(payload)).toContain("tool_result")
  expect(JSON.stringify(payload)).toContain("document")
})
```

Add response conversion tests for text, thinking/signature, tool use, usage/cache fields, stop reasons, and requested model alias.

- [ ] **Step 2: Run bridge tests and verify RED**

Run: `bun test tests/responses-messages-bridge.test.ts`

Expected: module does not exist.

- [ ] **Step 3: Extract shared Anthropic conversion and implement the narrow bridge**

Move the generic OpenAI content/image/document/tool conversion helpers from `anthropic-bridge.ts` into `src/routes/chat-completions/anthropic-conversion.ts` with the exact public interfaces above. Keep Chat-specific message ordering and response adaptation in `anthropic-bridge.ts`. Both Chat-to-Messages and Responses-to-Messages must import the shared helpers; do not duplicate attachment fetching, data-URI conversion, tool schema conversion, or tool-result content conversion.

The bridge must refuse unsupported payloads before conversion via `checkResponsesToMessagesTranslation()`. It buffers native Messages when the client requested a Responses stream, then emits the existing synthetic Responses event lifecycle from the converted result. This plan does not require a streaming event-by-event Anthropic-to-Responses adapter.

- [ ] **Step 4: Write the failing Responses route matrix**

Cover:

- Responses-only -> `/responses`;
- Chat-only/missing metadata -> `/chat/completions` when lossless;
- Messages-only -> `/v1/messages` when lossless;
- Messages plus Chat with a PDF -> `/v1/messages`;
- no supported endpoint -> local `endpoint_translation_unsupported`;
- Messages-only plus opaque reasoning -> local 400 and no upstream call.

- [ ] **Step 5: Implement route selection**

Candidate order:

1. Native Responses.
2. Messages for Messages-supported, lossless payloads.
3. Chat for Chat-supported, lossless payloads.

Do not convert a native Responses request merely because another endpoint is also advertised. Preserve existing web-search and apply-patch conversion only on the Chat fallback branch.

- [ ] **Step 6: Run focused and live tests**

```powershell
bun test tests/responses-messages-bridge.test.ts tests/responses-endpoint-routing.test.ts tests/responses-handler.test.ts tests/integration/responses.test.ts tests/integration/tool-calling.test.ts
```

Expected: PASS. Live Messages-only coverage runs only if the authenticated model catalog advertises such a model; otherwise the deterministic route fixture provides coverage.

- [ ] **Step 7: Commit Task 7**

```powershell
git add src/routes/responses/handler.ts src/routes/responses/messages-bridge.ts src/routes/chat-completions/anthropic-conversion.ts src/routes/chat-completions/anthropic-bridge.ts tests/responses-messages-bridge.test.ts tests/responses-endpoint-routing.test.ts tests/responses-handler.test.ts tests/integration/responses.test.ts
git commit -m "feat: route Responses without protocol loss"
```

### Task 8: Verify Responses and Chat as an Independent Deliverable

**Files:**
- Verify only.

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: a clean Responses/Chat parity layer ready for Messages and WebSocket plans.

- [ ] **Step 1: Run the full focused protocol suite**

```powershell
bun test tests/responses-contract.test.ts tests/responses-request-normalization.test.ts tests/create-responses.test.ts tests/responses-payload-recovery.test.ts tests/responses-handler.test.ts tests/responses-translation.test.ts tests/responses-stream-translation.test.ts tests/chat-contract.test.ts tests/create-chat-completions.test.ts tests/chat-completions-responses-fallback.test.ts tests/translation-fidelity.test.ts tests/chat-endpoint-routing.test.ts tests/responses-messages-bridge.test.ts tests/responses-endpoint-routing.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run live protocol tests**

```powershell
bun test tests/integration/chat-completions.test.ts tests/integration/responses.test.ts tests/integration/tool-calling.test.ts tests/integration/per-model.test.ts
```

Expected: available live Chat and Responses models pass. Feature-gated tools are not probed.

- [ ] **Step 3: Run static checks**

```powershell
bun run typecheck
bun run lint -- src/services/copilot/responses-contract.ts src/services/copilot/create-responses.ts src/routes/chat-completions/chat-contract.ts src/services/copilot/create-chat-completions.ts src/routes/chat-completions/translation-fidelity.ts src/routes/responses/translation-fidelity.ts src/routes/chat-completions/handler.ts src/routes/responses/handler.ts src/routes/responses/messages-bridge.ts tests/responses-contract.test.ts tests/chat-contract.test.ts tests/translation-fidelity.test.ts tests/chat-endpoint-routing.test.ts tests/responses-messages-bridge.test.ts tests/responses-endpoint-routing.test.ts
bun run build
git diff --check
```

Expected: exit 0 with no new warnings.

- [ ] **Step 4: Verify pinned Bun media coverage when media code moved**

If this plan changes media normalization/recovery files, run the repository's pinned Bun 1.4.0 command used by the existing payload-recovery workflow for:

```powershell
bun test tests/responses-webp-normalization.test.ts tests/responses-payload-recovery.test.ts tests/create-responses-payload-recovery.test.ts
```

Expected: real WebP, PNG re-encoding, and incident-shaped recovery tests pass without skips.
