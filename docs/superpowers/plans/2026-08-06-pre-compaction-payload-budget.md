# Pre-compaction Payload Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent GitHub Copilot's upstream 413 from blocking first/manual compaction turns by fitting only oversized compaction payloads below 30 MiB while preserving conversational state and tool semantics.

**Architecture:** Add immutable, dialect-aware compaction reducers beside the Copilot transport. They detect Codex compaction metadata, elide inline attachment bytes, truncate the largest tool-result text first, and raise a safe local typed 413 if preserved content alone cannot fit. The Responses, ChatCompletions, and native Messages transports each enforce their exact sanitized post-normalization payload; HTTP, WebSocket, and `/responses/compact` also pre-fit shared input before endpoint fallback.

**Tech Stack:** TypeScript, Bun test runner, Hono, existing `HTTPError`, Responses WebSocket continuation snapshots.

---

## File Structure

- Create `src/services/copilot/compaction-payload.ts`: compaction detection, UTF-8 byte measurement, immutable attachment elision, largest-first tool-output truncation, and local 413 construction.
- Create `tests/responses-compaction-payload.test.ts`: focused reducer and metadata tests using small injected budgets.
- Modify `src/services/copilot/create-responses.ts`: identify compaction turns and enforce the final sanitized payload budget after attachment normalization.
- Modify `src/services/copilot/create-chat-completions.ts`: enforce the final fallback payload and reuse the fitted body across image and overload retries.
- Modify `src/services/copilot/create-anthropic-messages.ts`: enforce the final native Messages payload.
- Modify `src/routes/responses/handler.ts` and `src/routes/responses/websocket.ts`: pre-fit before endpoint fallback and preserve otherwise-unrepresentable custom tool context on compaction turns.
- Modify `src/routes/responses/compact-handler.ts`: pre-fit the summary request and explicitly mark the native transport call as compaction.
- Modify `src/lib/error.ts`: expose only the deterministic safe local 413 envelope while retaining upstream error redaction.
- Modify `tests/responses-websocket.test.ts`: reproduce a greater-than-32-MiB rehydrated WebSocket compaction request.
- Modify `tests/responses-compact-affinity.test.ts`: prove `/responses/compact` fits an oversized tool result before the mocked upstream call.
- Modify `docs/superpowers/specs/2026-08-06-pre-compaction-payload-budget-design.md`: record final transport-boundary enforcement.

### Task 1: Build the immutable payload reducer with TDD

**Files:**
- Create: `tests/responses-compaction-payload.test.ts`
- Create: `src/services/copilot/compaction-payload.ts`

- [ ] **Step 1: Write metadata and no-op tests**

```ts
import { expect, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import {
  fitResponsesCompactionPayload,
  isResponsesCompactionRequest,
} from "../src/services/copilot/compaction-payload"

test("detects object and JSON-string Codex compaction metadata", () => {
  const turn = JSON.stringify({ request_kind: "compaction" })
  expect(
    isResponsesCompactionRequest({
      model: "gpt-5.6-sol",
      client_metadata: { "x-codex-turn-metadata": turn },
    }),
  ).toBe(true)
  expect(
    isResponsesCompactionRequest({
      model: "gpt-5.6-sol",
      client_metadata: JSON.stringify({ "x-codex-turn-metadata": turn }),
    }),
  ).toBe(true)
  expect(
    isResponsesCompactionRequest({
      model: "gpt-5.6-sol",
      client_metadata: { "x-codex-turn-metadata": "not json" },
    }),
  ).toBe(false)
})

test("returns the original small payload without mutation", () => {
  const payload = { model: "gpt-5.6-sol", input: "hello" }
  const result = fitResponsesCompactionPayload(payload, 1024)
  expect(result.payload).toBe(payload)
  expect(result.reduced).toBe(false)
})
```

- [ ] **Step 2: Write attachment, truncation, ordering, UTF-8, and failure tests**

Use a payload containing an inline `input_image`, a preserved `custom_tool_call`, a large `custom_tool_call_output`, and a small `function_call_output`. Assert the fitted serialization is within the injected budget; the original remains untouched; IDs, call IDs, command input, prefix, suffix, order, and small result survive; the data URI disappears; the omission marker and reduction counters appear; and no replacement character is introduced. Add a preserved-text-only payload and assert `HTTPError.response.status === 413`.

