# Compatibility-First Request Processing Design

## Status

Approved for implementation by the project owner on 2026-08-21. This design
replaces proxy-imposed protocol policing with tolerant preparation and
best-effort routing across every public AI request surface.

## Problem

`copilot-api` is a general compatibility proxy used by Claude Code, Claude
Desktop, Codex, Codex CLI, Gemini, Gemini CLI, big-AGI, OpenCode, and other
clients with evolving or partially incompatible request dialects. PR #60 added
strict local contract validators for Messages, Chat Completions, Responses,
Google AI, token counting, translations, and Responses WebSocket frames.

Those validators made the proxy less compatible than either side of the
connection:

- Claude Code now sends mid-conversation `role: "system"` messages. The proxy
  rejected them locally even though current native Claude models support them.
- Unknown and future fields, content blocks, tool types, and role variants can
  be rejected before an upstream provider gets a chance to accept them.
- Translation fidelity scanners turn imperfect-but-usable requests into local
  400 responses instead of preserving, approximating, or omitting only the
  unsupported portion.
- Google and token-count compatibility paths reject extensions that could be
  ignored, forwarded, or estimated.
- PR #60/61 terminal sanitization drops `namespace` from a Responses
  `function_call`. WebSocket continuation then pairs a namespaced tool output
  with a corrupted prior call and Copilot returns deterministic HTTP 400.

The result conflicts with the core product goal: maximize the probability that
a request from any reasonable AI chat client completes successfully.

## Product Principle

For authenticated requests, `copilot-api` prefers completing the request over
enforcing a locally invented interpretation of a client protocol.

The request pipeline is:

1. Parse enough structure to route safely.
2. Preserve the original request and unknown extensions.
3. Prefer a native upstream endpoint and forward its dialect opaquely.
4. If translation is required, translate recognized concepts and degrade
   unrepresentable concepts with explicit compatibility telemetry.
5. Apply only upstream-proven normalizations needed to obtain a successful
   response.
6. Return a local client error only when the proxy cannot parse, authorize,
   safely bound, route, or serialize any meaningful request.

Compatibility is more important than local schema purity. A provider may still
reject a request; the proxy must not pre-emptively reject a shape merely because
its current TypeScript union does not know it.

## Validation Boundary

### Checks that remain

These are operational boundaries, not client-protocol semantic validation:

- HTTP bodies and WebSocket frames must be parseable JSON when the route needs
  structured JSON.
- Authentication, authorization, administrator-only routes, trusted-proxy
  handling, and IP allowlists remain fail closed.
- Header values remain bounded and stripped of control characters before
  forwarding.
- Payload size, attachment download, media recovery, web-search iteration, and
  other resource-abuse limits remain bounded.
- WebSocket protocol envelopes must identify a usable action and preserve
  continuation ownership. Unknown optional envelope fields are ignored.
- Account-bound encrypted/session history must not be replayed across accounts
  merely to avoid an error.
- Values must remain safely cloneable/serializable before transport. Unsafe
  JavaScript objects, accessors, proxies, cycles, and non-JSON values may be
  converted or rejected at the transport boundary.

### Proxy semantic checks that are removed

The proxy will not locally reject an authenticated request solely because of:

- an unknown or newly introduced role, content block, item, tool, or field;
- a known field having a client-specific representation;
- tool history ordering or a missing local cross-reference;
- conflicting sampling, token, reasoning, or state controls;
- an unsupported translation concept;
- an unknown Google generation option;
- a header extension that can be safely dropped;
- a model capability mismatch that another advertised endpoint can attempt.

## Native Forwarding

When the selected model advertises the incoming protocol's native endpoint:

- clone the plain JSON body without applying a schema allowlist;
- remove only fields owned exclusively by this gateway;
- preserve unknown top-level fields and nested records;
- sanitize transport headers without rejecting the request;
- apply only narrow, observed upstream compatibility transforms;
- allow the upstream provider to decide whether a semantic combination is
  supported.

Native forwarding is the highest-fidelity route and must not depend on the
proxy's closed TypeScript unions.

## Tolerant Preparation

Each protocol keeps a preparation function, but preparation becomes a
normalizer rather than a validator.

Preparation may:

- derive a usable model identifier when a string-like value is available;
- default omitted upstream-required numeric limits from model metadata;
- discard invalid optional controls instead of rejecting the entire request;
- resolve mutually exclusive controls deterministically using existing
  upstream-specific precedence;
- normalize empty or null tool controls to omission;
- preserve unknown content and records verbatim on native routes;
- attach normalization classes to observability.

Preparation must not fabricate substantive user content or silently change the
meaning of valid known fields.

## Translation Policy

