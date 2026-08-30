# Copilot API Contract Parity Execution Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan set task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved Copilot API contract-parity design as four ordered, independently reviewable implementation plans and finish with current automated/live evidence.

**Architecture:** The plan set establishes shared contract/model/routing primitives first, then hardens Responses/Chat, then makes Messages/count-tokens native-first, and finally closes WebSocket/control-plane/documentation/verification parity. Each plan produces stable interfaces consumed by the next and must pass its own review gate before execution proceeds.

**Tech Stack:** Bun 1.3.x, strict TypeScript/ESNext, Hono, Bun WebSocket APIs, existing account-aware routing, Bun test, Sentry/Consola, live Copilot integration fixtures.

**Spec:** `docs/superpowers/specs/2026-08-17-copilot-api-contract-parity-design.md`

## Global Constraints

- Execute the plans in the order listed below.
- Do not start a dependent plan while the preceding plan has unresolved Critical or Important review findings.
- Every production behavior change follows red-green TDD.
- Preserve hash-only account affinity, deterministic upstream identity, payload recovery, compaction bootstrap, WebP normalization, MCP search compatibility, custom providers, model redirects, and raw administrator-only LLM Debug.
- Current upstream/account feature flags remain authoritative; the gateway must not emulate unavailable Auto, provider pinning, 1h caching, modern computer/image tools, or multi-agent authorization.
- A valid upstream 404/400 for an unavailable control-plane feature is a compatibility result, not a reason to invent local state.
- No new session/account/token mapping storage is permitted.
- Completion claims require fresh full verification after the final code change.

---

## Plan Order and Produced Interfaces

### Phase 1: Contract, models, and route primitives

Plan: `docs/superpowers/plans/2026-08-17-copilot-contract-model-routing.md`

Produces:

- `COPILOT_API_VERSION`, configurable integration ID, and shared safe-header sanitizer;
- request-scoped `CopilotRequestAttribution`;
- safe final-upstream response metadata storage;
- forward-compatible `Model` and discovery listings;
- single-model discovery; and
- `getModelEndpointSupport()` plus `selectCopilotEndpoint()`.

Exit gate:

- focused foundation tests, typecheck, changed-file lint, build, and live model discovery pass;
- code review has no unresolved Critical/Important findings.

### Phase 2: Responses and Chat parity

Plan: `docs/superpowers/plans/2026-08-17-responses-chat-contract-parity.md`

Consumes Phase 1 interfaces and produces:

- `prepareResponsesRequest()` and current Responses field/validation behavior;
- reasoning-none, prompt-cache, context-management, and tool parity;
- complete direct Chat contract normalization;
- explicit translation-fidelity checks/errors;
- endpoint-aware Chat routing; and
- narrow lossless Responses-to-Messages routing.

Exit gate:

- focused plus live Chat/Responses/tool tests pass;
- media verification runs under pinned Bun 1.4.0 if affected;
- code review has no unresolved Critical/Important findings.

### Phase 3: Messages and count-tokens parity

Plan: `docs/superpowers/plans/2026-08-17-messages-count-tokens-parity.md`

Consumes Phases 1–2 and produces:

- forward-compatible Anthropic wire types;
- clone-and-denylist native Messages preparation;
- beta/version/provider header forwarding;
- native-first Messages endpoint routing;
- same-budget native signature recovery;
- upstream Copilot count-tokens;
- cumulative Messages usage/recommendation preservation; and
- Anthropic-shaped safe HTTP/in-band errors.

Exit gate:

- focused plus live Messages/count-tokens/tool tests pass;
- code review has no unresolved Critical/Important findings.

### Phase 4: WebSocket, control plane, documentation, and final proof

Plan: `docs/superpowers/plans/2026-08-17-websocket-control-plane-verification.md`

Consumes all preceding interfaces and produces:

- recoverable Responses WebSocket frame validation;
- connection-local continuation with `previous_response_not_found`;
- per-turn typed attribution and safe event metadata;
- deterministic account-aware model policy, model-session, Auto, and intent routes;
- model-scoped session-token forwarding to matching inference;
- bounded contract observability;
- durable compatibility documentation; and
- complete automated/live/reviewer evidence.