```ts
const payload = {
  model: "gpt-5.6-sol",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "keep neighboring text" },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${"a".repeat(2048)}`,
          detail: "high",
        },
      ],
    },
    {
      type: "custom_tool_call",
      call_id: "call_large",
      name: "exec",
      input: "run the canonical command",
    },
    {
      type: "custom_tool_call_output",
      call_id: "call_large",
      output: `BEGIN🙂${"x".repeat(7000)}🙂END`,
    },
    {
      type: "function_call_output",
      call_id: "call_small",
      output: "small result stays exact",
    },
  ],
}
const original = structuredClone(payload)
const result = fitResponsesCompactionPayload(payload, 2400)
const serialized = JSON.stringify(result.payload)
expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(2400)
expect(payload).toEqual(original)
expect(serialized).toContain("run the canonical command")
expect(serialized).toContain("BEGIN🙂")
expect(serialized).toContain("🙂END")
expect(serialized).toContain("small result stays exact")
expect(serialized).toContain("UTF-8 bytes omitted during compaction")
expect(serialized).not.toContain("data:image/png;base64")
expect(serialized).not.toContain("�")
expect(result.omittedBinaryBlocks).toBe(1)
expect(result.truncatedToolOutputBytes).toBeGreaterThan(0)
```

- [ ] **Step 3: Run the focused test and verify RED**

Run: `bun test tests/responses-compaction-payload.test.ts`

Expected: FAIL because `src/services/copilot/compaction-payload.ts` does not exist.

- [ ] **Step 4: Implement the reducer**

Implement these public contracts:

```ts
export const COMPACTION_PAYLOAD_MAX_BYTES = 30 * 1024 * 1024

export interface CompactionPayloadFitResult<T> {
  payload: T
  originalBytes: number
  finalBytes: number
  omittedBinaryBlocks: number
  truncatedToolOutputBytes: number
  reduced: boolean
}

export function isResponsesCompactionRequest(
  payload: ResponsesPayload,
): boolean

export function fitResponsesCompactionPayload<
  T extends Record<string, unknown>,
>(payload: T, maxBytes = COMPACTION_PAYLOAD_MAX_BYTES): CompactionPayloadFitResult<T>
```

Implementation requirements:

- measure with `Buffer.byteLength(JSON.stringify(payload), "utf8")`;
- return the original reference when already within budget;
- clone with `structuredClone` before any reduction;
- replace only inline `input_image.image_url` and `input_file.file_data` blocks with valid `input_text` omission notes;
- collect text slots only beneath `function_call_output.output` and `custom_tool_call_output.output`;
- sort slots by UTF-8 byte length descending;
- retain at least a 512-byte prefix and 512-byte suffix when possible;
- use fatal UTF-8 decoding when slicing buffers so boundaries remain valid;
- account for JSON escaping by measuring `JSON.stringify(candidateText)` while choosing the largest retained text that fits; and
- throw an `HTTPError` backed by a local JSON `Response` with status 413 and code `compaction_payload_too_large` when safe reductions are exhausted.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `bun test tests/responses-compaction-payload.test.ts`

Expected: all reducer tests pass.

- [ ] **Step 6: Commit the reducer**

```powershell
git add src/services/copilot/compaction-payload.ts tests/responses-compaction-payload.test.ts
git commit -m "fit oversized compaction payloads"
```

### Task 2: Enforce the budget at the exact transport boundary

**Files:**
- Modify: `src/services/copilot/create-responses.ts:580-584`
- Modify: `src/services/copilot/create-responses.ts:814-880`
- Test: `tests/create-responses.test.ts`

- [ ] **Step 1: Add a focused transport test**

Add a test that calls `createResponses` with `compaction: true` and an oversized tool output, then asserts the mocked fetch body is within the production limit and preserves the command and both ends of the result. The call must still return the existing successful mocked Responses result.

- [ ] **Step 2: Run the transport test and verify RED**

Run: `bun test tests/create-responses.test.ts`

Expected: FAIL because `ResponsesRequestOptions` does not accept or enforce `compaction`.

- [ ] **Step 3: Add final sanitized-payload enforcement**

Extend the private request options and prepare the outbound body through one helper:

```ts
interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
  signal?: AbortSignal
  compaction?: boolean
}

const shouldFitCompactionPayload =
  compaction || isResponsesCompactionRequest(payload)

