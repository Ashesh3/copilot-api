# Compatibility Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore compatibility-first request processing, exact final upstream error-body propagation, unrestricted HTTP(S) attachment fetching, deterministic stream termination, and the audited platform regressions.

**Architecture:** Parse and authorize once, snapshot caller-owned JSON, adapt a payload per advertised endpoint, rank with advisory findings, dispatch the exact evaluated payload, and terminate each stream exactly once. An owned upstream-failure snapshot preserves final status, content type, approved headers, and exact body bytes for clients, logs, and Sentry. Attachment recovery accepts every runtime-valid absolute HTTP(S) destination while bounding only abort, time, bytes, and redirects.

**Tech Stack:** Bun 1.3.x, strict TypeScript, Hono, Bun test, Sentry, `fetch-event-stream`.

**Spec:** `docs/superpowers/specs/2026-08-21-compatibility-recovery-design.md`

## Global Constraints

- A final non-empty upstream HTTP error body is exposed byte/text unchanged to the normal client response, ordinary logs, and Sentry; preserve upstream status and relevant `Content-Type`.
- Do not parse, redact, secret-scan, canonicalize, reserialize, replace, or protocol-wrap that upstream body. Request bodies and headers remain separately protected.
- Every runtime-valid absolute HTTP(S) attachment/file URL is fetchable, including localhost, private/link-local/metadata targets, userinfo, literal IPs, and redirects. Do not add destination, DNS, IP, hostname, or redirect-target SSRF filtering.
- Retain caller abort, independent timeout, byte cap, and redirect-count bounds.
- Invalid JSON, auth/authorization, account/session ownership, hostile serialization, no-route, and exactly-once terminal invariants remain hard boundaries.
- Unknown request semantics are preserved natively or adapted best-effort; local semantic 400s are reserved for no meaningful executable request.
- The payload selected by routing is the payload dispatched. Preparation is non-mutating and runs once.
- Every production behavior change follows a witnessed RED then GREEN test cycle.
- PR #62 already preserved Responses tool namespaces and delivered substantial Messages compatibility; characterize current HEAD rather than redoing it.
- No push, pull request, merge, deployment, or production mutation is part of this plan.

---

### Task 1: Commit the superseding contract and executable inventory

**Files:** Add the spec and this plan; modify `src/lib/compatibility-contract-values.ts` and `tests/copilot-compatibility-doc.test.ts` only to enumerate target contract rows without claiming unimplemented runtime behavior.

**Interfaces:** Produces the binding policy and stale-assertion inventory consumed by all later tasks.

- [ ] Add a documentation-contract test asserting the target rows name exact upstream-body passthrough and unrestricted HTTP(S) destinations.
- [ ] Run `bun test tests/copilot-compatibility-doc.test.ts`; expect failure because current values still say fixed safe envelopes/sanitized terminals.
- [ ] Add target contract constants or pending inventory markers without changing runtime code; keep current-behavior assertions separate until Task 19.
- [ ] Re-run the focused test and require pass.
- [ ] Commit as `Define compatibility recovery contract`.

### Task 2: Preserve Responses terminal events non-destructively

**Files:** `src/services/copilot/responses-terminal-sanitizer.ts`, `src/services/copilot/create-responses.ts`, `src/routes/responses/stream-id-sync.ts`, `tests/responses-terminal-sanitizer.test.ts`, `tests/create-responses.test.ts`.

**Interfaces:** `sanitizeResponsesStreamEvent(event)` returns a detached parseable event preserving unknown response fields/output items and partial failed/incomplete output; synthetic failure creation is separate.

