# Copilot API Contract Parity and Production Hardening Design

**Date:** 2026-08-17
**Status:** Approved in chat; written review pending

## Problem

The gateway currently passes its full test suite and successfully serves live
Chat Completions, Responses, Messages, and tool-calling requests. It also
contains important compatibility behavior that the upstream service does not
provide on behalf of arbitrary OpenAI-, Anthropic-, Google-, Claude Code-, or
Codex-shaped clients: dialect translation, model aliases, deterministic
multi-account affinity, payload recovery, WebP conversion, local WebSocket
continuations, and MCP-backed web search.

The upstream Copilot API contract has nevertheless moved faster than parts of
the gateway. The current implementation pins older API versions, reconstructs
model records through a fixed field list, selects native Messages only for a
small set of attachment cases, strips newer documented Responses fields, does
not forward Anthropic beta headers, drops root-level Messages cache control,
and implements token counting as a local estimate that can degrade to the
constant value `1`. The local Responses WebSocket protocol also differs from
the current Copilot CLI and backend in validation, continuation errors,
per-turn attribution, and response metadata.

These gaps create two classes of failure:

1. deterministic upstream rejections, including avoidable HTTP 400, 413, and
   endpoint/model mismatch responses; and
2. silent semantic loss, where a request succeeds but caching, reasoning,
   tool, billing, attribution, or model-discovery fields disappear.

The reference material is not internally perfect. Narrative documentation,
generated schemas, client behavior, and backend enforcement disagree on some
routes, defaults, tool support, stream sentinels, and optional fields. The
gateway therefore needs an explicit source-precedence policy and contract
boundaries rather than another collection of one-off exceptions.

## Evidence Baseline

The design was derived from an exhaustive read-only comparison of:

- the complete Copilot integrator documentation and generated API reference;
- the current Copilot documentation, including API-version and native-endpoint
  migration guidance;
- the current Copilot CLI/agent runtime request builders and stream parsers;
- the current Copilot API backend routes, validators, transformations,
  provider selection, retry behavior, and tests; and
- every relevant route, service, transport, and compatibility test in this
  gateway.

Before any production edit, the gateway baseline completed with:

- 1,060 passing tests;
- 3 expected skips caused by the local Bun version lacking the pinned
  production image behavior; and
- 0 failures.

The integration portion of that suite used real GitHub/Copilot credentials and
live upstream model discovery and inference. This establishes that the
following design addresses contract drift and missing coverage rather than an
already-broken baseline.

## Source Precedence

When references disagree, implementation decisions use this order:

1. **Backend-enforced behavior** determines what the current service accepts,
   transforms, rejects, and emits.
2. **Explicit integrator guidance** determines the intended public contract
   where the backend permits more than one behavior.
3. **Live `/models` metadata** determines model visibility, endpoint support,
   capabilities, limits, policy, and billing for the authenticated account.
4. **Current first-party client behavior** defines compatibility requirements
   for payloads, headers, streaming, continuation, and recovery that real
   clients depend on.
5. **Generated OpenAPI/schema material** supplies types and field inventories
   only where it is consistent with the preceding sources.

This precedence applies to both code and tests. A generated-schema defect must
not make the gateway reject a request that the backend and narrative contract
accept. Conversely, a broad schema union must not cause the gateway to send a
field that current backend validation explicitly blocks.

## Goals

- Send an explicit, current Copilot API version on every upstream request.
- Make live `supported_endpoints` the single authority for model-to-endpoint
  routing.
- Preserve the caller's requested dialect whenever the selected model supports
  it.
- Use provider-native endpoints when a compatibility translation is required
  and the requested endpoint is unavailable.
- Refuse a translation locally when it would discard essential reasoning,
  tool, media, or continuation semantics.
- Accept and correctly proxy the current documented Responses and Messages
  request fields instead of silently stripping them.
- Preserve current upstream model metadata while adding gateway aliases and
  virtual models.
- Match protocol-native streaming, error, usage, quota, and continuation
  semantics closely enough for current OpenAI, Anthropic, Claude Code, and
  Copilot CLI clients.
- Preserve the gateway's intentional local compatibility extensions.
- Prevent ordinary logs, Sentry, and client errors from leaking raw upstream
  data while retaining exact administrator-only LLM Debug capture.
