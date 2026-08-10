# Raw LLM Debug Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ten-minute administrator-only LLM Debug store preserve and expose every captured request and response value without redaction or rewriting.

**Architecture:** Keep the existing Copilot per-attempt capture, in-memory queue, authenticated dashboard API, exports, and fresh-auth replay execution. Remove storage transformations inside `src/lib/llm-debug-log.ts` and remove Replay's automatic initial JSON formatting, so every consumer can access exact captured strings while unrelated logging, Sentry, and configuration exports retain their own sanitization.

**Tech Stack:** TypeScript, Bun test runner, Hono dashboard API, React dashboard consumers, Markdown documentation.

---

## File Map

- Modify `tests/llm-debug-log.test.ts`: replace redaction expectations with exact request, response, abort, byte-count, clone, and error-path preservation regressions.
- Modify `tests/llm-debug-dashboard.test.ts`: prove the authenticated detail API returns raw URL, headers, request body, and response body.
- Modify `tests/copilot-client.test.ts`: prove the real Copilot attempt capture keeps authorization and full runtime error paths.
- Modify `src/lib/llm-debug-log.ts`: remove request/response redaction and retain exact captured error paths.
- Modify `ui/src/lib/json-document.ts`: preserve the exact captured body during
  Replay initialization and reset; keep formatting explicit.
- Modify `tests/json-document.test.ts`: prove valid captured JSON retains its
  whitespace and line endings before explicit formatting.
- Regenerate `src/routes/dashboard/page-generated.ts` through
  `bun run build:ui` after the Replay source change.
- Modify `README.md`: document raw LLM Debug contents while keeping configuration-export and request-log sanitization distinct.
- Modify `SECURITY.md`: describe LLM Debug as an intentional administrator-only raw-data boundary without weakening other controls.

### Task 1: Establish raw in-memory capture regressions

**Files:**
- Modify: `tests/llm-debug-log.test.ts:23-144`
- Test: `tests/llm-debug-log.test.ts`

- [ ] **Step 1: Replace the header-redaction test with an exact complete-capture test**

Use a deliberately formatted request body and response body, secret-bearing headers, URL credentials, and a query secret. Assert exact equality and UTF-8 byte counts:

```ts
test("stores exact request and completed response details", () => {
  const startedAtMs = Date.now()
  const requestBody = `{"messages": [ {"role": "user", "content": "Find this request"} ], "api_key": "body-secret", "model": "gpt-test", "stream": false}`
  const responseBody = `{ "access_token": "response-secret", "ok": true }`
  const requestHeaders = {
    authorization: "Bearer raw-token",
    cookie: "session=secret",
    "x-api-key": "header-secret",
  }
  const responseHeaders = {
    "content-type": "application/json",
    "set-cookie": "upstream=secret",
  }
  const url = "https://url-user:url-password@example.test/chat/completions?api_key=query-secret"
  const id = startLlmDebugLog({
    method: "POST",
    path: "/chat/completions",
    requestBody,
    requestHeaders,
    requestId: "req-debug-1",
    startedAtMs,
    url,
  })

  finishLlmDebugLog(id, {
    body: responseBody,
    headers: responseHeaders,
    status: 200,
    statusText: "OK",
  }, startedAtMs + 123)

  const detail = getLlmDebugLog(id)
  expect(detail?.request).toMatchObject({
    body: requestBody,
    bodyBytes: new TextEncoder().encode(requestBody).byteLength,
    headers: requestHeaders,
    url,
  })
  expect(detail?.response).toMatchObject({
    body: responseBody,
    bodyBytes: new TextEncoder().encode(responseBody).byteLength,
    headers: responseHeaders,
  })
})
```

- [ ] **Step 2: Replace the affinity-redaction tests with nested-body and session-header preservation assertions**

Keep the existing secret/session fixture values but assert exact source strings and headers:

```ts
expect(getLlmDebugLog(id)?.request.body).toBe(requestBody)
expect(getLlmDebugLog(id)?.request.headers).toEqual(requestHeaders)
```

- [ ] **Step 3: Add an aborted-response preservation test**

Create a pending entry, abort it with a response containing `set-cookie`, an intentionally spaced secret-bearing body, and a runtime error whose `path` includes URL credentials and a query secret:

```ts
const errorPath = "https://error-user:error-password@example.test/responses?token=error-secret"
const error = Object.assign(new Error("client disconnected"), {
  code: "ECONNABORTED",
  path: errorPath,
})
abortLlmDebugLog(id, {
  endedAtMs: startedAtMs + 25,
  error,
  response: {
    body: responseBody,
    headers: responseHeaders,
    status: 499,
    statusText: "Client Closed Request",
  },
})
expect(getLlmDebugLog(id)?.error?.path).toBe(errorPath)
expect(getLlmDebugLog(id)?.response).toMatchObject({
  body: responseBody,
  bodyBytes: new TextEncoder().encode(responseBody).byteLength,
  headers: responseHeaders,
})
```

- [ ] **Step 4: Add a defensive-clone regression**

Mutate the request and response objects returned by one `getLlmDebugLog` call, then assert a second call still returns the original raw values.

- [ ] **Step 5: Run the in-memory tests and verify RED**

Run:

```powershell
bun test tests/llm-debug-log.test.ts
```

Expected: FAIL because authorization, cookies, session headers, secret-like JSON values, URL credentials/query values, response values, whitespace, and error paths are currently transformed.

### Task 2: Establish raw API and real-capture regressions

**Files:**
- Modify: `tests/llm-debug-dashboard.test.ts:52-95`
- Modify: `tests/copilot-client.test.ts:309-340,612-628,680-706`
- Test: `tests/llm-debug-dashboard.test.ts`
- Test: `tests/copilot-client.test.ts`

- [ ] **Step 1: Strengthen the authenticated dashboard detail test**

Start and finish a record with raw URL, header, request-body, and response-body secrets. Fetch `/dashboard/api/llm-debug/:id` through the authenticated test server and assert exact equality:

```ts
expect(detailBody.request).toMatchObject({ body: requestBody, headers: requestHeaders, url })
expect(detailBody.response).toMatchObject({ body: responseBody, headers: responseHeaders })
```

- [ ] **Step 2: Strengthen the real Copilot attempt capture test**

After `copilotFetch`, read the full stored entry and assert:

```ts
expect(detail?.request.body).toBe(requestBody)
expect(detail?.request.headers.Authorization).toBe("Bearer expired-copilot-token")
expect(detail?.response?.body).toBe('{"choices":[]}')
```

- [ ] **Step 3: Change the cause-level path assertion to the full runtime string**

Rename the sanitized-path test and assert:

```ts
expect(entry?.error?.path).toBe("https://api.githubcopilot.com/responses?session=secret")
```

Keep the no-query socket-path assertion unchanged except for removing “sanitized” from its test name.

- [ ] **Step 4: Run the integration tests and verify RED**

Run:

```powershell
bun test tests/llm-debug-dashboard.test.ts tests/copilot-client.test.ts
```

Expected: FAIL only on the new raw-value assertions because the current store transforms values before API consumers read them.

### Task 3: Remove transformations at the LLM Debug boundary

**Files:**
- Modify: `src/lib/llm-debug-log.ts:7-165,389-416,472-555`
- Test: `tests/llm-debug-log.test.ts`
- Test: `tests/llm-debug-dashboard.test.ts`
- Test: `tests/copilot-client.test.ts`

- [ ] **Step 1: Remove request/response redaction helpers**

Delete `SENSITIVE_HEADER_PATTERN`, `SENSITIVE_FIELD_PATTERN`, `redactHeaders`, `redactJsonValue`, `redactBody`, and `redactUrl`. Retain `isRecord` because metadata and preview parsing still use it.

- [ ] **Step 2: Store exact request input**

Use the input body directly and shallow-copy headers to prevent later caller mutation:

```ts
const requestBody = input.requestBody
request: {
  body: requestBody,
  bodyBytes: byteLength(requestBody),
  headers: { ...input.requestHeaders },
  method: input.method,
  path: input.path,
  url: input.url,
},
```

- [ ] **Step 3: Store exact complete and aborted responses**

Use the original body once for storage and byte counting, and shallow-copy headers in both terminal paths:

```ts
entry.response = {
  ...response,
  body: response.body,
  headers: { ...response.headers },
  bodyBytes: byteLength(response.body),
}
```

- [ ] **Step 4: Preserve runtime error paths**

Replace URL sanitization with type validation:

```ts
function readErrorPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
```

Update `LlmDebugLogError.path` documentation to describe the runtime diagnostic path.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
bun test tests/llm-debug-log.test.ts tests/llm-debug-dashboard.test.ts tests/copilot-client.test.ts
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 6: Search the executable LLM Debug path for leftover redaction**

```powershell
rg -n -i "redact|sanitize|scrub|mask|\[REDACTED\]" src/lib/llm-debug-log.ts src/routes/dashboard/llm-debug-replay.ts ui/src/screens/LlmDebug.tsx ui/src/components/RequestExportMenu.tsx ui/src/lib/http-export.ts
```

Expected: no LLM Debug request/response redaction remains.

- [ ] **Step 7: Commit behavior and tests**

```powershell
git add -- src/lib/llm-debug-log.ts tests/llm-debug-log.test.ts tests/llm-debug-dashboard.test.ts tests/copilot-client.test.ts
git diff --cached --check
git commit -m "Expose raw LLM debug traffic"
```

### Task 4: Document the intentional raw-data boundary

**Files:**
- Modify: `README.md:466-472,839-849`
- Modify: `SECURITY.md:33-35,58,89-91`

- [ ] **Step 1: Update dashboard behavior documentation**

State that LLM Debug stores exact captured URLs, headers, request bodies, and response bodies—including credentials and session identifiers—for ten minutes in process memory. Retain endpoint and replay-scope text.

- [ ] **Step 2: Update security guidance**

State that LLM Debug is an administrator-only raw diagnostic boundary and must be treated as credential-bearing. Keep separate claims that ZIP configuration exports and ordinary debug request logging are sanitized.

- [ ] **Step 3: Correct the security-remediation table**

Change F-02 so it claims authenticated dashboard authority and write-only provider secrets while explicitly identifying LLM Debug as the intentional ten-minute raw exception.

- [ ] **Step 4: Search for stale documentation claims**

```powershell
rg -n -i "LLM Debug|debug storage|debug/export" README.md SECURITY.md PRODUCT.md
```

Expected: every LLM Debug statement describes raw ten-minute data; unrelated export and ordinary-log statements remain sanitized.

- [ ] **Step 5: Commit documentation**

```powershell
git add -- README.md SECURITY.md
git diff --cached --check
git commit -m "Document raw LLM debug data"
```

### Task 5: Verify the complete change

**Files:**
- Review: `docs/superpowers/specs/2026-08-10-llm-debug-raw-capture-design.md`
- Review: all modified source, tests, and documentation

- [ ] **Step 1: Run focused LLM Debug and export tests**

```powershell
bun test tests/llm-debug-log.test.ts tests/llm-debug-dashboard.test.ts tests/copilot-client.test.ts tests/http-export.test.ts tests/llm-debug-detail-view.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run typecheck and lint**

```powershell
bun run typecheck
bun run lint
```

Expected: both commands exit zero.

- [ ] **Step 3: Run the full non-integration test suite**

```powershell
$tests = Get-ChildItem tests -File -Filter *.test.ts
bun test $tests.FullName
```

Expected: zero failures.

- [ ] **Step 4: Build production output**

```powershell
bun run build:ui
bun run build
```

Expected: exit zero after `bun run build:ui` regenerates the dashboard bundle
from the Replay source change.

- [ ] **Step 5: Audit scope and stale redaction claims**

```powershell
rg -n -i "redact|sanitize|scrub|mask|\[REDACTED\]" src/lib/llm-debug-log.ts tests/llm-debug-log.test.ts tests/llm-debug-dashboard.test.ts
git diff c6ebea8 --check
git status --short --branch
git diff c6ebea8 --stat
```

Expected: no redaction remains in executable capture; diff checks are clean; only approved spec, plan, source, test, and documentation files changed.

- [ ] **Step 6: Review acceptance criteria line by line**

Confirm from fresh evidence that exact raw values reach the authenticated API, retention/authentication/replay reauthorization remain unchanged, no durable storage was added, and unrelated sanitization tests still pass.
