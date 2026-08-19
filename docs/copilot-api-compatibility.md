# Copilot API Compatibility Contract

This report describes the gateway's reviewed public compatibility behavior. It
is a contract for clients and operators, not a promise that every upstream
feature is enabled for every account. Model availability and capabilities are
dynamic; clients must use model discovery instead of a static model list.

## Contract version and source precedence

The gateway sends Copilot API version `2026-08-01` and its configured
integration identity on upstream model, inference, token-count, policy, Auto,
and model-session requests. Client-supplied headers cannot downgrade that
upstream contract.

When sources disagree, compatibility decisions use this precedence:

1. behavior enforced by the current upstream service;
2. explicit integrator guidance;
3. live account-specific model metadata;
4. current first-party client behavior; and
5. generated schemas, when consistent with the preceding sources.

Live `supported_endpoints` metadata is authoritative for inference routing. A
model record that omits `supported_endpoints` receives the legacy
`/chat/completions` assumption only. A request is never sent to an endpoint that
the selected live record excludes.

## Public route and alias table

All data-plane and control-plane routes below use the gateway's normal inference
authentication when it is configured, unless a separate route-specific
authentication model is documented in the main README.

| Family | Method and canonical route | Aliases and notes |
| --- | --- | --- |
| Model discovery | `GET /v1/models` | `GET /models` |
| Single-model discovery | `GET /v1/models/:model` | `GET /models/:model` |
| Model policy | `POST /v1/models/:model/policy` | `POST /models/:model/policy`; account-aware passthrough, not a local policy emulator |
| Chat Completions | `POST /v1/chat/completions` | `POST /chat/completions` |
| Responses HTTP | `POST /v1/responses` | `POST /responses` |
| Responses compaction | `POST /v1/responses/compact` | `POST /responses/compact`; local compatibility compaction |
| Responses WebSocket | WebSocket upgrade on `/v1/responses` | WebSocket upgrade on `/responses` |
| Anthropic Messages | `POST /v1/messages` | No prefix-free alias |
| Anthropic token count | `POST /v1/messages/count_tokens` | No prefix-free alias |
| Embeddings | `POST /v1/embeddings` | `POST /embeddings` |
| Search compatibility | `POST /v1/alpha/search` | `POST /alpha/search` |
| Google-style generation | `POST /v1beta/models/:model:generateContent` | Also under `/v1/models` and `/models` |
| Google-style streaming | `POST /v1beta/models/:model:streamGenerateContent` | Also under `/v1/models` and `/models` |
| Google-style token count | `POST /v1beta/models/:model:countTokens` | Also under `/v1/models` and `/models` |
| Model session | `POST /models/session` | Opaque model-session passthrough |
| Model-session intent | `POST /models/session/intent` | Requires a valid `Copilot-Session-Token` header |
| Auto selection | `POST /auto` | Account and feature availability remain upstream-authoritative |

Other client-integration surfaces are documented in the README. They do not
change the inference contracts described here.

## Model discovery and endpoint routing

Discovery preserves current upstream metadata, then adds configured aliases,
reasoning-effort variants, redirect sources, virtual entries, and custom
provider entries. Visibility is still constrained by live account catalogs,
model policy, account health, and per-account routing configuration.

Routing resolves the requested alias, effort, and redirect before selecting the
final upstream protocol. Selection then follows these rules:

1. prefer the caller's native dialect when the selected model advertises it;
2. otherwise choose an advertised endpoint only when every required request
   concept has a lossless translation;
3. allow request content, such as a document, to select a more capable
   advertised endpoint; and
4. return a local protocol-native `400` with
   `endpoint_translation_unsupported` when a safe translation is unavailable.

A bridge must fail closed rather than discard reasoning state, tool calls or
results, call IDs, media, structured-output controls, cache controls,
continuation identity, or terminal stream state.

The `ws:/responses` value in a gateway model listing describes the gateway's
local compatibility transport and does not promise direct upstream WebSocket use.

## Responses accepted, normalized, rejected, and local fields

Accepted and forwarded fields include the reviewed current Responses surface:
model and input, instructions, output limits, metadata, tools and tool controls,
reasoning and encrypted-reasoning inclusion, text and structured-output
controls, sampling controls, prompt-cache controls, context management,
truncation, safety attribution, client metadata, task controls, and supported
extension fields. Unknown top-level fields are omitted at the final upstream
boundary; nested data inside accepted fields is preserved unless a documented
normalization applies.

Normalized behavior includes:

- immutable request snapshots at the public boundary;
- `reasoning.effort: "none"` removing reasoning summaries and encrypted
  reasoning inclusion, while enabled reasoning receives compatible defaults;
- duplicate encrypted-reasoning include entries collapsing to one;
- empty `tools` removing `tools`, `tool_choice`, and `parallel_tool_calls`;
- function schemas receiving object parameters and properties when omitted;
- compatible JSON-object and JSON-schema normalization;
- output limits below the upstream floor being raised to the supported floor;
- `context_management: null` and unsupported sampling fields being omitted when
  required by model configuration; and