- [ ] Add tests for sparse completed, unknown output items/fields, incomplete/failed partial output, and existing namespaced function calls.
- [ ] Run `bun test tests/responses-terminal-sanitizer.test.ts tests/create-responses.test.ts`; expect current sanitizer data-loss/failure assertions.
- [ ] Preserve the parsed terminal object and overlay only required synchronized identifiers; never turn parseable completion/incomplete into a proxy 502.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Preserve Responses terminal payloads`.

### Task 3: Own and forward exact upstream HTTP failure bodies

**Files:** `src/lib/error.ts`, `src/routes/messages/error.ts`, `src/lib/sentry.ts`, `tests/error.test.ts`, `tests/messages-error.test.ts`, `tests/sentry.test.ts`.

**Interfaces:** Add `UpstreamFailureSnapshot { status; responseHeaders; contentType?; bodyBytes; bodyText? }`. `inspectHttpError` returns either trusted local metadata or this owned upstream snapshot. `reportHttpError` logs and attaches the exact body to Sentry. HTTP renderers return the exact non-empty upstream body for every client dialect.

- [ ] Invert privacy tests and add JSON, text, HTML, whitespace-sensitive, empty, and binary-decodable fixtures; assert client bytes, log value, and Sentry `extra.upstreamResponseBody` match the final body.
- [ ] Run `bun test tests/error.test.ts tests/messages-error.test.ts tests/sentry.test.ts`; expect failures because bodies are sanitized/replaced.
- [ ] Read a native response clone once into owned bytes, preserve status/content type, forward raw bytes for non-local non-empty bodies, and retain protocol-shaped fallback only for local/bodyless/transport errors and 499 handling.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Forward exact upstream error bodies`.

### Task 4: Migrate upstream transports and custom providers to the owned snapshot

**Files:** `src/services/copilot/create-chat-completions.ts`, `create-responses.ts`, `create-anthropic-messages.ts`, `count-anthropic-tokens.ts`, `create-embeddings.ts`, `src/services/copilot/control-plane.ts`, `src/lib/custom-providers.ts`; corresponding create-service/custom-provider tests.

**Interfaces:** Every non-OK final upstream `Response` reaches `HTTPError` undrained; local invalid-success JSON remains a distinct local/bodyless 502.

- [ ] Add wire tests proving native Chat/Responses/Messages/token/embedding/control/custom-provider errors retain exact status, content type, and body through Task 3's boundary.
- [ ] Run the focused create-service and `tests/custom-providers.test.ts` suites; expect prior 404 remap/body drain or generic envelope failures.
- [ ] Remove pre-forward body transformations/remaps and ensure retry/debug reads use clones; tolerate custom-provider SSE comments/unknown frames without discarding valid data.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Preserve upstream transport failures`.

### Task 5: Add an exactly-once terminal lifecycle foundation

**Files:** Create `src/lib/stream-terminal-lifecycle.ts`; add focused lifecycle tests and small dialect failure-adapter modules as needed.

**Interfaces:** `createStreamTerminalLifecycle()` exposes `succeed`, `fail`, `abort`, `finishSource`, and state `open|succeeded|failed|aborted`; dialect adapters accept optional exact upstream bytes/text.

- [ ] Add unit tests for idempotence, source-end failure, no writes after abort, normal success, and exact raw-body handoff.
- [ ] Run the new focused test; expect missing module/API failure.
- [ ] Implement the minimal protocol-agnostic guard; keep transport heartbeats in `sse-lifecycle.ts` and protocol state in adapters.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Add stream terminal lifecycle guard`.

### Task 6: Repair Responses HTTP streaming lifecycle

**Files:** `src/routes/responses/handler.ts`, `src/routes/messages/web-search-helpers.ts`, Responses stream/lifecycle tests.

**Interfaces:** Uses Task 5 guard and Task 2 terminal preservation. Ordinary native streams write immediately; buffering is limited to explicit emulated web-search resolution.

- [ ] Add tests for first-delta immediacy, partial output then throw, clean EOF without terminal, duplicate terminal, incomplete terminal, and exact upstream failure content.
- [ ] Run the focused Responses stream tests; expect buffering/silent-close/duplicate failures.
- [ ] Integrate the guard across native, Chat fallback, and Messages fallback; emit exactly `error` then `response.failed` for local/bodyless late failure and preserve received terminal objects.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Repair Responses stream lifecycle`.

### Task 7: Repair Chat streaming lifecycle

**Files:** `src/routes/chat-completions/handler.ts`, `responses-fallback-executor.ts`, `anthropic-bridge.ts`, custom-provider stream path, Chat lifecycle tests.

**Interfaces:** Every committed non-abort failure produces one Chat error event followed by one `[DONE]`; exact upstream body is the error content when available.

- [ ] Add native/custom/Responses/Messages-backed tests for partial delta then throw, malformed SSE, missing finish, and abort.
- [ ] Run focused Chat stream tests; expect silent close or missing `[DONE]`.
- [ ] Integrate Task 5 guard and preserve refusal/tool chunks and finish reasons, including `pause_turn` distinction.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Repair Chat stream lifecycle`.