const prepareSanitizedPayload = () => {
  const sanitized = sanitizeResponsesPayload(payload)
  if (!shouldFitCompactionPayload) return sanitized
  const fitted = fitResponsesCompactionPayload(sanitized)
  if (fitted.reduced) {
    consola.warn("Reduced oversized Responses compaction payload", {
      originalBytes: fitted.originalBytes,
      finalBytes: fitted.finalBytes,
      omittedBinaryBlocks: fitted.omittedBinaryBlocks,
      truncatedToolOutputBytes: fitted.truncatedToolOutputBytes,
    })
  }
  return fitted.payload
}
```

Call it after attachment normalization/default injection/sanitization and again on the existing vision retry. Do not apply it to ordinary requests.

- [ ] **Step 4: Run transport and reducer tests**

Run: `bun test tests/create-responses.test.ts tests/responses-compaction-payload.test.ts`

Expected: both files pass.

- [ ] **Step 5: Commit transport enforcement**

```powershell
git add src/services/copilot/create-responses.ts tests/create-responses.test.ts
git commit -m "enforce compaction budget before upstream"
```

### Task 3: Cover WebSocket rehydration and `/responses/compact`

**Files:**
- Modify: `src/routes/responses/compact-handler.ts:220-285`
- Modify: `tests/responses-websocket.test.ts:980-1077`
- Modify: `tests/responses-compact-affinity.test.ts`

- [ ] **Step 1: Add the greater-than-32-MiB WebSocket regression**

Store a response snapshot whose input contains a `custom_tool_call` and a `custom_tool_call_output` larger than 32 MiB. Send a tiny continuation with `previous_response_id` and `x-codex-turn-metadata` containing `request_kind: "compaction"`. Assert the final mocked fetch body is within `COMPACTION_PAYLOAD_MAX_BYTES`; preserves the command, call IDs, prefix, suffix, and omission marker; and does not mutate the original large output.

- [ ] **Step 2: Run the WebSocket test and verify RED**

Run: `bun test tests/responses-websocket.test.ts`

Expected: FAIL because the rehydrated body remains above 30 MiB.

- [ ] **Step 3: Add `/responses/compact` pre-fitting and its endpoint regression**

Construct the full `responsesPayload` before endpoint selection, call `fitResponsesCompactionPayload`, and use its fitted input for native Responses and ChatCompletions conversion. Pass `compaction: true` to `createResponses` for final post-normalization enforcement. Extend the compact endpoint fetch mock to capture its body and add an oversized tool-result request asserting status 200, body size at most 30 MiB, and preserved command/call IDs/prefix/suffix.

- [ ] **Step 4: Run all compaction-focused tests**

Run:

```powershell
bun test tests/responses-compaction-payload.test.ts tests/create-responses.test.ts tests/responses-utils.test.ts tests/responses-websocket.test.ts tests/responses-compact-affinity.test.ts
```

Expected: all focused tests pass, including existing post-marker bootstrap retention.

- [ ] **Step 5: Commit protocol integrations**

```powershell
git add src/routes/responses/compact-handler.ts tests/responses-websocket.test.ts tests/responses-compact-affinity.test.ts
git commit -m "cover pre-compaction protocol paths"
```

### Task 4: Verify, review, and publish

**Files:**
- Modify if needed: files from Tasks 1-3 only

- [ ] **Step 1: Run focused lint and type checking**

```powershell
bun run lint -- src/services/copilot/compaction-payload.ts src/services/copilot/create-responses.ts src/routes/responses/compact-handler.ts tests/responses-compaction-payload.test.ts tests/create-responses.test.ts tests/responses-websocket.test.ts tests/responses-compact-affinity.test.ts
bun run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run the complete verification suite**

```powershell
bun test
bun run build
git diff --check origin/master...HEAD
```

Expected: 0 test failures and every command exits 0.

- [ ] **Step 3: Review the complete diff**

Inspect `git diff --stat origin/master...HEAD`, `git diff origin/master...HEAD`, and ensure only the approved spec, plan, reducer, transport integration, compact-handler integration, and tests are present. Confirm no generated `ui/bun.lock` is tracked.

- [ ] **Step 4: Request independent review**

Use the requesting-code-review workflow against the current merge-base with `origin/master` and the final HEAD. Address every Critical or Important finding and rerun the relevant verification.

- [ ] **Step 5: Push and open a draft PR**

```powershell
git push -u origin codex/fix-pre-compaction-413
gh pr create --draft --base master --head codex/fix-pre-compaction-413 --title "[codex] fit oversized pre-compaction payloads" --body-file <prepared-markdown-file>
```

The PR body must explain the pre-marker root cause, final transport enforcement, preservation guarantees, local 413 behavior, and exact verification commands/results.