- `store: false` remaining stateless while unsupported stateful controls are
  removed before transport.

Rejected fields and shapes include invalid bodies or models, malformed context
management, non-plain tool definitions, explicitly stored or background
requests, service tiers, direct HTTP `previous_response_id`, and tools that the
reviewed Responses contract always blocks. Syntactically accepted pass-through
tools or task controls remain subject to account, provider, and feature-flag
authorization.

Local Responses fields and behavior include compatibility compaction, payload
size recovery, media normalization, WebP conversion where required, and the
connection-scoped WebSocket continuation described below. These local features
do not imply upstream stored-response support.

## Messages body, header, and count-tokens behavior

Messages inference requires a non-empty `model`, a non-empty `messages` array,
and `max_tokens`. Token counting requires `model` and `messages`, but not
`max_tokens`. The native body uses a clone-and-denylist boundary: plain JSON
fields and nested content are preserved, including system blocks, text, image,
document, thinking, tool-use, tool-result, cache-control, fallback-credit,
effort, compaction, and future provider-compatible fields. Gateway-only helper
fields are removed.

Messages normalization includes:

- validating content blocks, tool history, tools, thinking, metadata, output
  configuration, and media source shapes without mutating the caller's body;
- reducing every ephemeral `cache_control` object to `type` plus a valid `5m`
  or `1h` TTL;
- canonicalizing `Anthropic-Beta` comma spacing and duplicates;
- forwarding a valid inbound `anthropic-version`, or using `2023-06-01` when
  absent;
- forwarding a valid `X-Model-Provider-Preference`; and
- preserving valid sampling and effort controls for upstream model/provider
  handling.

Malformed bodies, headers, required fields, tools, media, cache markers, or
lossy endpoint translations receive an Anthropic-shaped local error. Unknown
plain JSON fields are preserved for native Messages; malformed non-JSON or
hostile object shapes are rejected.

For Copilot models, `/v1/messages/count_tokens` calls the upstream native token
counter with the normalized model, messages, system prompt, tools, tool choice,
media context, version, beta, provider preference, affinity, and cancellation
context. It never replaces an upstream failure with a constant token count.
Configured custom chat providers may use the local estimator only after a
lossless Messages-to-Chat check.

## Chat compatibility behavior

Chat accepts the reviewed OpenAI-style message roles and content, modern tools,
deprecated function declarations, token limits, string or array stop values,
sampling and log-probability controls, reasoning effort, thinking budget,
prediction, structured output, stream options, penalties, seed, user metadata,
signed reasoning history, and supported attachments.

Normalization clones the request, completes missing function parameter-schema
objects, converts deprecated `functions` into modern function tools, appends
them after modern tools, and removes the deprecated fields. An explicit modern
`tool_choice` takes precedence over deprecated `function_call`. Streaming may
request usage automatically, JSON output receives compatibility instructions,
and attachments are normalized only after the final endpoint is selected.

Chat rejects malformed bodies, empty models or messages, invalid roles or
content parts, incomplete or misordered tool-call history, invalid tool
selection, and simultaneous non-null `max_tokens` and
`max_completion_tokens`. When native Chat is unavailable, fallback to Responses
or Messages occurs only after a lossless fidelity check; otherwise the request
fails with `endpoint_translation_unsupported`.

## Streaming and WebSocket termination and continuation semantics

Chat streams end with `[DONE]`. Responses streams preserve named events and
Responses streams do not add `[DONE]`. Messages streams preserve Anthropic
event names and ordering. Messages streams remove the trailing bare `[DONE]`
that the upstream compatibility layer may append after `message_stop`.

After HTTP headers are committed, failures are emitted in-band using the
source protocol's error event. Any partial output already emitted remains
visible. A logical routed call shares a maximum of three upstream sends across
transport recovery, account reinitialization, eligible failover, and narrow
protocol recovery. Deterministic validation failures are not retried, and a
stream is not replayed after substantive output.

The Responses WebSocket accepts JSON text frames with
`type: "response.create"`. Binary frames, invalid JSON, unsupported message
types, invalid initiators, and explicit `stream: false` receive recoverable
error frames while the socket remains open. `response.processed` is not treated
as a create request.

Successful Responses WebSocket turns can create snapshots for continuation.
Only response IDs issued on the current WebSocket connection are valid. A stale
or external ID returns `previous_response_not_found` without echoing that ID.
The client may then replay full history. Omitting `previous_response_id` starts
a new local thread; a successful continuation merges the stored completed turn
with new input and removes the continuation field before the stateless upstream
call. Snapshots are cleared when the connection closes and are never persisted.

Per-turn WebSocket envelopes accept typed attribution and initiator metadata.
Only allowlisted attribution headers are used; authentication, cookies, session
secrets, and arbitrary envelope headers are ignored. Safe response-assignment
and quota metadata may be attached only to eligible events before processing
moves past the terminal frame, without changing event order or body content.

## Multi-account and session-token constraints

Hash-only account affinity keeps an identified conversation on a deterministic
eligible account and derives stable upstream identity without storing a
conversation-to-account map. Endpoint fallback does not authorize moving
encrypted or signed history to another account. Eligibility always comes from
the account's raw current model catalog plus operator routing policy.