- Cover each confirmed gap with a failing-then-passing regression and a
  focused live probe where safe and meaningful.

## Non-goals

- Acting as an internal trusted-service client using Copilot's private HMAC
  authentication path.
- Replacing the gateway's external API-key, OAuth, IP, or administrator
  authentication model with upstream authentication semantics.
- Persisting conversation-to-account mappings, upstream session IDs, or
  control-plane session-token mappings.
- Exposing private upstream deployment names, provider credentials, raw
  validation bodies, or signed attachment URLs to ordinary clients.
- Guaranteeing support for a feature that the authenticated Copilot account,
  integration, model, provider, policy, or feature flags do not enable.
- Enabling internal-only models or tools by bypassing upstream authorization.
- Removing compatibility endpoints used by existing OpenAI, Anthropic,
  Google, Claude Code, or Codex clients.
- Rewriting the gateway as a byte-for-byte transparent proxy. Translation and
  local recovery remain necessary parts of the product.

## Operating Invariants

### Endpoint authority

No inference request may be sent to an upstream endpoint absent from the
selected model's live `supported_endpoints`.

The sole legacy exception is an omitted `supported_endpoints` array, which is
treated as `/chat/completions` only. This matches the upstream compatibility
contract for older model records.

### Translation fidelity

A cross-dialect bridge may run only when all request concepts required by the
turn have an explicit mapping. It must not silently discard:

- encrypted or signed reasoning state;
- tool calls, tool results, call IDs, or custom/deferred tool declarations;
- image or document content;
- structured-output constraints;
- prompt-cache controls;
- continuation identity; or
- terminal/partial stream state.

If no lossless mapping exists, the gateway returns a local protocol-native
`400` with code `endpoint_translation_unsupported` and names only the source
and target API families plus the unsupported concept.

### Account and encrypted-history continuity

The existing hash-only routing contract remains in force. Identified
conversations retain deterministic account selection and deterministic
upstream session identity. Endpoint routing must not move an identified
conversation to another account, and retry logic must not replay encrypted
history against another account.

### Error privacy

Administrator-only LLM Debug remains the sole raw upstream traffic store.
Ordinary logs, telemetry, Sentry, and client responses use fixed local
messages or explicitly allowlisted, non-sensitive upstream error classes.

## Architecture

The hardening work introduces five shared contract boundaries:

1. `copilot-contract.ts` owns API version, integration identity, supported
   public paths, safe header forwarding, and protocol constants.
2. `endpoint-routing.ts` owns model endpoint interpretation and translation
   eligibility.
3. Per-protocol request preparation owns field validation and normalization at
   the last boundary before upstream transport.
4. Per-protocol error adaptation owns safe HTTP and in-band stream errors.
5. Contract fixtures and route matrices keep the implementation synchronized
   with the reviewed upstream behavior.

Handlers remain responsible for client-dialect behavior and observability.
Transport remains responsible for authentication, account routing, retries,
quota capture, and cancellation. The new boundaries remove duplicated endpoint
and field decisions without merging unrelated protocol translators into one
large abstraction.

## API Version and Integration Identity

### Version

Use `2026-08-01` as the single upstream `X-GitHub-Api-Version` for model
discovery, Chat Completions, Responses, Messages, token counting, policy, Auto,
and model-session control-plane calls.

The version is cumulative and is the newest version verified in the reviewed
backend and first-party CLI snapshots. It adds exact decimal model pricing,
Auto metadata, consumed-credit quota data, TTL-aware cache-write pricing, and
`recommended_auto_tier` while retaining earlier Responses, structured-error,
and billing contracts.

The version is sent as a header rather than a query parameter. Client-supplied
version headers do not control the gateway's upstream contract; the gateway
must parse one stable response shape internally.

### Integration ID

Add `COPILOT_INTEGRATION_ID` as an optional configuration value. It defaults to
the existing `vscode-chat` value to avoid changing entitlement and feature-flag
behavior for current deployments. Every upstream request uses the resolved
value consistently.

The gateway must not impersonate `copilot-developer-cli` merely because that
client is one compatibility target. Operators with a dedicated assigned
integration ID can configure it explicitly.

## Header Contract

### Stable identity headers

For identified conversations, retain the existing deterministic derived UUID
for:

- `X-Interaction-Id`; and
- `X-Client-Session-Id`.

