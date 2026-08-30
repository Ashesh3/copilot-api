# Ordinary Responses Payload Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent ordinary native CAPI Responses turns from exceeding the 32 MiB serialized request limit by mirroring Copilot Runtime's image-downscale and binary-removal recovery without truncating ordinary text.

**Architecture:** Add an immutable asynchronous Responses recovery utility that measures the exact sanitized JSON body, uses Bun 1.4.0's built-in image codecs to shrink inline images toward the 32 MiB-minus-64 KiB recovery target, then replaces historical and finally current inline binaries with explicit breadcrumbs if necessary. Integrate it at `createResponses`, the shared final HTTP/WebSocket transport boundary, while leaving PR #51's 30 MiB compaction reducer unchanged.

**Tech Stack:** TypeScript, Bun 1.4.0 `Bun.Image`, Bun test runner, existing Responses transport and `LocalHTTPError`.

---

## File Structure

- Create `src/services/copilot/responses-payload-recovery.ts`: exact byte accounting, current-turn classification, recursive binary discovery, Bun image resizing, historical/current removal, safe local 413, and recovery statistics.
- Create `tests/responses-payload-recovery.test.ts`: small-budget unit tests for immutable planning plus a Bun 1.4.0 image-codec integration test.
- Modify `src/services/copilot/create-responses.ts`: asynchronously recover ordinary sanitized Responses payloads before first dispatch and remove the nested-image-blind post-413 retry.
- Modify `tests/create-responses.test.ts`: cover final-transport recovery, one-dispatch behavior, unchanged small requests, and safe local failure.
- Modify `tests/responses-websocket.test.ts`: reproduce an oversized ordinary rehydrated continuation and assert the single upstream body is below the CAPI cap.
- Modify `docs/superpowers/specs/2026-08-07-ordinary-responses-payload-recovery-design.md`: retain the reviewed 32 MiB hard cap plus 64 KiB recovery margin correction.

### Task 1: Build immutable ordinary-turn recovery with TDD

**Files:**
- Create: `tests/responses-payload-recovery.test.ts`
- Create: `src/services/copilot/responses-payload-recovery.ts`

- [ ] **Step 1: Write failing no-op and downscale tests**

Create tests using a small injected byte budget and a deterministic fake image resizer:

```ts
import { expect, test } from "bun:test"

import {
  recoverResponsesPayload,
  type ResponsesImageResizer,
} from "~/services/copilot/responses-payload-recovery"

const tinyImage = (size: number) =>
  `data:image/png;base64,${"A".repeat(size)}`

const shrinkToTarget: ResponsesImageResizer = async ({
  dataUri,
  targetDataUriBytes,
}) => dataUri.slice(0, targetDataUriBytes)

test("returns the original ordinary payload when it is within the hard cap", async () => {
  const payload = { model: "gpt-5.6-sol", input: "hello" }
  const result = await recoverResponsesPayload(payload, {
    maxBytes: 1024,
    recoveryMarginBytes: 64,
    resizeImage: shrinkToTarget,
  })
  expect(result.payload).toBe(payload)
  expect(result.reduced).toBe(false)
})

test("downscales nested tool-result images before removing them", async () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [{
      type: "function_call_output",
      call_id: "call_image",
      output: [{ type: "input_image", image_url: tinyImage(4000) }],
    }],
  }
  const original = structuredClone(payload)
  const result = await recoverResponsesPayload(payload, {
    maxBytes: 1800,
    recoveryMarginBytes: 100,
    resizeImage: shrinkToTarget,
  })
  expect(result.finalBytes).toBeLessThanOrEqual(1700)
  expect(result.downscaledImages).toBe(1)
  expect(result.removedHistoricalBinaries).toBe(0)
  expect(JSON.stringify(result.payload)).toContain("data:image/png;base64")
  expect(payload).toEqual(original)
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test tests/responses-payload-recovery.test.ts`

Expected: FAIL because `responses-payload-recovery.ts` and its exports do not exist.

- [ ] **Step 3: Add the recovery API, exact byte accounting, and recursive image slots**

Implement these public contracts:

```ts
export const CAPI_RESPONSES_MAX_REQUEST_BYTES = 32 * 1024 * 1024
export const RESPONSES_RECOVERY_MARGIN_BYTES = 64 * 1024

export interface ResponsesImageResizeInput {
  dataUri: string
  mediaType: string
  signal?: AbortSignal
  targetDataUriBytes: number
}

export type ResponsesImageResizeResult =
  | { dataUri: string; outcome: "resized" }
  | { outcome: "invalid" | "unshrinkable" }

export type ResponsesImageResizer = (
  input: ResponsesImageResizeInput,
) => Promise<ResponsesImageResizeResult>

export interface ResponsesPayloadRecoveryResult<T> {
  payload: T
  originalBytes: number
  finalBytes: number
  downscaledImages: number
  removedHistoricalBinaries: number
  removedCurrentBinaries: number
  reduced: boolean
}

export async function recoverResponsesPayload<T extends object>(
  payload: T,
  options: {
    maxBytes?: number
    recoveryMarginBytes?: number
    resizeImage?: ResponsesImageResizer
    signal?: AbortSignal
  } = {},
): Promise<ResponsesPayloadRecoveryResult<T>>
```

Implementation requirements:

- measure with `Buffer.byteLength(JSON.stringify(payload), "utf8")`;
- return the original reference when `originalBytes <= maxBytes`;
- clone once with `structuredClone` before mutation;
- recursively collect only `input_image.image_url` and `computer_screenshot.image_url` data URIs beneath `input`;
- compute `nonImageBytes = originalBytes - sum(dataUri UTF-8 bytes)`;
- compute the shared per-image data-URI target from `maxBytes - recoveryMarginBytes - nonImageBytes`;
- resize images sequentially and check the abort signal between transformations;
- remeasure the complete object before declaring success; and
- never inspect or truncate ordinary text fields.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `bun test tests/responses-payload-recovery.test.ts`

Expected: both tests pass.

### Task 2: Add historical/current removal and safe failure with TDD

**Files:**
- Modify: `tests/responses-payload-recovery.test.ts`
- Modify: `src/services/copilot/responses-payload-recovery.ts`

- [ ] **Step 1: Write failing preservation/removal tests**

Add tests that construct top-level input items with `internal_chat_message_metadata_passthrough.turn_id` and request metadata with the active `turn_id`. Assert:

```ts
test("removes historical binaries before current-turn binaries", async () => {
  const payload = ordinaryTurnPayload({
    historyImage: tinyImage(3000),
    currentImage: tinyImage(3000),
    currentTurnId: "turn_current",
  })
  const result = await recoverResponsesPayload(payload, {
    maxBytes: 3900,
    recoveryMarginBytes: 100,
    resizeImage: async () => ({ outcome: "unshrinkable" }),
  })
  const serialized = JSON.stringify(result.payload)
  expect(result.removedHistoricalBinaries).toBe(1)
  expect(result.removedCurrentBinaries).toBe(0)
  expect(serialized).toContain("current-image-marker")
  expect(serialized).toContain("omitted to fit the CAPI Responses request-size limit")
})

test("removes current-turn binary only as the final recoverable fallback", async () => {
  const result = await recoverResponsesPayload(currentOnlyBinaryPayload(), {
    maxBytes: 1500,
    recoveryMarginBytes: 100,
    resizeImage: async () => ({ outcome: "unshrinkable" }),
  })
  expect(result.removedCurrentBinaries).toBe(1)
  expect(result.finalBytes).toBeLessThanOrEqual(1400)
})
```

Also add tests for:

- nested `input_file.file_data` and `computer_screenshot.image_url` replacement;
- external URLs and `file_id` remaining byte-for-byte present;
- ordinary function/custom tool calls, IDs, arguments, and textual outputs remaining unchanged;
- fallback current-turn grouping from the latest user-message index when turn IDs are absent; and
- non-binary preserved content raising `LocalHTTPError` with code `responses_payload_too_large`, status 413, `max_bytes`, `recovery_margin_bytes`, and `payload_bytes`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test tests/responses-payload-recovery.test.ts`

Expected: the new tests fail because removal/current-turn classification and the ordinary safe error are not implemented.

- [ ] **Step 3: Implement two-pass binary removal and error construction**

Implementation requirements:

- parse object/string `client_metadata` and `x-codex-turn-metadata` safely;
- prefer the request metadata `turn_id`, then the latest input item turn ID;
- when no turn ID exists, protect input from the last user message through the end during the historical pass;
- replace inline image/file records with shape-valid `input_text` breadcrumbs;
- remove raw base64 `input_file.file_data` as well as data URIs, while retaining external URLs and file IDs;
- process historical binary slots first, then current slots only if needed;
- stop each pass as soon as the exact payload meets `maxBytes - recoveryMarginBytes` so no extra binary is removed; and
- throw a `LocalHTTPError` with safe `responses_payload_too_large` body if recovery is exhausted.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/responses-payload-recovery.test.ts`

Expected: all recovery tests pass.

### Task 3: Implement Bun.Image downscaling with runtime verification

**Files:**
- Modify: `tests/responses-payload-recovery.test.ts`
- Modify: `src/services/copilot/responses-payload-recovery.ts`