### Task 8: Repair Messages streaming lifecycle

**Files:** `src/routes/messages/stream-translation.ts`, `responses-stream-translation.ts`, `handler.ts`, `native-handler.ts`, Anthropic response helpers and lifecycle tests.

**Interfaces:** Close open text/thinking/tool blocks before one error; no success terminal follows failure.

- [ ] Add tests for interleaved thinking, split tool id/name chunks, missing finish, unknown block type, upstream error then throw, and exact raw body in the error event.
- [ ] Run focused Messages lifecycle tests; expect orphan/open blocks or duplicate/silent terminals.
- [ ] Expose translator state to a state-aware Task 5 adapter and finalize exactly once.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Repair Messages stream lifecycle`.

### Task 9: Repair Google streaming lifecycle and output modes

**Files:** `src/routes/google-ai/handler.ts`, `response-translation.ts`, Google stream tests.

**Interfaces:** Chat/Messages/Responses upstreams produce identical Google finality; `alt` selects SSE versus JSON-array output; Responses failed/error becomes a Google failure carrying exact upstream content.

- [ ] Add tests for partial output then throw, tool-call-only finish, Responses failed/error, missing finish, legacy keepalive-sensitive parsing, and `alt` behavior.
- [ ] Run focused Google tests; expect swallowed failures or wrong output mode.
- [ ] Integrate Task 5 guard, flush accumulated calls, and make keepalive emission compatible/disableable for legacy clients.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Repair Google stream lifecycle`.

### Task 10: Repair Responses WebSocket terminal and frame handling

**Files:** `src/routes/responses/websocket.ts`, `websocket-lifecycle.ts`, `websocket-protocol.ts`, metadata/continuation tests.

**Interfaces:** Treat incomplete as valid terminal, preserve future/namespaced snapshots, coerce `stream:false`, ignore invalid optional attribution, preserve lane isolation, and use exact upstream body in error frames.

- [ ] Add tests for future completed items, incomplete partial output, preflight raw-body error, iterator failure after delta, source EOF, stream false, malformed initiator, concurrent turns, and effective per-connection envelope persistence.
- [ ] Run focused WebSocket tests; expect strict-frame/terminal failures.
- [ ] Reuse Tasks 2/5, make HTTP inspection async, retain one-connection continuation ownership, and persist effective headers between turns without durable storage.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Repair Responses WebSocket lifecycle`.

### Task 11: Make translation findings advisory

**Files:** `src/lib/endpoint-routing.ts`, `src/lib/copilot-contract-observability.ts`, the Chat/Responses/Messages fidelity scanners, routing/fidelity tests.

**Interfaces:** `TranslationCheck` gains bounded findings/cost; `supported:false` means only fatal post-adaptation emptiness/no route.

- [ ] Invert tests where unknown optional concepts currently yield `endpoint_translation_unsupported`; assert ordered bounded findings and continued candidate eligibility.
- [ ] Run `bun test tests/endpoint-routing.test.ts tests/translation-fidelity.test.ts`; expect fail-closed behavior.
- [ ] Migrate scanner outputs without echoing client values and update selection to exclude only fatal candidates.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Make translation findings advisory`.

### Task 12: Make Chat preparation and candidate routing tolerant

**Files:** `src/routes/chat-completions/chat-contract.ts`, `handler.ts`, `responses-fallback.ts`, `responses-fallback-executor.ts`, `anthropic-bridge.ts`, `anthropic-conversion.ts`, `src/services/copilot/create-chat-completions.ts`; Chat contract/routing tests.

**Interfaces:** One prepared source snapshot; per-candidate native Chat/Responses/Messages adapters; dispatch the evaluated candidate.