For `X-Agent-Task-Id`, preserve a sanitized client-provided task ID when one is
available; otherwise retain the deterministic derived UUID fallback. Preserve
a sanitized `X-Parent-Agent-Id` independently when supplied. This adds
sub-agent attribution without changing the stable conversation/cache identity.

Unidentified requests retain the current process-level session fallback.

### Per-request attribution

Forward or derive the following through one typed request context:

- `X-Initiator`, restricted to `user` or `agent`;
- `X-Interaction-Type`;
- `X-Agent-Task-Id` and `X-Parent-Agent-Id`;
- `X-Client-Session-Id`;
- `X-Client-Machine-Id`;
- repository NWO and repository host headers;
- `Copilot-Harness-Id` and `Copilot-Subsystem-Id`;
- `Openai-Intent`;
- client experiment-assignment context; and
- the gateway-generated `X-Request-Id`.

Known headers receive length and character validation. The gateway does not
perform generic inbound-header passthrough.

### Response metadata

Continue returning all `X-Quota-Snapshot-*` headers from the successful final
attempt. Also preserve safe request/service IDs, retry information,
experiment-assignment context, training-eligibility metadata, and
`Retry-After` when present. Hop-by-hop, authentication, cookie, and provider
internal headers remain excluded.

## Model Discovery

### Preserve upstream records

Model discovery starts from a clone of each complete upstream model object.
The gateway adds OpenAI-compatible display fields, aliases, virtual reasoning
variants, and gateway WebSocket capability without reconstructing the object
from a fixed property list.

This preserves current and future fields including:

- `auto`, `is_chat_default`, and `is_chat_fallback`;
- `billing.promo` and `billing.auto_discount`;
- tiered decimal token prices and `cache_write_1h_price`;
- `info_messages`, warning arrays, and warning details;
- custom-model metadata; and
- future optional fields already accepted by JSON clients.

### Visibility

The upstream response is already account, integration, plan, policy, and
feature scoped. Preserve the existing gateway rule that exposes models that
are picker-enabled or explicitly policy-enabled. Alias and redirect-source
rows may be created from non-visible target metadata, but only configured
aliases are exposed.

### Endpoint annotations

Preserve upstream `supported_endpoints`. Add local `ws:/responses` only when
the gateway can serve its Responses WebSocket compatibility protocol for that
model. This local entry describes gateway capability, not necessarily a direct
upstream WebSocket connection.

### Additional model routes

- `GET /models/:model` and `GET /v1/models/:model` return the same normalized,
  aliased model representation as the list route.
- `POST /models/:model/policy` and its `/v1` alias forward to the account chosen
  by the same deterministic affinity context as inference. In multi-account
  mode without an affinity key, the existing conservative first-eligible
  account is used; the gateway does not broadcast legal/policy acceptance to
  every configured account.
- Upstream status and safe error classification are preserved.

## Endpoint Routing

Create one pure endpoint-capability module with these primitives:

- interpret missing endpoint metadata as Chat Completions only;
- answer whether a model supports Chat, Responses, Messages, Embeddings, and
  upstream Responses WebSocket;
- choose a provider-native endpoint for a requested source dialect;
- classify whether a particular payload can be translated without loss; and
- produce a structured route decision for logging and tests.

### Inbound Chat Completions

1. Use `/chat/completions` when advertised and the payload contains no concept
   that Chat cannot carry.
2. If Chat is unavailable or the payload needs a native feature:
   - prefer `/v1/messages` for Anthropic models when the Messages bridge can
     preserve the payload;
   - otherwise use `/responses` when the Responses bridge can preserve it.
3. Return `endpoint_translation_unsupported` when neither bridge is lossless.

PDF/document parts, Anthropic-native signed thinking, and Anthropic-only tool
features prefer Messages. OpenAI reasoning state, custom/freeform tools, and
Responses-native items prefer Responses.

### Inbound Responses

1. Use `/responses` when advertised.
2. For an Anthropic model that lacks Responses but advertises Messages, use a
   Responses-to-Messages bridge only for the explicitly supported subset.
3. Otherwise use the existing Responses-to-Chat bridge when Chat is
   advertised and the payload is representable.
4. Reject rather than discard Responses-only state.

