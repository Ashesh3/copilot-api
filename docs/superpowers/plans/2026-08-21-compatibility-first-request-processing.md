# Compatibility-First Request Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace proxy-imposed semantic request rejection with tolerant native forwarding and best-effort translation, while fixing namespaced Responses WebSocket continuation corruption.

**Architecture:** Public protocol handlers parse JSON and authorize requests, then use protocol-specific tolerant preparation. Native routes preserve unknown JSON fields and extensions; translated routes consume advisory compatibility findings and omit or approximate only unsupported optional concepts. Transport, authentication, resource, serialization, and account-affinity boundaries remain fail closed.

**Tech Stack:** Bun 1.3.x, strict TypeScript, Hono, Bun test, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-21-compatibility-first-request-processing-design.md`

## Global Constraints

- Compatibility is more important than local schema purity.
- No authenticated inference request may receive a local semantic 400 merely because a role, field, block, item, tool, or combination is unknown to the proxy.
- Malformed JSON, authentication/authorization, bounded resource protection, safe serialization, WebSocket continuation ownership, and account-bound encrypted/session history remain protected.
- Prefer native opaque forwarding; translate recognized concepts best-effort only when native routing is unavailable.
- Ordinary logs/Sentry/client errors remain sanitized; raw payloads stay administrator-only in LLM Debug.
- Every production behavior change follows a verified red-green test cycle.

---

### Task 1: Preserve namespaced Responses WebSocket continuation history

**Files:**
- Modify: `src/services/copilot/responses-terminal-sanitizer.ts`
- Modify: `src/routes/responses/websocket.ts` only if preserving the field in the sanitizer is insufficient
- Test: `tests/responses-terminal-sanitizer.test.ts`
- Test: `tests/responses-websocket-protocol.test.ts`
- Test: `tests/responses-websocket.test.ts`

**Interfaces:**
- Consumes: `sanitizeResponsesStreamEvent(event)` and existing continuation snapshot/rehydration functions.
- Produces: sanitized `function_call` items that retain safe string `namespace`, allowing a subsequent `function_call_output` to rehydrate valid history.

- [ ] Add a failing sanitizer test with `{type:"function_call", name:"spawn_agent", namespace:"collaboration", call_id, arguments}` and assert `namespace` survives.
- [ ] Add a failing continuation regression containing that sanitized call followed by its output; assert the rehydrated upstream input preserves `namespace`, call ordering, and call ID.
- [ ] Run `bun test tests/responses-terminal-sanitizer.test.ts tests/responses-websocket-protocol.test.ts tests/responses-websocket.test.ts` and confirm failure is the missing namespace.
- [ ] Preserve only a safe non-empty string namespace in `safeFunctionCall`, without broadening secret-bearing terminal fields.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit as `Preserve namespaced Responses continuations`.

### Task 2: Make Anthropic Messages and token counting tolerant

**Files:**
- Modify: `src/services/copilot/messages-contract.ts`
- Modify: `src/services/copilot/anthropic-request-headers.ts`
- Modify: `src/routes/messages/anthropic-types.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/messages/count-tokens-handler.ts`
- Modify: `src/services/copilot/create-anthropic-messages.ts`
- Test: `tests/messages-contract.test.ts`
- Test: `tests/messages-handler.test.ts`
- Test: `tests/create-anthropic-messages.test.ts`
- Test: `tests/count-tokens-handler.test.ts`

**Interfaces:**
- Consumes: `prepareAnthropicMessagesRequest`, `normalizeAnthropicMessagesRequest`, and safe header sanitization.
- Produces: a plain-JSON request snapshot that removes only gateway-owned fields, preserves unknown native data, fills an upstream-required output limit when possible, and reports normalization classes instead of throwing semantic errors.

- [ ] Replace local-rejection tests with failing compatibility tests for `role:"system"`, a future role, unknown content/tool/top-level fields, missing or malformed optional controls, and invalid optional Anthropic headers.
- [ ] Add a failing token-count test proving extension-rich Messages payloads reach native count or resilient estimation without a local semantic 400.
- [ ] Run the four focused test files and confirm the new tests fail under current validation.
- [ ] Refactor `prepareAnthropicMessagesRequest` to require only a plain serializable object, preserve fields, strip gateway-only keys, and normalize optional controls without schema rejection.
- [ ] Sanitize/drop unsafe optional Anthropic headers instead of throwing; retain control-character and byte limits.
- [ ] Broaden wire types to permit unknown message roles/blocks without `any`.
- [ ] Ensure missing `max_tokens` is filled from model metadata at the transport point when required, while explicit client values remain untouched.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Commit as `Make Messages preparation compatibility first`.

### Task 3: Make Chat Completions preparation tolerant

**Files:**
- Modify: `src/routes/chat-completions/chat-contract.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/services/copilot/create-chat-completions.ts`
- Test: `tests/chat-contract.test.ts`
- Test: `tests/create-chat-completions.test.ts`
- Test: `tests/chat-endpoint-routing.test.ts`

**Interfaces:**
- Consumes: `prepareChatCompletionsRequest` and `normalizeChatCompletionsRequest`.
- Produces: a cloned request that preserves unknown native fields/roles/content, normalizes known upstream conflicts, and never throws a local semantic contract error.

- [ ] Add failing tests for custom/system/developer roles, null optional controls, legacy functions, unknown content parts, incomplete tool history, and conflicting token controls reaching an upstream route.
- [ ] Run focused tests and confirm failures come from current contract validation.
- [ ] Remove closed-union semantic validation from preparation while retaining safe plain-JSON cloning.
- [ ] Normalize empty controls and known mutually exclusive fields only for the selected upstream.
- [ ] Preserve native unknown fields and legacy function forms.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Commit as `Make Chat preparation compatibility first`.

### Task 4: Make Responses preparation and WebSocket frames tolerant

**Files:**
- Modify: `src/services/copilot/responses-contract.ts`
- Modify: `src/services/copilot/create-responses.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/responses/websocket-protocol.ts`
- Modify: `src/routes/responses/compact-handler.ts`
- Test: `tests/responses-contract.test.ts`
- Test: `tests/create-responses.test.ts`
- Test: `tests/responses-request-normalization.test.ts`
- Test: `tests/responses-websocket-protocol.test.ts`
- Test: `tests/responses-endpoint-routing.test.ts`

**Interfaces:**
- Consumes: `prepareResponsesRequest`, `finalizeResponsesRequest`, `parseResponsesWebSocketFrame`, and continuation rehydration.
- Produces: a native Responses body that preserves unknown fields/items/tools/state controls, plus WebSocket frames that coerce transport-required streaming and ignore malformed optional attribution.

- [ ] Add failing tests for future input items/tools/top-level fields, state/context controls, previously blocked tools, `stream:false`, and malformed optional initiator/task metadata.
- [ ] Add a failing compact-route test proving a sparse but parseable body produces a safe result instead of a validation 400 or 500.
- [ ] Run focused tests and confirm current semantic rejection.
- [ ] Remove `ALWAYS_BLOCKED_RESPONSES_TOOLS` and closed semantic validators from native preparation.
- [ ] Treat malformed optional state/context/tool controls as absent only when the selected upstream cannot safely receive them; otherwise preserve them.
- [ ] Normalize WebSocket `stream:false` to `true`, ignore invalid optional attribution, and retain parse/action/continuation ownership checks.
- [ ] Harden compact extraction for sparse shapes without fabricating user content.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Commit as `Make Responses preparation compatibility first`.

### Task 5: Convert translation fidelity gates into advisory degradation

**Files:**
- Modify: `src/lib/endpoint-routing.ts`
- Modify: `src/lib/error.ts` only if the obsolete local translation error is removed
- Modify: `src/routes/messages/translation-fidelity.ts`
- Modify: `src/routes/chat-completions/translation-fidelity.ts`
- Modify: `src/routes/responses/translation-fidelity.ts`
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Test: `tests/messages-endpoint-routing.test.ts`
- Test: `tests/chat-endpoint-routing.test.ts`
- Test: `tests/responses-endpoint-routing.test.ts`
- Test: `tests/endpoint-routing.test.ts`

**Interfaces:**
- Consumes: existing `check*Translation` findings and endpoint capability metadata.
- Produces: advisory findings used for least-lossy endpoint selection and normalization telemetry; handlers no longer throw `endpoint_translation_unsupported` for optional/unrecognized concepts.

- [ ] Add failing routing tests proving unknown optional concepts choose native or best-effort translated routes rather than local 400.
- [ ] Run focused routing tests and confirm current fail-closed behavior.
- [ ] Separate fatal inability-to-represent-any-content from advisory fidelity findings.
- [ ] Update handlers to record advisory degradation and continue with the least-lossy route.
- [ ] Preserve a rare safe routing failure only when no endpoint can carry meaningful content.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Commit as `Degrade unsupported translations gracefully`.

### Task 6: Make Google AI and token compatibility paths resilient

**Files:**
- Modify: `src/routes/google-ai/handler.ts`
- Modify: `src/server.ts` if `countTokens` routing is added
- Modify: `src/services/copilot/count-anthropic-tokens.ts` only if shared fallback support is needed
- Test: `tests/google-ai-handler.test.ts`
- Test: `tests/integration/count-tokens.test.ts`

**Interfaces:**
- Consumes: Google request translation, endpoint routing, and tokenizer estimation.
- Produces: best-effort generate/stream/countTokens behavior that ignores unknown optional fields and tool variants rather than returning local semantic 400s.

- [ ] Add failing tests for unknown generation config, unsupported-looking tool variants, and Google `countTokens` with extension-rich content.
- [ ] Run focused tests and confirm current rejection or missing route.
- [ ] Make Google translation shape-guarded: translate known fields, preserve/omit unknown optional fields with telemetry, and avoid semantic throws.
- [ ] Route native token counting where possible and otherwise return a resilient estimate in Google-compatible shape.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Commit as `Make Google compatibility paths tolerant`.

### Task 7: Add safe upstream compatibility recovery and diagnostics

**Files:**
- Modify: `src/services/copilot/transport-retry.ts`
- Modify: `src/services/copilot/create-responses.ts`
- Modify: `src/services/copilot/create-chat-completions.ts`
- Modify: `src/services/copilot/create-anthropic-messages.ts`
- Modify: `src/lib/copilot-contract-observability.ts`
- Modify: `src/routes/responses/websocket.ts`
- Test: `tests/transport-retry.test.ts`
- Test: `tests/create-responses.test.ts`
- Test: `tests/create-chat-completions.test.ts`
- Test: `tests/create-anthropic-messages.test.ts`
- Test: `tests/responses-websocket.test.ts`

**Interfaces:**
- Consumes: shared retry budget, safe upstream error inspection, protocol normalization classes.
- Produces: at most one deterministic compatibility retry for a known safe class, plus sanitized endpoint/status/error-class diagnostics for WebSocket failures.

- [ ] Add failing tests proving an unknown deterministic 400 is not retried, while a known optional-control incompatibility gets exactly one normalized retry within the shared budget.
- [ ] Add a failing WebSocket test asserting the terminal/log diagnostic includes a safe upstream error class without raw upstream content.
- [ ] Run focused tests and confirm failures.
- [ ] Implement explicit compatibility-retry classification and one-transform retry; never cross account/session affinity.
- [ ] Emit safe protocol/endpoint/status/class telemetry and retain raw details only in LLM Debug.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Commit as `Recover known upstream compatibility failures`.

### Task 8: Documentation, full verification, and publication

**Files:**
- Modify: `docs/copilot-api-compatibility.md`
- Modify: `README.md` only if public compatibility guarantees are summarized there
- Test: `tests/copilot-compatibility-doc.test.ts`

**Interfaces:**
- Consumes: all behavior delivered by Tasks 1-7.
- Produces: an enforceable documented compatibility contract and a release-ready branch.

- [ ] Update compatibility documentation to distinguish tolerant semantic handling from retained safety boundaries.
- [ ] Add/adjust documentation contract tests.
- [ ] Run all changed-file focused tests.
- [ ] Run `bun test` and require zero failures.
- [ ] Run `bun run typecheck` and require exit 0.
- [ ] Run focused changed-file lint, then `bun run lint:all`; require zero new errors.
- [ ] Run `bun run build` and `bun run build:ui`; require exit 0 and no unexpected generated diff.
- [ ] Run `git diff --check` and inspect the complete diff.
- [ ] Dispatch a whole-branch code review and resolve every Critical or Important finding.
- [ ] Commit documentation/final remediation as `Document compatibility-first request handling`.
- [ ] Push `codex/maximize-client-compatibility`, open a ready pull request without AI/bot prefixes, monitor all checks, fix failures, resolve actionable review feedback, merge, and verify `origin/master` contains the merge.