- [ ] Add tests for future roles, null/scalar/singleton content, incomplete/duplicate/orphan tool history, legacy functions, arbitrary tool choice, token conflicts, web-search naming, attachments, schema and sampling controls.
- [ ] Run focused Chat contract/routing tests; expect local 400s or wrong payload selection.
- [ ] Normalize per entry, preserve native JSON, degrade translated records to text/omission/schema repair, apply web-search repair before route choice, and remove duplicate transport validation.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Make Chat routing compatibility first`.

### Task 13: Make native Responses preparation tolerant

**Files:** `src/services/copilot/responses-contract.ts`, `create-responses.ts`, `src/routes/responses/handler.ts`, Responses contract/normalization tests.

**Interfaces:** Preserve unknown native top-level/input/tool/state/context JSON; remove closed tool blocklist; override `store:false` without rejecting; prepare once.

- [ ] Add tests for unknown fields/items/tools, store/background/previous id/service tier/context controls, singleton tools, hostile direct objects, and immutability.
- [ ] Run focused Responses contract tests; expect semantic rejection/field loss.
- [ ] Split native preservation from target adaptation, retain hostile serialization checks, and use the prepared transport option.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Preserve native Responses requests`.

### Task 14: Make Responses fallback adapters best-effort

**Files:** `src/routes/responses/handler.ts`, `messages-bridge.ts`, `translation-fidelity.ts`, fallback/routing tests.

**Interfaces:** Adapt Chat/Messages candidates before selection; preserve future items, tools, reasoning, media, and call history via mapping/text/omission/generated local IDs.

- [ ] Invert fallback 400 tests for custom/computer/hosted tools, references, opaque reasoning, malformed calls, attachments, state/context, web search/apply patch, and sampling.
- [ ] Run focused Responses handler/routing/translation tests; expect fail-closed assertions.
- [ ] Remove pre-conversion assertions, apply repairs before route choice, preserve the evaluated payload, and fail locally only if adaptation yields no meaningful request.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Make Responses fallbacks best effort`.

### Task 15: Finish Messages and token-count compatibility

**Files:** `src/services/copilot/messages-contract.ts`, `anthropic-request-headers.ts`, `create-anthropic-messages.ts`, `count-anthropic-tokens.ts`, Messages handlers/types/fidelity and tests.

**Interfaces:** Build on PR #62; explicit null limits are absent, optional beta values sanitize per token, output limits derive when required, extension-rich count requests estimate rather than reject.

- [ ] Add residual tests for null limits, retained usable messages/tool blocks/images, future roles, parallel-tool controls, sampling conflicts, effort/beta/web-fetch normalization, stop sequences, compaction fitting, and count fallback.
- [ ] Run focused Messages/count suites; expect current residual regressions.
- [ ] Make only target-required normalizations, preserve native-compatible data, and cap web-search loops before spending beyond budget.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Finish Messages compatibility recovery`.

### Task 16: Make Google request adaptation tolerant

**Files:** `src/routes/google-ai/handler.ts`, `google-ai-types.ts`, `request-translation.ts`, `src/server.ts` if countTokens route is added; Google tests.

**Interfaces:** Fixed invalid-JSON boundary; guarded containers; `parametersJsonSchema ?? parameters`; recursive non-mutating schema normalization; FIFO same-name call/result pairing.

- [ ] Add tests for unknown root/generation fields, `codeExecution`, absent/future role, singleton/malformed parts, function responses, repeated names, uppercase nested schema types, structured generation/thinking, countTokens, and malformed JSON.
- [ ] Run focused Google tests; expect 400/500, empty schema, or wrong pairing.
- [ ] Translate recognized concepts, degrade unknown parts, ignore unsupported optional controls, and provide resilient token estimation where native routing is unavailable.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Make Google request adaptation tolerant`.

### Task 17: Implement unrestricted resource-bounded HTTP(S) file fetching

**Files:** `src/lib/attachments.ts`, every Chat/Responses/Messages/Google attachment adapter, attachment/vision/routing tests.

**Interfaces:** `parseFetchableHttpUrl(value): URL | null` accepts any runtime-valid absolute HTTP(S) URL. `fetchUrlAsDataUri` follows redirects manually without destination checks and enforces abort/timeout/byte/redirect bounds.

- [ ] Add/invert tests proving fetch attempts to localhost, IPv4/IPv6 loopback, RFC1918/ULA, link-local/metadata-style, literal IP, intranet, userinfo, unusual runtime-accepted authority, and redirects among them; separately test malformed/non-HTTP, timeout, bytes, redirect limit, and abort.
- [ ] Run attachment and dialect routing tests; expect canonical gate or missing resource-bound failures.
- [ ] Remove `isSafeExternalHttpUrl`/canonical destination policy, stream bytes under a cap, combine signals, and make callers degrade only the affected attachment.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Allow unrestricted attachment fetching`.