The new Responses-to-Messages bridge is deliberately narrower than the native
Messages route. It supports text/image/document messages, function tools and
results, sampling, max output tokens, system instructions, and structured
reasoning configuration. It rejects opaque OpenAI reasoning items, item
references that cannot be expanded, unsupported hosted tools, and custom tool
grammars without an Anthropic equivalent.

### Inbound Messages

1. Use `/v1/messages` whenever advertised, even when `/responses` or
   `/chat/completions` is also present.
2. Otherwise use the existing Messages-to-Responses path when Responses is
   advertised and the request is representable.
3. Otherwise use Messages-to-Chat when Chat is advertised or endpoint metadata
   is absent.
4. Reject if no route preserves required blocks or thinking signatures.

This makes native Messages the ordinary path rather than a PDF/ToolSearch-only
special case.

## Responses Request Contract

### Accepted top-level fields

The reviewed compatibility set includes the current public fields:

- `model`, `input`, `instructions`, `max_output_tokens`, `metadata`, `user`;
- `tools`, `tool_choice`, `parallel_tool_calls`;
- `reasoning`, `text`, `temperature`, `top_p`, `include`;
- `context_management`, `truncation`;
- `prompt_cache_key`, `prompt_cache_options`, `prompt_cache_retention`;
- `safety_identifier`, `snippy`, `multi_agent`;
- `store`, `background`, `previous_response_id`, `service_tier`; and
- `stream`.

Retain existing Copilot/CLI compatibility fields that the gateway already
handles, including `prompt`, `conversation_id`, `generate`, `client_metadata`,
`task_budget`, and `copilot_cache_control`.

The sanitizer becomes an explicit compatibility inventory with a contract
test, not an undocumented handwritten list. Unknown top-level fields continue
to be omitted because the current backend also uses typed top-level decoding;
unknown nested properties remain intact.

### Stateful fields

- Accept omitted, `null`, or `false` `store`; normalize the final request to
  `store:false`.
- Reject `store:true` with a safe local `unsupported_value` error.
- Accept omitted, `null`, or `false` `background`; remove false/null before
  forwarding.
- Reject `background:true`.
- On HTTP, reject non-empty `previous_response_id` because the upstream public
  endpoint is stateless.
- On the local WebSocket protocol, handle `previous_response_id` through the
  connection-scoped continuation rules described below.
- Reject any caller-supplied `service_tier` rather than silently pretending it
  took effect.

### Reasoning

Accept documented string efforts and integer efforts. Preserve model suffix
and configured default behavior, subject to live model capabilities.

When effort is `none`:

- do not inject a reasoning summary;
- do not add `reasoning.encrypted_content` to `include`; and
- preserve an explicitly supplied unrelated `include` list.

When reasoning is enabled, add encrypted reasoning inclusion only if absent.
Do not duplicate it. Preserve existing GPT-5.6 sampling normalization and
model-specific unsupported-parameter handling.

### Prompt caching

Preserve:

- `prompt_cache_options`, including explicit-only mode;
- `prompt_cache_retention` for upstream model/provider transformation;
- per-content `prompt_cache_breakpoint` objects in text, image, and file
  blocks; and
- cache-read/cache-write usage fields in responses and translations.

The caller's `prompt_cache_key` and `safety_identifier` are accepted for client
compatibility but never treated as authoritative. The upstream service may
replace them. Ordinary logs and error payloads continue to redact them.

### Context management

Preserve `context_management` entries of the current supported `compaction`
and `truncate` types and preserve `truncation`. Reject malformed or unsupported
context-management item types locally with a stable error rather than sending
a deterministic upstream 400.

Gateway-specific compaction-item expansion and payload fitting remain
separate from native context-management controls.

### Tools

Continue supporting function, namespace, custom/freeform, shell/apply-patch,
programmatic tool calling, web search, and other client-executed tool types the
backend permits.

Reject tool types the backend always blocks:

- `code_interpreter`;
- legacy `computer_use` and `computer_use_preview`;
- `file_search`;
- `local_shell`;
- `mcp`; and
- `mcp_list_tools`.

Forward modern `computer`, `image_generation`, web search, programmatic tools,
and unknown client-executed tool types so upstream feature flags and model
capabilities remain authoritative. Existing Computer Use screenshot and WebP
normalization remains active.

Empty tools continue to remove `tools`, `tool_choice`, and
`parallel_tool_calls`. Real tools preserve all three controls.