Exit gate:

- full repository tests, lint, typecheck, build, diff check, live matrix, secret/log scan, spec review, and security/code-quality review pass with no unresolved Critical/Important findings.

## Execution Checklist

- [ ] **Step 1: Execute Phase 1**

Follow every checkbox in `2026-08-17-copilot-contract-model-routing.md` in order. Request an independent code review over the Phase 1 base/head SHAs before starting Phase 2. Fix valid Critical/Important findings test-first and rerun the Phase 1 exit gate.

- [ ] **Step 2: Execute Phase 2**

Follow every checkbox in `2026-08-17-responses-chat-contract-parity.md`. Review the Phase 2 diff independently against both its plan and the approved design. Fix findings and rerun its entire exit gate.

- [ ] **Step 3: Execute Phase 3**

Follow every checkbox in `2026-08-17-messages-count-tokens-parity.md`. Review beta/header privacy, native thinking preservation, retry-budget sharing, count-tokens behavior, and Anthropic error framing before starting Phase 4.

- [ ] **Step 4: Execute Phase 4**

Follow every checkbox in `2026-08-17-websocket-control-plane-verification.md`, including control-plane account selection, session-token privacy, bounded diagnostics, compatibility documentation, full verification, live probes, and two independent final reviews.

- [ ] **Step 5: Audit plan/spec coverage from final HEAD**

Map every heading in the approved design to a completed implementation task and passing evidence. Required mappings include:

| Design area | Plan owner |
| --- | --- |
| Source precedence and operating invariants | All plans plus compatibility document |
| API version/integration identity | Phase 1 Task 1 |
| Header attribution and response metadata | Phase 1 Tasks 2–3; Phase 4 Tasks 3 and 6 |
| Model preservation and discovery routes | Phase 1 Task 4; Phase 4 Task 4 |
| Endpoint authority and translation fidelity | Phase 1 Task 5; Phase 2 Tasks 5–7; Phase 3 Task 4 |
| Responses fields/reasoning/cache/context/tools/media | Phase 2 Tasks 1–3 plus retained recovery tests |
| Native Messages body/headers/sampling/counting/streaming | Phase 3 Tasks 1–8 |
| Chat contract | Phase 2 Task 4 plus routing/translation tasks |
| WebSocket validation/continuation/metadata/replay safety | Phase 4 Tasks 1–3 |
| Model policy, Auto, sessions, intent, inference session token | Phase 4 Tasks 4–5 |
| Error semantics and retry bounds | Phase 2 Tasks 1/5; Phase 3 Tasks 4/7; retained transport tests |
| Observability/privacy | Phase 1 Task 3; Phase 4 Tasks 5–7; existing LLM Debug tests |
| Compatibility documentation | Phase 4 Task 7 |
| Live/automated verification and reviews | Phase 4 Tasks 8–11 |

If any design requirement lacks an implementation/test mapping, the work is not complete.

- [ ] **Step 6: Hand off the verified implementation**

Report exact final test counts, lint warnings/errors, typecheck/build results, live probes, reviewer outcomes, residual feature-flag limitations, and HEAD SHA. The worktree is detached; use the Codex app's Create Branch action or a `codex/` branch before any requested push/PR workflow.

## Definition of Done

- Every plan checkbox is completed or explicitly superseded by a reviewed, equivalent test-first change.
- No upstream inference call uses an endpoint absent from live model metadata.
- No reviewed current field is silently stripped without an explicit documented reason.
- Native Messages, upstream count-tokens, safe errors, and session-token behavior are verified.
- Local WebSocket continuation and metadata are compatible within the documented no-storage scope.
- Existing local extensions and privacy boundaries remain green.
- All automated/static/live verification is fresh after the final fix.
- No unresolved Critical or Important review findings remain.
- The compatibility report matches final behavior and states residual limitations precisely.
