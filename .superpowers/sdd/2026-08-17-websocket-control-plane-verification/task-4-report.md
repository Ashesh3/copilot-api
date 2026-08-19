# Phase 4 Task 4 Report: Account-Aware Copilot Control Plane

## Outcome

Implemented account-aware Copilot model-policy, model-session, Auto, and intent services and public authenticated routes.

Control-plane routing now reuses the existing model-independent SHA-256 rendezvous affinity without adding session-token maps or persistence. Policy calls select only healthy accounts whose raw `account.models` catalog advertises the requested model, deliberately bypassing inference overrides and `modelIndex`. Session, Auto, and intent calls select across all healthy accounts. A selected account may be reinitialized and retried after a 401, but is never replaced by cross-account failover.

The new transport uses the existing typed Copilot header builder and client, preserving configured authorization, integration ID, API version, request ID, typed attribution, safe response metadata, abort signals, and one normal retry budget. `Copilot-Session-Token` remains an opaque sanitized header value and is never logged, persisted, returned through errors, or used as an account key.

## Public Contract

- Added authenticated `POST /models/session`.
- Added authenticated `POST /models/session/intent`.
- Added authenticated `POST /auto`.
- Added authenticated model-policy aliases at `POST /models/:model/policy` and `POST /v1/models/:model/policy`.
- Model-session creation sends `{ "auto_mode": { "model_hints": ["auto"] } }`; refresh sends no body and forwards the typed session-token header.
- Auto forwards validated `prompt`, `has_image`, `tier`, `multi_turn`, and `previous_user_messages` fields.
- Intent requires a valid session-token header and forwards validated `prompt`, `available_models`, `has_image`, `previous_user_messages`, and `routing_intent` fields.
- Policy model IDs are percent-encoded upstream. A policy 403 returns the fixed compatibility result; other failures use the sanitized HTTP error boundary.
- Local validation uses fixed OpenAI/Copilot error envelopes. Unknown upstream bodies and session-token values are not reflected.

## Files

- Created `src/services/copilot/control-plane.ts` for typed policy/session/Auto/intent calls and record-shaped JSON validation.
- Created `src/routes/copilot-control-plane/route.ts` for authenticated route validation and request-context attribution.
- Created `tests/copilot-control-plane.test.ts` for exact wire contracts, routes, auth, multi-account affinity, malformed responses, and secret safety.
- Updated `src/lib/token-pool.ts` with read-only healthy/raw-catalog rendezvous selectors.
- Updated `src/lib/account-router.ts` with `routedControlPlaneFetch()` and same-account-only 401 recovery.
- Updated `src/routes/models/route.ts`, `src/server.ts`, and `src/lib/error.ts` for policy aliases, route mounting, and fixed local validation errors.
- Updated token-pool, account-router, and middleware tests for deterministic selection, typed headers, safe local 503 behavior, route registration, and authentication.

## TDD Evidence

- Selector RED: `bun test tests/token-pool.test.ts -t "control-plane|advertising model"` failed because `getHealthyAccountBySession()` and `getAccountAdvertisingModelBySession()` did not exist. The implemented selectors then passed the focused matrix.
- Transport RED: `bun test tests/account-router.test.ts -t "control-plane"` failed because `routedControlPlaneFetch` did not exist. The final transport matrix passed raw membership, exact headers/attribution, signal/body forwarding, local 503/no-send, same-account 401 recovery, and single-token mode.
- Service RED: `bun test tests/copilot-control-plane.test.ts` failed because the service module did not exist. Exact policy/session/Auto/intent service tests then passed.
- Route RED: exact route and middleware tests returned missing-route 404/500 responses and the protected-route matrix could not find the new mounts. The final routes, aliases, auth, validation, affinity, and secret-safety tests passed.
- Invalid opaque-token RED: a malformed refresh token sent neither the typed token nor the creation body. Both model-session and intent now normalize through `sanitizeCopilotHeaderValue()` before dispatch.

## Verification

- Final focused matrix:
  - `bun test tests/copilot-control-plane.test.ts tests/models-route.test.ts tests/token-pool.test.ts tests/account-router.test.ts tests/integration/middleware.test.ts`
  - 95 pass, 0 fail, 1,018 assertions.
- Full repository green run:
  - `bun test`
  - 2,378 pass, 3 expected media skips, 0 fail, 9,278 assertions across 121 files.
- After the final narrow invalid-token hardening, a repeated full run encountered five transient live Messages per-model 500s after an upstream `ECONNRESET`; no Task 4 path failed.
- Exact unchanged failing live subset rerun:
  - `bun test tests/integration/per-model.test.ts -t "Messages API"`
  - 16 pass, 0 fail, confirming the transient external classification without code changes.
- `bun run lint:all`: 0 errors and the same 5 pre-existing warnings outside Task 4.
- `bun run typecheck`: exit 0.
- `bun run build`: exit 0.
- `git diff --check`: exit 0.
- No UI source changed, so no UI build was required.

## Self-Review

- Confirmed policy selection uses raw healthy catalog membership and never the inference `modelIndex` shortcut.
- Confirmed Auto/session/intent selection uses the existing affinity key and never broadcasts.
- Confirmed identical affinity remains on one account, distinct affinity can select different accounts, and the opaque session token does not influence selection.
- Confirmed no session-token-to-account map, file write, persistence, or token-derived logging was added.
- Confirmed selected-account 401 recovery reuses only that account and cannot fail over.
- Confirmed request authorization, API version, integration ID, request ID, typed attribution, signal, safe response headers, and routed-account diagnostics reach the correct boundaries.
- Confirmed invalid or malformed session-token values cannot produce an intent send without the required header or a model-session refresh with neither token nor creation body.
- Confirmed upstream error bodies are retained only on `HTTPError` for centralized safe classification and are not read or logged by the service.

## Limitations

- In multi-account mode, callers without a supported affinity identity retain first-healthy selection and therefore do not receive a cross-request continuity guarantee for model-scoped session tokens.
- No token-to-account storage is intentionally provided.
- Direct live probing of feature-gated policy/Auto/session behavior was not forced; source-shaped fixture tests cover unavailable branches, while the repository's existing authenticated live integration suite remained the broader runtime check.