### Media and payload recovery

Retain the existing 32 MiB Responses recovery path, compaction bootstrap
preservation, recursive media discovery, historical-before-current removal,
and safe local 413 behavior.

The hard cap remains tied to the verified CLI/integration contract. An upstream
413 is treated as a changed account/integration limit and surfaced safely; it
does not trigger text truncation or an unbounded second implementation.

## Messages Request Contract

### Native-first body handling

Native Messages preparation switches from a narrow top-level allowlist to a
clone-and-denylist policy. Preserve all top-level and nested Anthropic fields
that the caller supplied except explicitly gateway-local helper fields that
are never part of the wire request.

This preserves root and nested `cache_control`, `fallback_credit_token`,
`stop_details`, adaptive thinking controls, advanced tool metadata,
compaction/context-management fields, and future provider-compatible fields.

The existing JSON serializer continues normalizing every ephemeral nested
`cache_control` marker to `type` plus a supported `ttl`, removing unsupported
client-only keys such as `scope` without mutating the caller's payload.

### Required fields

Validate `model`, non-empty `messages`, and `max_tokens` for inference requests
at the public Messages boundary. Return an Anthropic-shaped
`invalid_request_error` for missing or invalid required fields.

`count_tokens` requires `model` and `messages` but not `max_tokens`.

### Headers

- Preserve a non-empty inbound `anthropic-version`; otherwise use
  `2023-06-01`.
- Canonicalize comma-separated `Anthropic-Beta` whitespace and duplicates,
  then forward the resulting beta identifiers without locally rewriting their
  names or classifications. Copilot remains responsible for
  allow/remove/reject and provider-specific rewriting.
- Preserve `X-Model-Provider-Preference` when supplied; upstream authorization
  and provider availability remain authoritative.
- Continue consuming beta values locally for compatible alias/model-variant
  selection, but do not consume them instead of forwarding them.

### Sampling and effort

Stop preemptively deleting Messages sampling or `output_config.effort` merely
because the proxy's local model table predicts an upstream transformation.
Forward valid values and let the current Copilot Messages pipeline apply its
model/provider-specific removals, defaults, and validation.

The gateway still rejects invalid JSON types and impossible bridge mappings at
its public boundary.

### Token counting

For Copilot models, `POST /v1/messages/count_tokens` forwards the normalized
native request to the upstream count-tokens endpoint with the same model,
media, beta, version, provider-preference, account-affinity, and cancellation
context as inference.

The upstream endpoint already chooses native provider counting or a meaningful
server-side estimate. Do not replace upstream failures or unknown models with
`{"input_tokens":1}`.

Local estimation remains available only for configured custom providers that
do not have a Copilot count-tokens endpoint. Errors remain explicit.

### Streaming

Preserve Anthropic event names and ordering. Continue removing the backend's
current trailing bare `[DONE]` compatibility sentinel before strict Anthropic
clients receive it. Preserve `copilot_usage` on final `message_delta` and
`recommended_auto_tier` on `message_start` when present.

## Chat Completions Contract

Preserve all currently supported Chat fields, including:

- `max_tokens` and `max_completion_tokens`, with a local mutual-exclusion
  validation;
- modern `tools`/`tool_choice` and deprecated `functions`/`function_call`;
- `reasoning_effort`, `thinking_budget`, `prediction`, and structured output;
- string or array stop sequences;
- logprob controls, penalties, seed, user, and model-specific extensions; and
- signed/opaque reasoning fields on message history.

Direct Chat calls retain current prompt-caching, attachment normalization,
assistant-prefill compatibility, JSON instruction, stream usage, and `[DONE]`
behavior. Cross-dialect translations receive explicit fixtures for every
field they preserve or reject.

## Responses WebSocket Contract

The gateway continues providing a local Responses WebSocket compatibility
transport. It may use direct upstream WebSocket in a later isolated change,
but this design does not require replacing the proven HTTP-backed transport.

### Input validation

- Accept JSON text frames with `type:"response.create"`.
- Reject binary frames, invalid JSON, wrong message types, and
  `stream:false` with recoverable error frames while keeping the connection
  open.
- Stop silently accepting `response.processed` as a create request.
- Force streaming only after validating that the caller did not explicitly
  disable it.

### Continuations

