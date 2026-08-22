# Compatibility Recovery Design

## Status and precedence

Approved for implementation by the project owner on 2026-08-21. This document
supersedes conflicting language in
`docs/superpowers/specs/2026-08-21-compatibility-first-request-processing-design.md`,
the matching older plan, and the earlier safety recommendations in the Phase 1
audit maps. The maps remain evidence for affected code and tests, but the two
owner policies below are final.

PR #62 already delivered Responses `function_call.namespace` preservation and
substantial tolerant Anthropic Messages preparation, translation, attachment,
token-count, and custom-provider work. Recovery tests must characterize the
remaining behavior at current HEAD (`e1fc458`) and must not redo those changes.

## Owner policies

### Exact final upstream HTTP error bodies

When the final upstream HTTP attempt returns a non-empty response body, the
proxy exposes the exact received body in all of these ordinary channels:

- the normal downstream client response;
- ordinary application and handler logs; and
- Sentry error/log context.

The body is not parsed, redacted, secret-scanned, canonicalized, reserialized,
classified, replaced, protocol-wrapped, or otherwise rewritten. This rule
applies even when the body is non-JSON, malformed, binary-decodable,
whitespace-sensitive, protocol-incompatible, or appears to contain a secret.
The downstream response preserves the upstream status and relevant response
`Content-Type`. Other approved response headers continue through the existing
bounded header allowlist.

An owned byte snapshot is the source of truth. Client forwarding uses those
bytes. Logging and Sentry receive the same raw bytes as structured context and,
when the body is textual, the directly decoded text without JSON parsing or
normalization. A parsed clone may classify a deterministic compatibility retry,
but retry inspection never drains or mutates the owned snapshot. If a retry is
made and also fails, only the final attempt's status, content type, and exact
body are exposed as the final failure.

Only bodyless upstream failures and local or transport failures may use a
proxy-authored protocol-shaped fallback. Request bodies and request/response
headers remain separate trust boundaries: credentials, cookies, authorization,
session metadata, and other protected header/request fields are not made public
by this policy.

### Unrestricted attachment and file destinations

Every runtime-valid absolute `http:` or `https:` attachment/file URL is
fetchable. There is no SSRF destination policy: localhost, loopback IPv4/IPv6,
RFC1918/ULA, link-local, metadata-style, literal-IP, intranet, userinfo-bearing,
and redirected targets are all permitted. The proxy does not perform hostname,
DNS, resolved-address, redirect-target, private-network, metadata, allowlist,
denylist, canonical-host, or userinfo filtering.

The shared fetcher retains only execution/resource controls: caller abort,
independent timeout, maximum downloaded bytes, and maximum redirects. It may
reject only a value the runtime cannot execute as an absolute HTTP(S) request.
HTTP, timeout, oversize, redirect-limit, and unsupported-media failures degrade
the individual attachment where meaningful request content remains.

These two choices are accepted product risks. README and SECURITY.md must state
them plainly; implementation and tests must not describe them as sanitized,
safe, or SSRF-protected.

## Product principle and pipeline

The proxy maximizes the chance that authenticated requests from evolving AI
clients execute successfully:

1. Parse only the structure required to identify the action and route.
2. Authorize and preserve account/session affinity.
3. Safely snapshot caller-owned JSON without mutation.
4. Prepare one source-dialect representation.
5. Adapt a separate candidate payload for each advertised upstream endpoint.
6. Rank candidates using bounded advisory findings and adaptation cost.
7. Dispatch the exact payload that was evaluated.
8. Preserve stream output and emit exactly one dialect-correct terminal family.
9. Forward a final non-empty upstream error body exactly; synthesize an error
   only when no upstream body exists.

Unknown or imperfect request semantics do not produce a local gatekeeper 400
when a meaningful native or adapted request can be executed.

## Boundaries that remain hard

- Invalid JSON/body decoding and unrecognized route/action syntax.
- Authentication, authorization, administrator routes, trusted-proxy handling,
  and account/session ownership.
- Values that cannot be snapshotted or serialized because of cycles, `BigInt`,
  accessors, revoked proxies, or hostile reflection in direct internal calls.
- No advertised inference endpoint, or post-adaptation absence of any meaningful
  request.
- Payload/send budgets, attachment timeout/byte/redirect limits, web-search
  iteration limits, abort propagation, and stream terminal invariants.
- Response-header control-character and bounded allowlist rules.
- Account-bound encrypted/session history must not cross principals or accounts.

None of these boundaries authorizes rewriting a received non-empty upstream
HTTP error body or rejecting an attachment URL because of its destination.

## Request preparation and routing

`TranslationCheck.supported` becomes false only for fatal post-adaptation
emptiness or a genuine no-route condition. Ordered findings use a bounded
vocabulary and severities `exact`, `adapted`, `omitted`, and `fatal`; they may
affect candidate cost and telemetry but never echo client values.

Chat preparation accepts future roles, singleton/scalar/null content, malformed
or incomplete tool history, legacy function controls, token aliases, unknown
parts, and unknown tools. Native Chat preserves plain JSON; Responses and
Messages adapters repair, omit, or turn unrepresentable records into text.

Responses preparation preserves unknown top-level/input/tool/state/context JSON
for native dispatch, enforces `store:false` as a proxy override instead of a
rejection, and removes closed tool allowlists. Chat and Messages fallback
adapters preserve meaning with schema repair, generated request-local IDs,
textual breadcrumbs, and per-concept omission.