Translation scanners become advisory. They return compatibility findings used
to select the least-lossy endpoint and to record telemetry, but do not directly
throw `endpoint_translation_unsupported`.

When translation is unavoidable:

- recognized fields are translated normally;
- unknown records are preserved in an extension-compatible location when the
  destination supports one;
- unsupported optional controls are omitted with a normalization event;
- unsupported content becomes a short omission breadcrumb only when dropping
  it silently would break conversational continuity;
- native fallback is attempted before approximation when available;
- the upstream response is preferred over a local semantic 400.

A hard translation failure remains possible only when no advertised endpoint
can carry any meaningful request, such as a document-only request where every
available endpoint lacks document or text representation. That failure must be
rare, safe, and describe the routing limitation rather than label the client
payload invalid.

## Protocol-Specific Requirements

### Anthropic Messages

- Accept and preserve `user`, `assistant`, `system`, and future roles on native
  Messages routes.
- Accept unknown content blocks and tool definitions.
- Do not require `max_tokens` locally; fill it from the model output limit when
  the chosen upstream requires it.
- Sanitize or omit malformed optional Anthropic headers instead of returning a
  local 400.
- Token counting shares tolerant preparation and can estimate when native
  counting cannot accept an extension.

### OpenAI Chat Completions

- Do not enforce a closed role/content/tool union.
- Do not reject legacy `function`/`function_call`, custom roles, null optional
  controls, incomplete tool histories, or unknown content parts.
- Normalize conflicts only for the chosen upstream and preserve native fields.

### OpenAI Responses

- Preserve unknown input items, tools, top-level fields, state controls, and
  context-management extensions on the native Responses route.
- Remove the proxy's unconditional blocked-tool list. Endpoint selection and
  upstream behavior decide support.
- Treat invalid optional controls as absent instead of rejecting the request.
- Preserve namespaced tool identity in terminal events and WebSocket snapshots.

### Responses WebSocket

- Continue requiring parseable text JSON and a recognizable create action.
- Normalize `stream: false` to streaming operation because the transport itself
  is streaming.
- Ignore invalid optional attribution such as `initiator` rather than rejecting
  the frame.
- Preserve continuation IDs, model/account affinity, call IDs, namespaces,
  tool calls, and tool outputs exactly enough for upstream continuation.

### Google AI

- Unknown generation fields and tool variants do not produce local 400s.
- Translate recognized parts and omit or preserve extensions best-effort.
- Keep the existing generate and stream routes resilient; add tolerant
  `countTokens` routing/estimation if the public route advertises it.

## Upstream Error Resilience

The proxy does not blindly retry deterministic 400 responses. A compatibility
retry is allowed once only when all of the following hold:

- the request reached an upstream provider;
- the error matches a known safe compatibility class;
- the retry applies one bounded, deterministic normalization;
- the retry cannot cross an account-bound session/history boundary;
- the shared retry budget permits another send.

Examples include removing an optional unsupported control or choosing another
advertised endpoint. The original and retry normalization class must be visible
in safe telemetry. Raw upstream details remain limited to administrator-only
LLM Debug.

## Observability

- Ordinary logs, Sentry, and client errors remain sanitized.
- Compatibility normalizations record protocol, route, and normalization class.
- Upstream deterministic failures record a safe upstream code/class so
  `Upstream request failed` is diagnosable without exposing payloads.
- Administrator-only LLM Debug continues to capture raw request/response data
  for ten minutes.
- Local semantic rejection counters should fall to zero for public inference
  paths after migration.

## Testing Strategy

Tests are behavior-first and must demonstrate red-green cycles for:

- Claude Code `messages: [{role:"user"}, {role:"system"}]` forwarding;
- future/unknown Messages roles, blocks, tools, and fields;
- null, legacy, custom-role, and incomplete Chat Completions inputs;
- future Responses fields, tools, items, and state controls;
- namespaced `function_call` plus `function_call_output` WebSocket continuation;
- tolerant WebSocket optional fields and forced streaming;
- Google unknown fields and tool variants;
- token-count fallback on extension-rich payloads;
- translation findings degrading rather than throwing local 400s;
- malformed JSON/auth/resource/state boundaries continuing to fail safely.

The full Bun test suite, typecheck, lint, build, generated UI consistency, and
`git diff --check` must pass before publication.

## Rollout and Compatibility Risk

This change intentionally moves some errors from local validation to upstream
providers. That is acceptable: providers have the authoritative and evolving
contract. The main risks are forwarding a combination that a provider rejects,
or approximating a translation too aggressively. Native forwarding,
normalization telemetry, bounded compatibility retries, and regression tests
limit those risks.

No production configuration change or direct live patch is part of this work.
The implementation ships through a reviewed pull request and normal deployment
workflow.