Connection-scoped response snapshots remain the no-storage implementation.
Only IDs issued on the current gateway connection can be rehydrated.

Unknown or stale IDs return a recoverable error with code
`previous_response_not_found`, not a generic `bad_request`. This allows current
clients to perform their one-shot full-history replay. Omission of
`previous_response_id` starts a new local thread. Successful continuation
merges only unacknowledged input and clears the field before the stateless HTTP
upstream call.

The gateway does not claim support for arbitrary externally-created response
IDs because doing so would require direct upstream persistent state or local
storage.

### Per-turn metadata

Parse the frame's top-level `headers`, `initiator`, `agent_task_id`, and
`parent_agent_id`. Apply the same safe header contract as HTTP to each turn and
pass the resulting typed context to the upstream HTTP request.

### Output metadata

Attach safe successful-attempt headers and quota snapshots to outgoing events
using the current Responses WebSocket envelope fields. Preserve event body and
ordering. Do not inject metadata into an event after the stream has already
terminated.

### Replay safety

Never replay a WebSocket turn after any substantive model output has been sent
to the client. Transport recovery and full-history retry are allowed only
before output, remain bounded, and preserve the same account.

## Control-Plane Compatibility

The gateway adds authenticated passthrough routes used by current first-party
clients:

- `POST /models/session`;
- `POST /models/session/intent`; and
- `POST /auto`.

These routes use the same configured integration ID, API version, request ID,
safe header context, and deterministic account affinity as inference.

In multi-account mode, callers must supply a supported affinity identity to
guarantee that a returned model-scoped session token is reused against the
same account. Without affinity, the gateway retains first-eligible routing but
does not promise cross-request session-token continuity. No token-to-account
map is stored.

`Copilot-Session-Token` is forwarded only on these control-plane and matching
inference requests. It is never logged, returned through dashboard config, or
used as gateway authentication.

## Error Semantics

### HTTP

- Chat and Responses local errors use the OpenAI/Copilot error envelope.
- Messages and count-tokens local errors use the Anthropic error envelope.
- Preserve HTTP status, `Retry-After`, quota headers, and safe machine-readable
  upstream codes.
- Continue mapping quota exhaustion to 402 and deprecated client versions to
  466.
- Known deterministic validation classes may preserve fixed safe messages.
- Unknown upstream messages and bodies remain canonicalized.

### Streaming

- Chat streams end with `[DONE]`.
- Responses streams preserve named events and do not add `[DONE]`.
- Messages streams preserve named Anthropic events and remove the backend's
  extra bare `[DONE]`.
- Once headers are committed, failures travel in-band using the source
  protocol's error event.
- Partial output emitted before an error remains visible.

### Retry behavior

Retain the shared maximum of three upstream sends for a routed logical call,
including transport retry, account reinitialization, and eligible failover.

Do not retry deterministic 4xx validation, 402, 413, 422, 424, or 466. Honor
`Retry-After`, preserve cancellation during backoff, and never replay after
streamed output. Identified sessions retain same-account behavior from the
hash-only affinity design.

## Observability and Privacy

Add structured, bounded diagnostics for:

- requested dialect, selected upstream dialect, and translation reason;
- unsupported translation concept;
- contract normalization class;
- API version and configured integration identifier;
- beta-header count and disposition only when known locally, never values in
  ordinary logs;
- WebSocket continuation recovery class;
- upstream status, safe error class, and successful response metadata; and
- request byte recovery counts already defined by existing payload handling.

Do not log request bodies, prompts, cache keys, safety identifiers, session
tokens, beta-header contents, attachment URLs, encrypted reasoning, or raw
upstream errors outside LLM Debug.

## Compatibility Documentation

Add a durable `docs/copilot-api-compatibility.md` report containing:

- supported public routes and aliases;
- endpoint-routing precedence;
- accepted, normalized, rejected, and local-extension fields by protocol;
- streaming termination behavior;
- multi-account/session-affinity constraints;
- control-plane session-token requirements;
- intentional differences from upstream, including local WebSocket snapshot
  scope and MCP-backed search; and
- the verification matrix and date of the last contract audit.

This document must not contain local filesystem paths, private source excerpts,
credentials, internal hostnames, or raw upstream examples containing user data.

## File Boundaries

Expected implementation boundaries include:

- `src/services/copilot/copilot-contract.ts`: API version, integration ID,
  typed safe headers, response metadata allowlist.