Messages preparation builds on PR #62. Remaining work treats explicit null
limits as absent, retains usable messages and tool history, handles future
roles/blocks/tools, sanitizes optional headers per token rather than rejecting
or dropping all values, and estimates token counts when native counting cannot
represent an extension-rich request.

Google preparation has a fixed invalid-JSON boundary, tolerant containers,
future roles/parts/tools, `parametersJsonSchema` support, recursive non-mutating
schema normalization, FIFO function-result pairing, and fallback for unknown
generation/tool controls.

## Stream and terminal lifecycle

Transport liveness remains in `src/lib/sse-lifecycle.ts`. A sibling
`stream-terminal-lifecycle.ts` owns only `open | succeeded | failed | aborted`,
idempotence, source-end behavior, and suppression after downstream abort.
Dialect adapters retain their own translation state.

- Responses forwards parseable terminal objects non-destructively, including
  future fields/items and failed/incomplete partial output. Success and
  incomplete are valid terminals. Local/source failures emit `error` followed
  by `response.failed`; exact upstream failure content is carried when present.
- Chat emits one error event followed by one `[DONE]` after a committed
  non-abort failure. A clean final chunk missing only `[DONE]` receives the
  sentinel; an unfinished source end is a failure.
- Messages closes open content/thinking/tool blocks before one `error`, and
  never emits `message_delta`/`message_stop` after failure.
- Google produces the same finality across Chat, Messages, and Responses
  upstreams, retains accumulated tool calls and partial output, and emits one
  failure terminal when a stream cannot finish normally.
- Responses WebSocket reuses Responses classifiers/builders, treats
  `response.incomplete` as a valid terminal, preserves tolerant frames and
  lane isolation, and emits no late frame after socket abort.

Ordinary native Responses streams are forwarded immediately. Buffering remains
only for known proxy-emulated web-search work.

## Upstream errors and deterministic retry

`UpstreamFailureSnapshot` owns `status`, approved response headers,
`contentType`, and `bodyBytes`. It distinguishes a final received upstream
failure from `LocalHTTPError`, abort, and transport-only failure. HTTP routes,
stream adapters, WebSocket, custom providers, embeddings, token count, and
control-plane transports consume this one snapshot contract.

A deterministic compatibility retry is permitted at most once, inside the
existing shared send budget, on the same account/session, before substantive
output. Classification reads a clone. Normalizations are bounded classes such
as dropping a known unsupported optional control; an unknown 400 is not
retried. The final attempt's body remains readable and exact.

Local/bodyless failures retain protocol-shaped fallbacks. Abort/499 remains
unreported and produces no late client output.

## Attachment recovery

`fetchUrlAsDataUri` (or a focused shared helper it delegates to) accepts a
runtime-valid absolute HTTP(S) target and manually follows at most the configured
redirect count without destination classification. It combines caller abort
with an independent timeout, rejects a declared or streamed body beyond the
byte cap, and returns a structured recoverable failure. Chat image inlining,
Chat-to-Messages conversion, Responses image/file adaptation, Messages URL
image/document normalization, and Google `fileData` all use this helper.

## Residual platform compatibility

The six independent audits identified platform work outside the four main
dialects. The recovery branch also must:

- preserve control-plane `/models`, `/session`, and `/intent` client routing and
  future fields while overriding only gateway-owned values;
- prefer an eligible issuer-matching account for a valid session token before
  rendezvous fallback, without persistent session maps;
- accept Google `?key=` credentials and deterministic matching multi-header
  credentials;
- show models whose `model_picker_enabled` metadata is absent unless explicitly
  disabled;
- serve unauthenticated liveness at `/health` while retaining `/health/health`;
- define explicit browser inference CORS for intended non-admin routes;
- make advertised custom-provider models dispatchable from Responses and
  Google, with tolerant SSE/error handling;
- persist effective Responses WebSocket envelope headers across turns in one
  connection; cross-connection continuation remains outside this no-storage
  design;
- derive Direct Connect/worker URLs from trusted public-origin configuration or
  forwarded headers, including HTTP/HTTPS to WS/WSS mapping and path prefixes;
- separate gateway authentication from transparent-provider credentials;
- return fixed 400s for malformed JSON on peripheral data-plane routes.

## Documentation and generated UI

`src/lib/compatibility-contract-values.ts` is the executable source for the
compatibility table. Documentation updates include
`docs/copilot-api-compatibility.md`, README, and SECURITY.md. The documents must
describe raw final-error-body exposure and unrestricted attachment destinations
as intentional risks, and must accurately state health, CORS, custom-provider,
and WebSocket scope.

Dashboard source changes, if required by provider/public-origin settings, are
made only in `ui/src`. Then run `bun run build:ui`; never hand-edit
`src/routes/dashboard/page-generated.ts`.

## Test strategy and completion

Every implementation slice begins with a focused failing test and ends green
before commit. Required matrices cover exact JSON/text/HTML/whitespace/binary
error bodies, all terminal lifecycle cases, tolerant request/adaptation cases,
all unrestricted destination classes and redirects, retry clone ownership, and
the residual platform behaviors above.

Completion requires focused suites, `bun test`, `bun run typecheck`,
`bun run lint:all`, `bun run build`, conditional `bun run build:ui`, generated
UI consistency, credential-only/request-header leakage review, `git diff
--check`, and a whole-branch review. No push, pull request, merge, deployment,
or production mutation is part of this plan.