### Task 18: Add bounded deterministic compatibility retry

**Files:** `src/services/copilot/transport-retry.ts` and Chat/Responses/Messages transports; retry/create-service tests.

**Interfaces:** At most one same-account pre-output compatibility normalization within the shared send budget; classification uses a cloned body; unknown deterministic 400 is not retried.

- [ ] Add tests for known optional-control retry, unknown 400 no retry, shared-budget exhaustion, issuer/account preservation, no retry after output, and exact final-attempt body availability.
- [ ] Run focused retry tests; expect missing classification/retry behavior.
- [ ] Implement bounded normalization classes and preserve the final owned failure snapshot.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Retry known compatibility failures once`.

### Task 19: Repair residual platform compatibility

**Files:** `src/routes/copilot-control-plane/route.ts`, `src/services/copilot/control-plane.ts`, `src/lib/account-router.ts`, `credential-resolver.ts`, `api-key-guard.ts`, models/health/CORS/server routes, custom-provider cross-dialect adapters, Direct Connect/code-session/environment public-origin helpers, transparent proxy, peripheral JSON readers; focused platform tests and `ui/src` only if settings UI changes.

**Interfaces:** Preserve client control-plane fields; prefer eligible token issuer without storage; accept Google `?key=` and matching multi-position credentials; absent picker flag means visible; expose `/health`; explicit non-admin inference CORS; advertised custom-provider Chat models work through Responses/Google adapters; trusted public origin maps HTTP(S) to WS(S); gateway/provider credentials remain distinct.

- [ ] Add focused failing tests for each residual behavior plus peripheral malformed JSON fixed 400s.
- [ ] Run `bun test tests/copilot-control-plane.test.ts tests/account-aware-endpoint-routing.test.ts tests/credential-resolver.test.ts tests/inference-cors.test.ts tests/models-route.test.ts tests/custom-providers.test.ts tests/responses-websocket-metadata-continuation.test.ts`; expect the mapped regressions.
- [ ] Implement each bounded repair without persistent affinity maps or broad admin CORS. If UI settings change, edit `ui/src` and rebuild generated UI.
- [ ] Re-run focused tests and require pass.
- [ ] Commit as `Repair platform compatibility gaps`.

### Task 20: Document, audit, review, and verify the branch

**Files:** `src/lib/compatibility-contract-values.ts`, `docs/copilot-api-compatibility.md`, `README.md`, `SECURITY.md`, doc tests, and only remediation files required by review.

**Interfaces:** Documentation and executable matrices describe actual final behavior, including accepted raw-body and unrestricted-fetch risks.

- [ ] Update stream/error/URL/platform contract rows and documentation; remove claims that ordinary client/log/Sentry errors are sanitized or LLM Debug is the sole raw response channel.
- [ ] Run focused changed-file suites, then `bun test` and require zero failures.
- [ ] Run `bun run typecheck`, focused lint, `bun run lint:all`, `bun run build`, conditional `bun run build:ui`, and `git diff --check`; require exit 0 and inspect generated diff.
- [ ] Search for stale gates/claims: `assert*Translation`, `endpoint_translation_unsupported`, `ALWAYS_BLOCKED_RESPONSES_TOOLS`, `SAFE_RESPONSES_STREAM_ERROR_MESSAGE`, `Upstream request failed`, `fixed safe`, `sanitized upstream`, `raw details only in LLM Debug`, `isSafeExternalHttpUrl`, `isCanonicalHttpUrl`, and `SSRF`. Justify only true local/bodyless/request/header/historical occurrences.
- [ ] Dispatch a most-capable whole-branch reviewer; fix every Critical/Important finding, re-run covering tests, and perform one scoped re-review.
- [ ] Commit final documentation/remediation as `Document compatibility recovery behavior`.