- `src/config.ts`, `src/start.ts`, `.env.schema`, and operator documentation:
  optional `COPILOT_INTEGRATION_ID` configuration with the compatibility
  default described above.
- `src/lib/endpoint-routing.ts`: endpoint interpretation, route selection, and
  translation-fidelity decisions.
- `src/services/copilot/copilot-client.ts`: compose the shared contract headers
  and expose successful response metadata.
- `src/services/copilot/get-models.ts` and `src/routes/models/route.ts`:
  current model types, upstream-field preservation, single-model and policy
  routes.
- `src/services/copilot/create-responses.ts`: current field inventory,
  validation/normalization, reasoning-none behavior, caching/context controls.
- `src/services/copilot/create-anthropic-messages.ts`: native clone-and-denylist
  preparation and forwarded Messages headers.
- a focused count-tokens Copilot service and
  `src/routes/messages/count-tokens-handler.ts`: upstream native counting.
- Chat, Responses, and Messages handlers/bridges: centralized endpoint routing
  and lossless-translation gates.
- Responses WebSocket modules: frame validation, compatible continuation
  codes, per-turn metadata, and response envelopes.
- control-plane routes/services for policy, model session, intent, and Auto.
- `src/lib/error.ts` plus protocol adapters: safe protocol-native errors.
- `tests/fixtures/capi-contract/`: minimal reviewed wire fixtures without
  secrets or private source text.
- focused unit/integration tests and `docs/copilot-api-compatibility.md`.

Exact filenames may be adjusted during implementation when an existing module
already owns the responsibility. The architectural boundaries and acceptance
criteria must remain unchanged.

## Test Strategy

Implementation follows red-green TDD. Every behavior change begins with a test
that fails for the confirmed current reason.

### Contract and version tests

- every upstream route receives API version `2026-08-01` and the configured
  integration ID;
- header/query precedence cannot let a client downgrade the upstream contract;
- 2026-08 model, billing, quota, usage, and recommendation fields parse without
  truncation or loss;
- response metadata comes only from the successful final attempt.

### Model and routing matrix

Cover models that are:

- Chat-only;
- Responses-only;
- Messages-only;
- Chat plus Responses;
- Chat plus Messages;
- Responses plus Messages;
- all three;
- missing `supported_endpoints`;
- policy-disabled or unconfigured; and
- locally aliased, redirected, custom, or virtual.

For each inbound dialect, assert the selected upstream endpoint and every
lossless/rejected translation case.

### Responses fixtures

Cover:

- omitted/null/false/true stateful fields;
- service-tier rejection;
- string and integer reasoning efforts, especially `none`;
- explicit cache options, retention, and nested breakpoints;
- compaction/truncate context management and invalid types;
- empty versus real tools;
- every always-blocked tool type and feature-gated/pass-through tool classes;
- custom/deferred/programmatic tools;
- unknown top-level omission and nested-field preservation;
- media normalization and existing oversized recovery;
- all relevant named stream events, usage/recommendation metadata, in-band
  errors, and no `[DONE]`.

### Messages fixtures

Cover:

- required-field validation;
- string and block-array system prompts;
- text, image, document, thinking, tool-use, and tool-result blocks;
- root automatic cache control and nested 5m/1h markers;
- scoped marker normalization without caller mutation;
- allowed, removed, rejected, unknown, duplicated, and mixed beta values by
  observing upstream behavior or mocked status, without duplicating a stale
  local allowlist;
- provider preference and inbound Anthropic version;
- adaptive/standard thinking and effort fields;
- fallback-credit fields;
- native count-tokens success, validation, media, and error behavior;
- Messages SSE lifecycle, usage, recommendation, errors, and removed `[DONE]`.

### Chat fixtures

Cover modern/deprecated tool fields, token-field conflicts, stop shapes,
reasoning state, prediction, structured output, assistant prefill, attachments,
stream usage, and every Chat-to-native translation gate.

### WebSocket fixtures

Cover invalid JSON, binary/wrong-type frames, `stream:false`, two-turn delta
continuation, omitted-ID new threads, stale-ID
`previous_response_not_found`, per-turn headers, response quota/assignment
metadata, connection model consistency, cancellation, no replay after output,
and Chat/native fallback behavior.

### Control-plane fixtures