In multi-account mode, a supported affinity identity is required to guarantee
that separate control-plane and inference calls choose the same account. Calls
without affinity retain conservative first-eligible selection and do not
promise session-token continuity. No session-token-to-account map is stored.

`POST /models/session` creates or refreshes a model-scoped session and may
receive an existing `Copilot-Session-Token`. `POST /models/session/intent`
requires that header. `POST /auto` accepts its typed selection body but remains
subject to upstream account and feature availability. Model policy and session
operations are routed account-aware; they are not broadcast to every account.

The session token is an opaque secret, not gateway authentication. It is never
persisted or logged. Inference forwards it only when its bounded model claims
match the final, unredirected requested model; mismatched, malformed, or
redirected tokens are not forwarded.

## Intentional gateway extensions

The gateway intentionally provides behavior beyond a transparent upstream
proxy:

- local HTTP-backed Responses WebSocket transport and current-connection
  snapshots;
- Responses compatibility compaction and oversized binary-payload recovery;
- media normalization, including WebP conversion where the selected upstream
  path requires it;
- MCP-backed web search loops on compatible fallback paths;
- model aliases, effort variants, redirects, and operator routing controls;
- OpenAI-compatible custom chat and embedding providers;
- cross-dialect OpenAI, Anthropic, and Google-style compatibility routes; and
- client-integration surfaces for Claude Code and Codex workflows.

These extensions preserve public protocol framing, but their local state does
not become upstream state. Custom providers also remain limited to their
configured protocol families.

## Error privacy and LLM Debug exception

Chat and Responses HTTP errors use an OpenAI/Copilot-shaped envelope. Messages
and count-tokens errors use an Anthropic-shaped envelope. HTTP status,
`Retry-After`, safe quota headers, request IDs, and allowlisted machine-readable
error classes are preserved when available. Quota exhaustion maps to `402`,
deprecated client versions to `466`, and unknown upstream bodies or messages to
fixed local text.

Ordinary client errors, logs, telemetry, and Sentry events do not expose request
bodies, prompts, credentials, session tokens, beta-header contents, attachment
URLs, encrypted reasoning, or unreviewed upstream error bodies.

Administrator-only LLM Debug is the deliberate exception. It keeps exact
short-lived request and response captures for authorized diagnosis and replay.
It is process-local, expires after ten minutes, and must be treated as
credential-bearing material. This exception does not relax any ordinary
logging or client-error boundary.

## Verification matrix and last-audited date

Last audited: 2026-08-17

| Contract area | Automated evidence | Targeted verification |
| --- | --- | --- |
| Version, integration identity, and safe headers | Contract, client, model, and response-metadata tests | Confirm current discovery metadata parses without truncation |
| Model discovery and endpoint precedence | Model-route and endpoint-routing matrices | Compare route choices with live `supported_endpoints` |
| Responses fields, tools, media, and streaming | Request-contract, handler, payload-recovery, media, and stream-lifecycle tests | Exercise native HTTP and explicit cache controls where enabled |
| Messages fields, headers, counting, and streaming | Messages-contract, header, handler, count-token, error, and lifecycle tests | Exercise native Messages and native token counting where advertised |
| Chat fields and bridges | Chat-contract, routing, translation-fidelity, and fallback tests | Exercise native and lossless fallback paths available to the account |
| WebSocket validation and continuation | Protocol, lifecycle, routing, security, and continuation tests | Complete a two-turn current-connection continuation |
| Account affinity and session token | Routing-affinity, account-router, control-plane, and token-scope tests | Confirm one affinity identity remains account-consistent |
| Errors, privacy, and observability | Error, Sentry, logger, secret-scan, and administrator-debug tests | Inspect ordinary diagnostics for secret-free classifications |
| Regression extensions | Search, compaction, payload recovery, custom-provider, redirect, Google-style, and client-compatibility tests | Probe only extensions enabled in the deployment |

Contract changes require focused red-green coverage, the full repository test
suite, lint, type checking, build, diff validation, and a fresh privacy scan.
Live probes are capability-gated and must not be used to bypass upstream
authorization.

## Residual feature-flag, account, and provider limitations

Compatibility cannot enable a feature that the authenticated account,
integration identity, model, provider, organization policy, or upstream flag
does not expose. A safe upstream `400` or `404` for an unavailable policy,
model-session, intent, or Auto operation is a compatibility result, not a
reason to invent local success.

In particular, provider pinning, one-hour cache controls, modern computer or
image tools, Auto behavior, and multi-agent authorization remain conditional
on live metadata and upstream flags. Syntactic pass-through means only that the
gateway preserves a reviewed field; it is not a capability guarantee.

Models, endpoint combinations, limits, billing fields, quota fields, and
recommendation metadata can vary by account and over time. Clients must refresh
discovery and handle protocol-native availability errors. The local WebSocket
snapshot scope, no-storage affinity design, and model-scoped session-token rules
remain intentional limits rather than incomplete persistent-state support.
