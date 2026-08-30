# Native Messages Cache-Control Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize every native Anthropic Messages cache marker using GitHub Copilot's supported `{ type, ttl? }` wire contract without message-specific cases or input mutation.

**Architecture:** Keep the existing top-level native Messages allowlist, then apply one JSON serializer replacer at the provider boundary. The replacer recognizes only properties named `cache_control` whose value is an ephemeral marker, reconstructs the supported wire object, and leaves every other value unchanged. Exercise this through `createAnthropicMessages` so the regression test validates the real routed fetch body.

**Tech Stack:** Bun 1.4.0, TypeScript, Bun test runner, native Anthropic Messages compatibility layer.

---

## File Structure

- Modify `src/services/copilot/create-anthropic-messages.ts`: add the provider-contract serializer and use it for the routed `/v1/messages` body.
- Create `tests/create-anthropic-messages.test.ts`: capture the physical fetch body and verify recursive normalization, supported TTL handling, unrelated-object preservation, and non-mutation.
- Keep `docs/superpowers/specs/2026-07-29-native-cache-control-compatibility-design.md` and this plan in the PR as the approved rationale and execution record.

### Task 1: Prove the native Messages cache-control regression

**Files:**
- Create: `tests/create-anthropic-messages.test.ts`
- Inspect: `src/services/copilot/create-anthropic-messages.ts:71-108,150-176`

- [ ] **Step 1: Add a focused fetch-capture test harness**

Create `tests/create-anthropic-messages.test.ts` with Bun lifecycle hooks that replace `globalThis.fetch`, capture the parsed request body, and return a valid non-streaming Anthropic response:

```ts
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { state } from "../src/lib/state"
import { createAnthropicMessages } from "../src/services/copilot/create-anthropic-messages"

const originalFetch = globalThis.fetch
let capturedBody: unknown

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected native Messages JSON body")
  }
  capturedBody = JSON.parse(init.body) as unknown
  return new Response(
    JSON.stringify({
      id: "msg_cache_control",
      type: "message",
      role: "assistant",
      model: "claude-opus-4.8",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  capturedBody = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
})
```

- [ ] **Step 2: Add the exact recursive compatibility regression**

Add one test whose payload contains cache markers in system, message, nested tool-result, and tool locations. Include `scope` and extra keys, valid `5m`/`1h` TTL values, an unsupported TTL, and an unrelated object that happens to use `type: "ephemeral"`:

```ts
test("serializes native cache controls using Copilot's supported wire shape", async () => {
  const payload = {
    model: "claude-opus-4.8",
    max_tokens: 64,
    system: [
      { type: "text", text: "base" },
      {
        type: "text",
        text: "scoped",
        cache_control: { type: "ephemeral", scope: "global" },
      },
      {
        type: "text",
        text: "long lived",
        cache_control: {
          type: "ephemeral",
          ttl: "1h",
          scope: "global",
          client_hint: true,
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: {
              type: "ephemeral",
              ttl: "unsupported",
              scope: "global",
            },
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              {
                type: "text",
                text: "result",
                cache_control: {
                  type: "ephemeral",
                  ttl: "5m",
                  scope: "global",
                },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      {
        name: "run",
        input_schema: {
          type: "object",
          metadata: { type: "ephemeral", scope: "global" },
        },
        cache_control: { type: "ephemeral", scope: "global" },
      },
    ],
  } as unknown as AnthropicMessagesPayload
  const originalPayload = structuredClone(payload)

  await createAnthropicMessages(payload)

  expect(payload).toEqual(originalPayload)
  expect(capturedBody).toEqual({
    model: "claude-opus-4.8",
    max_tokens: 64,
    system: [
      { type: "text", text: "base" },
      {
        type: "text",
        text: "scoped",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "long lived",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: { type: "ephemeral" },
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              {
                type: "text",
                text: "result",
                cache_control: { type: "ephemeral", ttl: "5m" },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      {
        name: "run",
        input_schema: {
          type: "object",
          metadata: { type: "ephemeral", scope: "global" },
        },
        cache_control: { type: "ephemeral" },
      },
    ],
  })
})
```

- [ ] **Step 3: Run the regression and verify RED**

Run:

```powershell
bun test tests/create-anthropic-messages.test.ts
```

Expected: FAIL because the captured body still includes `scope`, `client_hint`, and the unsupported TTL. Confirm the input non-mutation assertion already passes; the failure must be the forwarded wire shape.

### Task 2: Implement one generic provider-boundary serializer

**Files:**
- Modify: `src/services/copilot/create-anthropic-messages.ts:67-108,161-168`
- Test: `tests/create-anthropic-messages.test.ts`

- [ ] **Step 1: Define the supported cache marker contract**

Add these local helpers immediately before `sanitizeMessagesPayload`:

```ts
type NativeCacheControl = {
  type: "ephemeral"
  ttl?: "5m" | "1h"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serializeMessagesPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (key, value: unknown) => {
    if (
      key !== "cache_control"
      || !isRecord(value)
      || value.type !== "ephemeral"
    ) {
      return value
    }

    const cacheControl: NativeCacheControl = { type: "ephemeral" }
    if (value.ttl === "5m" || value.ttl === "1h") {
      cacheControl.ttl = value.ttl
    }
    return cacheControl
  })
}
```

This helper is deliberately private and dependency-free. It reconstructs only an actual `cache_control` property, so unrelated objects with the same `type` value are preserved.

- [ ] **Step 2: Apply the serializer only at the native Messages fetch boundary**

Change the routed fetch body from:

```ts
body: JSON.stringify(body),
```

to:

```ts
body: serializeMessagesPayload(body),
```

Do not change `sanitizeMessagesPayload`, routing, headers, retry behavior, or the object stored on `HTTPError`.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```powershell
bun test tests/create-anthropic-messages.test.ts
```

Expected: PASS with one fetch and all wire-shape/non-mutation assertions green.

- [ ] **Step 4: Run adjacent native-route compatibility tests**

Run:

```powershell
bun test tests/messages-handler.test.ts tests/messages-stream-lifecycle.test.ts tests/vision-attachments.test.ts
```

Expected: PASS. ToolSearch routing, PDF routing, attachment normalization, stream heartbeats, and ordinary tool-result behavior remain unchanged.

- [ ] **Step 5: Commit the implementation**

Stage only the implementation and regression test:

```powershell
git add -- src/services/copilot/create-anthropic-messages.ts tests/create-anthropic-messages.test.ts
git diff --cached --check
git commit -m "normalize native Messages cache controls"
```

### Task 3: Verify scope and repository health

**Files:**
- Verify: `src/services/copilot/create-anthropic-messages.ts`
- Verify: `tests/create-anthropic-messages.test.ts`
- Inspect only: `src/routes/messages/handler.ts`
- Inspect only: `src/routes/messages/stream-translation.ts`
- Inspect only: `src/services/copilot/transport-retry.ts`

- [ ] **Step 1: Verify no excluded behavior changed**

Run:

```powershell
git diff origin/master -- src/routes/messages/handler.ts src/routes/messages/stream-translation.ts src/services/copilot/transport-retry.ts
```

Expected: no diff. There must be no ToolSearch branch, stream replay, Sentry suppression, or retry-budget change.

- [ ] **Step 2: Run static checks and build**

Run:

```powershell
bun run typecheck
bun run lint
bun run build
git diff origin/master --check
```

Expected: typecheck and build pass; lint has zero errors (report existing warnings separately); diff check is clean.

- [ ] **Step 3: Run the full repository suite**

Run:

```powershell
bun test
```

Expected: all tests pass with zero failures. Record the final count in the PR description.

- [ ] **Step 4: Review the complete branch diff**

Run:

```powershell
git status -sb
git diff --stat origin/master...HEAD
git diff origin/master...HEAD -- docs/superpowers/specs/2026-07-29-native-cache-control-compatibility-design.md docs/superpowers/plans/2026-07-29-native-cache-control-compatibility.md src/services/copilot/create-anthropic-messages.ts tests/create-anthropic-messages.test.ts
```

Expected: the approved spec, plan, one source file, and one focused test file only.

### Task 4: Publish a draft pull request

**Files:**
- No additional source changes

- [ ] **Step 1: Confirm GitHub authentication and clean branch state**

Run:

```powershell
gh auth status
git status -sb
```

Expected: authenticated as the repository owner and a clean `codex/fix-native-cache-control` branch.

- [ ] **Step 2: Push the branch**

Run:

```powershell
git push -u origin codex/fix-native-cache-control
```

- [ ] **Step 3: Open a draft PR against `master`**

Use title:

```text
[codex] normalize native Messages cache controls
```

The PR body must explain the generic provider-boundary normalization, cite the Claude Code 2.1.220 scoped marker and Copilot `{type, ttl?}` contract, state that stream-reset behavior was intentionally unchanged, and list focused/full verification results.

- [ ] **Step 4: Verify remote state**

Run:

```powershell
gh pr view --json number,title,url,isDraft,state,baseRefName,headRefName,headRefOid,statusCheckRollup
```

Expected: open draft PR targeting `master`; remote head SHA matches local `HEAD`.

## Self-Review

- Spec coverage: recursive provider-boundary normalization, supported TTL preservation, unrelated-object preservation, non-mutation, no stream change, full verification, and draft publication all have explicit tasks.
- Placeholder scan: no TBD/TODO or unspecified implementation step remains.
- Type consistency: `NativeCacheControl`, serializer input/output, test payload, and expected Copilot wire values consistently use `type: "ephemeral"` with optional `"5m" | "1h"` TTL.