- [ ] **Step 1: Add a real-codec test that runs on Bun 1.4.0**

Use the existing valid 1x1 PNG fixture and append binary padding before base64 encoding so the data URI is oversized while remaining decodable. Gate only runtimes without `Bun.Image`, not CI:

```ts
const supportsBunImage = typeof Bun.Image === "function"

test.skipIf(!supportsBunImage)(
  "re-encodes a decodable oversized PNG with Bun.Image",
  async () => {
    const original = paddedPngDataUri(256 * 1024)
    const resized = await resizeResponsesImage({
      dataUri: original,
      mediaType: "image/png",
      targetDataUriBytes: 32 * 1024,
    })
    expect(resized).not.toBeNull()
    expect(Buffer.byteLength(resized!)).toBeLessThanOrEqual(32 * 1024)
    expect(parseDataUri(resized!)?.mediaType).toBe("image/png")
  },
)
```

- [ ] **Step 2: Verify RED on the production Bun version**

Run in the repository container runtime:

```powershell
docker run --rm -v "${PWD}:/app" -w /app oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb bun test tests/responses-payload-recovery.test.ts
```

Expected: FAIL because `resizeResponsesImage` is not implemented.

- [ ] **Step 3: Implement deterministic Bun.Image resizing**

Export `resizeResponsesImage` as the default `ResponsesImageResizer`:

- parse the data URI and decode base64;
- accept only JPEG, PNG, and WebP; return `invalid` for GIF/other formats;
- reject APNG (`acTL`) and animated WebP (`ANIM`) before decoding;
- read metadata with `new Bun.Image(buffer).metadata()`;
- re-encode same-format at JPEG/WebP quality 80 or PNG compression level 9;
- if still above target, reduce width/height proportionally using the square root of the target/current byte ratio with a safety factor and retry up to eight decreasing dimensions;
- preserve aspect ratio with `fit: "inside"` and `withoutEnlargement: true`;
- return `invalid` on Bun image/decode errors, `unshrinkable` when valid media cannot reach the target, and `resized` with the fitted data URI on success; and
- check `signal?.throwIfAborted()` before every awaited terminal.

- [ ] **Step 4: Verify GREEN on Bun 1.4.0 and the local focused suite**

Run:

```powershell
docker run --rm -v "${PWD}:/app" -w /app oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb bun test tests/responses-payload-recovery.test.ts
bun test tests/responses-payload-recovery.test.ts
```

Expected: Docker and local Bun 1.4.0 run every test green, including the real-codec test.

### Task 4: Enforce ordinary recovery at the final Responses boundary

**Files:**
- Modify: `src/services/copilot/create-responses.ts`
- Modify: `tests/create-responses.test.ts`

- [ ] **Step 1: Replace the obsolete ordinary-oversize expectation with failing transport tests**

Change `leaves ordinary oversized Responses payloads unchanged` to assert an oversized ordinary request containing a nested inline file/image reaches the mocked upstream once with a serialized body below 32 MiB. Add a safe-error test for oversized preserved text that asserts zero upstream calls and `responses_payload_too_large`.

Retain a small ordinary request test that asserts the exact sanitized request body is unchanged apart from existing normalization/defaults.

- [ ] **Step 2: Run the transport tests and verify RED**

Run: `bun test tests/create-responses.test.ts`

Expected: oversized ordinary payload is sent unchanged or the old post-413 path dispatches more than once; preserved-text input reaches upstream instead of failing locally.

- [ ] **Step 3: Integrate asynchronous final-payload preparation**

Refactor payload preparation into an async function:

```ts
async function prepareResponsesPayload(
  payload: ResponsesPayload,
  options: { compaction: boolean; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const sanitized = sanitizeResponsesPayload(payload)
  if (options.compaction) {
    return logCompactionFit(fitResponsesCompactionPayload(sanitized)).payload
  }
  const recovered = await recoverResponsesPayload(sanitized, {
    signal: options.signal,
  })
  logOrdinaryRecovery(recovered)
  return recovered.payload
}
```

Then:

- await preparation before `routedFetch`;
- dispatch the recovered body exactly once;
- remove `removeInputImages` and the post-413 retry block;
- retain normal upstream error handling for a defensive changed-ceiling 413; and
- set the vision header from whether recovered input still contains an inline image, without changing initiator/account routing.

- [ ] **Step 4: Run transport, attachment, and compaction tests**

Run:

```powershell
bun test tests/create-responses.test.ts tests/responses-compaction-payload.test.ts tests/vision-attachments.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit the utility and transport integration**

```powershell
git add src/services/copilot/responses-payload-recovery.ts src/services/copilot/create-responses.ts tests/responses-payload-recovery.test.ts tests/create-responses.test.ts
git commit -m "recover oversized ordinary Responses payloads"
```

### Task 5: Cover HTTP and WebSocket continuation protocols

**Files:**
- Modify: `tests/responses-websocket.test.ts`
- Modify: `tests/responses-compact-affinity.test.ts`

- [ ] **Step 1: Add failing ordinary WebSocket and HTTP route regressions**

WebSocket test:

- seed a stored `previous_response_id` snapshot whose non-image history is just below 32 MiB;
- send an ordinary `request_kind: "turn"` continuation containing a nested tool-result image/file that pushes the rehydrated body above 32 MiB;
- assert exactly one mocked upstream request, body below 32 MiB minus the margin, preserved current command/call ID, and either a smaller data URI or explicit breadcrumb.

HTTP test:

- call `/v1/responses` with the same ordinary-turn shape;
- assert status 200 and one bounded upstream body;
- add a text-only oversized control returning local 413 with no upstream call.

- [ ] **Step 2: Run protocol tests and verify RED**

Run:

```powershell
bun test tests/responses-websocket.test.ts tests/responses-compact-affinity.test.ts
```

Expected: at least the new protocol assertions fail before the final boundary is wired through every path.

- [ ] **Step 3: Make only necessary handler adjustments**

If final `createResponses` integration already makes the tests green, add no handler code. Otherwise pass the existing abort signal and ordinary request metadata through without adding a second reducer. Native endpoint fallbacks remain covered by their own final dialect boundaries and are out of this PR's ordinary CAPI Responses scope.

- [ ] **Step 4: Run the focused protocol matrix**

Run:

```powershell
bun test tests/responses-payload-recovery.test.ts tests/create-responses.test.ts tests/responses-websocket.test.ts tests/responses-compact-affinity.test.ts tests/responses-compaction-payload.test.ts tests/responses-utils.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit protocol coverage**

```powershell
git add tests/responses-websocket.test.ts tests/responses-compact-affinity.test.ts src/routes/responses
git commit -m "cover ordinary Responses recovery protocols"
```

### Task 6: Verify, review, publish, and monitor

**Files:**
- Review all files changed from `origin/master`

- [ ] **Step 1: Run full fresh verification**

Run:

```powershell
bun audit --production
bun test
bun run lint:all
bun run typecheck
bun run build
git diff --check origin/master...HEAD
```

Expected: audit clean; all tests pass; lint has zero errors (existing warnings allowed); typecheck/build/diff check pass.

- [ ] **Step 2: Verify real Bun.Image behavior in the pinned container**

Run:

```powershell
docker build -t copilot-api-ordinary-recovery-test .
docker run --rm --entrypoint bun copilot-api-ordinary-recovery-test test tests/responses-payload-recovery.test.ts
```

Expected: real-codec recovery test passes on the same Bun 1.4.0 Alpine base used in production.

- [ ] **Step 3: Audit scope and preservation requirements**

Confirm:

- ordinary small bodies retain original reference at the recovery boundary;
- compaction still uses its separate 30 MiB reducer;
- no ordinary textual field is a reduction candidate;
- historical binaries precede current binaries in removal order;
- no outbound native CAPI Responses body reaches 32 MiB;
- no application code uses `AbortSignal.timeout`;
- no generated dashboard or unrelated file changed; and
- main checkout's `.superpowers/` remains untouched.

- [ ] **Step 4: Request independent code review**

Use the existing code-review agent against `origin/master...HEAD`, with this design and plan as requirements. Address every Critical or Important finding and rerun relevant focused/full verification.

- [ ] **Step 5: Push and open a draft PR**

```powershell
git push -u origin codex/ordinary-responses-payload-recovery
gh pr create --draft --base master --head codex/ordinary-responses-payload-recovery --title "[codex] recover oversized ordinary Responses turns" --body-file "$env:TEMP\copilot-api-ordinary-responses-pr.md"
```

Before the command, create `$env:TEMP\copilot-api-ordinary-responses-pr.md` with `apply_patch`. Its body must include the 500k-token versus 38,119.6 KiB byte mismatch, official Copilot Runtime parity, downscale/removal order, current-turn fallback, safe local error, and the exact results from Steps 1–4. Delete the temporary file with `apply_patch` after PR creation.

- [ ] **Step 6: Monitor replacement checks**

Run: `gh pr checks --watch --interval 10`

Expected: CI test, dependency review, CodeQL analyze, and CodeQL all pass. If a check fails, inspect its exact job log before changing code.