Cover single-model retrieval, policy forwarding, Auto and model-session routes,
model-scoped session tokens, deterministic account selection, missing affinity
in multi-account mode, safe errors, and secret-free logs.

### Regression preservation

The existing full suite must continue covering:

- hash-only routing and deterministic upstream identity;
- account reinitialization and retry budgets;
- encrypted history and compaction markers;
- ordinary/compaction payload recovery and bootstrap retention;
- WebP/JPEG normalization;
- MCP-backed web search;
- custom providers, model redirects, Google AI, and Claude compatibility;
- raw administrator-only LLM Debug and sanitized ordinary boundaries; and
- nginx/auth/security invariants.

## Live Verification

After mocked and fixture tests pass, run a minimal authenticated live matrix
against the current Copilot service:

1. fetch `/models` with the pinned API version and confirm current endpoint,
   billing, and optional metadata parse correctly;
2. execute one basic non-streaming and one streaming request through each
   currently available native dialect;
3. execute native Messages `count_tokens`;
4. verify one Responses explicit-cache payload is accepted without asserting a
   cache hit;
5. verify one native Messages 5m cache-control payload;
6. verify a two-turn local Responses WebSocket continuation;
7. exercise one current first-party-client-shaped Responses request with tools,
   encrypted reasoning inclusion, and per-turn metadata; and
8. confirm intentionally invalid stateful/tool requests fail locally without
   contacting upstream.

Do not probe internal-only models, gated 1h caching, modern computer/image
tools, Auto, or provider pinning unless the live account advertises or already
uses the capability. Source/fixture verification is sufficient for unavailable
feature-flag branches.

## Verification Gates

Before completion:

- every new focused test passes after first demonstrating the intended failure;
- `bun test` passes with only documented platform skips;
- pinned Bun 1.3.14 media tests pass if media code changes;
- `bun run lint:all` has no new errors or warnings;
- `bun run typecheck` passes;
- `bun run build` passes;
- UI typecheck/build runs only if UI source changes;
- `git diff --check` passes;
- the compatibility document matches the implementation;
- an independent code review reports no Critical or Important findings; and
- the final report lists every reviewed reference area, implemented gap,
  intentional extension, live probe, and residual feature-flag limitation.

## Rollout

Implementation should be split into reviewable commits by contract boundary,
but delivered as one coherent compatibility change unless a discovered backend
constraint requires an isolated follow-up.

Recommended order:

1. version/header contract and model preservation;
2. endpoint router and native Messages precedence;
3. Responses field/validation parity;
4. Messages headers/body/count-tokens parity;
5. Chat and cross-dialect translation completeness;
6. WebSocket validation, continuation, and metadata parity;
7. control-plane routes and compatibility documentation;
8. full verification and targeted live probes.

Deployment uses the existing verified branch, pull-request, merge, and
`update.sh` workflow. Production verification checks health, revision, current
model discovery, one request per native dialect, token counting, WebSocket
continuation, logs, and Sentry. No production configuration or restart is
performed before the code is merged and all gates pass.

## Acceptance Criteria

- No request is sent to an upstream endpoint absent from live model metadata.
- Native Messages is the ordinary upstream path for Messages-capable models.
- Current documented Responses and Messages fields survive the gateway or are
  rejected with an explicit safe reason; none are silently lost through stale
  allowlists.
- The gateway uses API version `2026-08-01` consistently and preserves its
  cumulative response fields.
- Messages beta headers, provider preference, root cache control, fallback
  credit, and native token counting work through the proxy.
- Responses reasoning effort `none`, explicit prompt caching, context
  management, tool restrictions, and stateful-field validation match the
  reviewed backend contract.
- Model discovery retains upstream optional metadata while preserving aliases,
  virtual models, redirects, custom providers, and local WebSocket capability.
- Responses WebSocket clients receive compatible validation and stale
  continuation errors, per-turn attribution, and safe response metadata.
- Protocol-native errors and stream termination are correct for Chat,
  Responses, and Messages without expanding ordinary data exposure.
- Hash-only account affinity, encrypted-history continuity, payload recovery,
  compaction bootstrap, WebP conversion, search compatibility, and dashboard
  safety do not regress.
- The full automated and targeted live verification matrix passes, and the
  final compatibility report documents any remaining account/provider
  feature-flag limitations.
