# Copilot API

A self-hosted compatibility gateway and operator console for using GitHub
Copilot through OpenAI-, Anthropic-, and Google-style API surfaces.

Copilot API translates requests, selects an eligible Copilot account and
upstream protocol, and normalizes the response for the calling client. It also
provides a local control plane for inspecting requests, managing models and
providers, monitoring usage, and supporting Claude Code and Codex Desktop
workflows.

> [!WARNING]
> This is an unofficial, reverse-engineered project. It is not supported by or
> affiliated with GitHub, OpenAI, Anthropic, or Google, and upstream changes can
> break compatibility without notice. Use it only with accounts and systems you
> are authorized to operate.

> [!IMPORTANT]
> Automated or high-volume Copilot traffic can trigger abuse controls or account
> restrictions. Follow [GitHub's Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies)
> and [GitHub's terms for Copilot](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features),
> respect upstream service policies, and do not use this project to evade
> upstream restrictions.

## Contents

- [Compatibility](#compatibility)
- [Features](#features)
- [Quick start](#quick-start)
- [Client configuration](#client-configuration)
- [Authentication and network exposure](#authentication-and-network-exposure)
- [Models, routing, and providers](#models-routing-and-providers)
- [Multiple Copilot accounts](#multiple-copilot-accounts)
- [Operator dashboard](#operator-dashboard)
- [Claude Code and Codex integrations](#claude-code-and-codex-integrations)
- [CLI reference](#cli-reference)
- [Configuration and persistent data](#configuration-and-persistent-data)
- [Docker](#docker)
- [Reverse proxy deployment](#reverse-proxy-deployment)
- [Security and privacy](#security-and-privacy)
- [Security policy and remediation record](SECURITY.md)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Attribution and license](#attribution-and-license)

## Compatibility

These are compatibility endpoints and translation layers, not claims of complete
parity with every feature of the upstream APIs.

See the [detailed Copilot API compatibility contract](docs/copilot-api-compatibility.md)
for field handling, endpoint precedence, streaming, affinity, and current
feature-flag limitations.

| API family | Method and path | Support |
| --- | --- | --- |
| OpenAI Models | `GET /v1/models` | Live model discovery plus configured aliases, reasoning variants, redirect sources, and custom-provider models |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Streaming and non-streaming chat, tools, and supported attachments |
| OpenAI Responses | `POST /v1/responses` | Streaming and non-streaming Responses requests, with protocol fallback when a model lacks native Responses support |
| Responses compaction | `POST /v1/responses/compact` | Compatibility compaction that returns a proxy-generated `response.compaction` item |
| Responses WebSocket | WebSocket upgrade on `/v1/responses` or `/responses` | Stateful Responses-style streaming over WebSocket; this is not the OpenAI Realtime API |
| OpenAI Embeddings | `POST /v1/embeddings` | Copilot embeddings or a configured custom embedding provider |
| Anthropic Messages | `POST /v1/messages` | Streaming and non-streaming Messages translation, including native routing where available |
| Anthropic token count | `POST /v1/messages/count_tokens` | Compatibility token counting |
| Google Generative AI | `POST /v1/models/:model:generateContent` | Non-streaming Google request and response translation |
| Google Generative AI streaming | `POST /v1/models/:model:streamGenerateContent` | Streaming Google translation |

The OpenAI routes also work without the `/v1` prefix. Google routes are
available under `/v1/models`, `/v1beta/models`, and `/models`.

Model availability is account-specific and changes upstream. Query
`GET /v1/models` instead of relying on a hardcoded model list.

## Features

### Protocol translation

- Selects native Chat Completions, Responses, or Messages upstream paths based
  on model capabilities and request content.
- Translates streaming events, tool calls, usage, errors, images, and supported
  file attachments between client formats.
- Uses model- and request-specific fallback paths where implemented, such as
  Responses-to-Chat-Completions translation for non-native models and native
  Messages handling for supported PDF flows.
- Supports Responses over HTTP and WebSocket, including continuation requests
  and compatibility compaction.

### Model control

- Builds discovery results from the live models available to the authenticated
  Copilot account or accounts.
- Exposes supported reasoning-effort variants as `model:effort` virtual IDs.
- Normalizes supported Claude dotted/dashed names and eligible `[1m]` aliases.
- Applies ordered, exact-match model redirects with optional source and target
  reasoning efforts, chaining, loop detection, and priority control.
- Stores per-model settings for supported/default reasoning efforts, virtual
  model visibility, implicit defaults, assistant-prefill behavior, selected
  unsupported request parameters, and Sentry model names.
- Applies literal or regular-expression replacements to message text on Chat
  Completions and the translated Messages and Google paths. Replacements do not
  rewrite arbitrary request fields or direct Responses payloads.

Redirects apply to Chat Completions, Messages, Responses HTTP/WebSocket, Google
translation, and Messages token counting. They do not apply to embeddings or
Responses compaction.

### Provider and account routing

- Adds OpenAI-compatible custom chat and embedding providers without changing
  the client-facing base URL.
- Routes by model ID or alias with deterministic collision behavior.
- Uses multiple GitHub accounts only when at least two tokens are configured.
- Builds a per-model eligible-account index, supports per-account model
  enablement, keeps Claude Code sessions on a stable account, refreshes tokens,
  and performs one alternate-account failover for upstream authentication,
  quota, and network errors.

### Operations

- Integrated dashboard for usage, sessions, environments, request inspection,
  replay, model redirects/settings/routing, custom providers, replacements,
  feature flags, IP allowlists, and configuration export.
- Current GitHub Copilot quota reporting through both the CLI and `GET /usage`.
- Complete local minute/model request and token aggregates plus lifetime totals
  for dashboard utilization views.
- Manual approval for primary generation endpoints.
- Optional Sentry tracing.

### Client compatibility

- Claude Code Messages, scoped OAuth, authenticated Remote Control,
  environments, sessions, feature flags, and opt-in Direct Connect stubs.
- Codex Desktop dictation, transcript cleanup, and Statsig override support.
- Groq-backed speech-to-text for voice and dictation endpoints.

## Quick start

### Requirements

- A GitHub account with an active Copilot subscription.
- Bun for package and source usage. Docker is an alternative.

Choose a long random gateway key and start the published package on loopback.
The valueless `--api-key-auth` flag reads the key from
`COPILOT_API_KEY_AUTH`:

```sh
export COPILOT_API_KEY_AUTH='replace-with-a-long-random-key'
bunx --bun @ashsec/copilot-api@latest start --host 127.0.0.1 --api-key-auth
```

On the first run, follow the GitHub device-authentication prompt. The resulting
token and configuration are stored under the application data directory.

List the models available to that account:

```sh
curl http://127.0.0.1:4141/v1/models \
  -H "Authorization: Bearer replace-with-a-long-random-key"
```

Choose an ID returned by that endpoint and make a request:

```sh
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Authorization: Bearer replace-with-a-long-random-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID_FROM_V1_MODELS","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

Open the operator dashboard at `http://127.0.0.1:4141/dashboard`. First-time
setup uses the same gateway key plus a new administrator password.

> [!CAUTION]
> Always pass `--host 127.0.0.1` for a local-only server. If `--host` is
> omitted, Bun's default is to listen on all interfaces even though the startup
> message uses `localhost`.

## Client configuration

### OpenAI-compatible clients

Use the `/v1` base URL. A client library may require a non-empty API-key value
even when gateway authentication is disabled locally.

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:4141/v1
OPENAI_API_KEY=local-placeholder
```

When gateway authentication is enabled, replace the placeholder with the
configured gateway key.

### Anthropic-compatible clients and Claude Code

The Anthropic base URL does not include `/v1`:

```dotenv
ANTHROPIC_BASE_URL=http://127.0.0.1:4141
ANTHROPIC_AUTH_TOKEN=local-placeholder
```

Select current primary and small-model IDs from `GET /v1/models`. For a
protected gateway, `ANTHROPIC_AUTH_TOKEN` must be the gateway key.

The interactive helper can generate a Claude Code launch command after loading
the current model list:

```sh
bunx --bun @ashsec/copilot-api@latest start --host 127.0.0.1 --claude-code
```

The generated command always uses `dummy`. Before running it, replace that value
with the gateway key whenever `--api-key-auth` is enabled.

### Google-compatible clients

Use the Google-compatible route and provide the gateway key through
`x-goog-api-key` when authentication is enabled:

```sh
curl "http://127.0.0.1:4141/v1beta/models/MODEL_ID_FROM_V1_MODELS:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: replace-with-gateway-key" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}'
```

Use the `streamGenerateContent` action for streaming. Google Search,
code-execution tools, cached content, labels, and safety settings are not
currently translated.

## Authentication and network exposure

Copilot API separates these credential boundaries:

1. **GitHub credentials** authenticate the server to GitHub Copilot. Obtain one
   through device authentication, `auth`, `--github-token`, stored accounts, or
   `GITHUB_TOKENS`.
2. **Gateway credentials** authenticate trusted data-plane clients and bootstrap
   OAuth and the administrator account. `COPILOT_API_KEY_AUTH` is the gateway
   key and sole environment-based gateway credential. Direct usage requires
   `--api-key-auth` without a value; the Docker entrypoint supplies that flag.
3. **OAuth and inference credentials** are independent, scoped credentials.
   The OAuth flow never returns the gateway key. Claude Code receives a
   one-hour opaque access token and a rotating 30-day refresh token; an API key
   created through OAuth is a separate inference-only credential.
4. **Administrator sessions** are server-side sessions established with both
   the gateway key and an administrator password. The browser stores a Secure,
   HttpOnly session cookie and a separate SameSite-strict CSRF cookie, not the
   gateway key.

For any non-loopback deployment, enable a long random startup gateway key:

```sh
bunx --bun @ashsec/copilot-api@latest start \
  --host 0.0.0.0 \
  --api-key-auth replace-with-a-long-random-key
```

Clients can send the key in any of these forms:

```http
Authorization: Bearer replace-with-gateway-key
```

```http
x-api-key: replace-with-gateway-key
```

```http
x-goog-api-key: replace-with-gateway-key
```

Missing, invalid, expired, and blocked data-plane credentials receive a uniform
`401` response with `Cache-Control: no-store`. Failed protected credential
checks are recorded by normalized client IP. The third failure in a rolling
24-hour window bans that IP for 24 hours; banned requests still receive `401`.
Two denials are never recorded: a credential that resolves to a known principal
but lacks the required kind or scope, and the Claude Code compatibility stubs
that clients poll unprompted (telemetry, bootstrap, settings). Both still return
`401`, and a ban earned on another surface still applies to them. Successful
authoritative inference authentication clears prior failures, creates a
process-local ban exemption, and persists an enabled allowlist entry for
`/transcribe`. A new entry uses `source: "authenticated"`; an existing
operator-created `manual` or `dashboard` entry is re-enabled and retains its
source and transparent-proxy permission. Later missing or wrong credentials
still return `401` but cannot re-ban that IP during the session. Newly automatic
entries do not authorize credential-free transparent proxy inference.

`config.json` also supports `auth.apiKeys`. When no startup key is active, those
keys protect globally guarded API routes. If neither source configures a gateway
credential, the normal inference routes remain open; use that mode only on a
trusted loopback network.

OAuth authorization accepts Claude Code's registered production client, exact
manual or localhost callback URI, requested scopes, and S256 PKCE parameters.
After the gateway key is entered in the browser, the server issues a random,
one-use, two-minute authorization code bound to the client, redirect URI, state,
scope, and PKCE challenge. Access, refresh, authorization-code, and generated
inference secrets are persisted only as SHA-256 digests in
`oauth_tokens.json`. Issued access and refresh credentials do not expire;
refresh is repeatable and race-safe, while explicit revocation remains
available at `POST /v1/oauth/revoke`.

The dashboard shell can be loaded before login, but every dashboard API requires
an administrator session. Administrator passwords must be at least 4 characters
and have no other content rules; numeric-only passwords are accepted. First-time
local setup requires the gateway key and password, while
`COPILOT_ADMIN_PASSWORD_HASH` can supply a precomputed Argon2id verifier. Normal
login requires both the gateway key and password. Sessions have a 30-day
absolute lifetime and 12-hour idle lifetime; mutations also require a CSRF token
and an approved `Origin`. A local password change or environment-hash rotation
revokes other sessions.

Keep the application bound to loopback or a private container network even with
these controls. Publish only the exact hostname/path set required by the clients
you use. The sole public liveness route is exact `GET /health/health`; no session
router is mounted below `/health`. Direct Connect is disabled unless
`COPILOT_API_ENABLE_DIRECT_CONNECT=true`, and remains authenticated when enabled.

## Models, routing, and providers

### Discovery and reasoning variants

`GET /v1/models` combines:

- live models visible to healthy Copilot accounts;
- configured reasoning-effort variants such as `model:high`;
- supported naming and long-context aliases;
- enabled redirect-source aliases whose resolved targets have discoverable
  metadata; and
- custom-provider models and aliases.

Supported efforts are derived from live model metadata and local settings. The
recognized effort vocabulary is `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max`; not every model supports every value. Recognized effort
values may be coerced to a supported/default effort for the model. An
unrecognized `:suffix` is treated as part of the model ID.

### Redirects, settings, and replacements

The dashboard is the recommended interface for these controls:

- **Redirects** map an exact source model/effort to a target model/effort. Rules
  are ordered and can chain only through later rules.
- **Model settings** override capability assumptions and discovery behavior for
  a model.
- **Replacements** transform matching message text with literal or regular-
  expression rules on Chat Completions and translated Messages/Google requests.
- **Model routing** enables or disables a model for an individual Copilot
  account.

These settings persist in separate JSON files so they can be inspected and
backed up independently.

### Custom OpenAI-compatible providers

Custom providers can be managed in the dashboard or in `config.json`. Prefer an
environment-variable reference over storing a provider key directly:

```json
{
  "customProviders": [
    {
      "id": "example-provider",
      "name": "Example Provider",
      "type": "openai-compatible",
      "baseUrl": "https://your-domain.example/v1",
      "apiKeyEnv": "CUSTOM_PROVIDER_API_KEY",
      "headers": {},
      "models": [
        {
          "id": "example-chat-model",
          "aliases": ["example-chat"],
          "kind": "chat",
          "passReasoningEffort": true
        },
        {
          "id": "example-embedding-model",
          "aliases": ["example-embedding"],
          "kind": "embedding",
          "dimensions": 1024
        }
      ]
    }
  ]
}
```

Provider coverage is intentionally scoped:

| Provider model kind | Client-facing routes |
| --- | --- |
| `chat` | Chat Completions and Anthropic Messages |
| `embedding` | Embeddings only |

Custom providers do not automatically handle Responses HTTP/WebSocket,
Responses compaction, or Google-compatible routes.

A configured custom alias wins provider resolution and is the safest way to
force custom-provider routing; the first configured matching provider wins. If
a custom model's exact ID collides with a live Copilot model, the Copilot model
wins. `passReasoningEffort` opts the provider or model into forwarding the
normalized requested effort; without opt-in, `reasoning_effort` is removed.

## Multiple Copilot accounts

Multi-account mode activates only when at least two GitHub tokens are available.
Configure accounts interactively:

```sh
bunx --bun @ashsec/copilot-api@latest config
```

Or provide comma-separated tokens without writing token files:

```dotenv
GITHUB_TOKENS=first-github-token,second-github-token
```

At startup, each account exchanges its GitHub token, fetches its available
models, and contributes healthy models to a shared eligibility index. Dashboard
model-routing overrides can disable a model on a specific account.

Requests carrying `X-Claude-Code-Session-Id` select an eligible account
deterministically so a session stays on the same account. Without that header,
the first eligible account is used. On `401`, the selected account is refreshed
and retried. After a remaining `401`, `403`, `429`, or a network error, the
router attempts at most one eligible alternative account; `401` and `403` mark
the failed account unhealthy, while `429` does not. A known model disabled for
every account returns a local `403`; an unknown model falls back to the first
healthy account. Multi-account mode is for availability, model coverage, and
session affinity, not unrestricted load balancing.

## Operator dashboard

Open `/dashboard` on the same host as the API. The dashboard includes:

- overview and local request/token utilization;
- active Claude Code sessions and registered environments;
- outbound Copilot request/response attempts with structured/raw views;
- replay for logged Chat Completions and Responses attempts;
- GrowthBook feature flags and Codex/ChatGPT Statsig overrides;
- request replacements and ordered model redirects;
- per-model settings and per-account model routing;
- custom provider configuration;
- managed IP allowlists; and
- settings inspection and ZIP export.

On first use, the dashboard prompts for the gateway key and a new administrator
password. Later logins require both. The browser receives a Secure, HttpOnly,
SameSite-strict session cookie plus a separate SameSite-strict CSRF cookie; it
does not persist either login credential in `localStorage`. Set
`COPILOT_ADMIN_ORIGIN` to the exact external dashboard origin before serving
the dashboard through a reverse proxy.

If the locally stored administrator password is lost, stop the running server,
run `copilot-api admin --reset` from the trusted host console, and restart it.
The command requires interactive confirmation, removes the local password
verifier, and revokes all administrator sessions; the next dashboard visit
performs first-use setup again with the gateway key. In environment-managed
mode, update `COPILOT_ADMIN_PASSWORD_HASH` in the secret manager and restart the
server instead; `admin --reset` also removes the environment-management marker
and therefore returns the deployment to first-use setup if the variable is
subsequently removed. There is deliberately no public password-reset endpoint.

With the tracked Compose service, use:

```sh
docker compose stop copilot-api
docker compose run --rm --no-deps --entrypoint bun copilot-api run dist/main.js admin --reset
docker compose up -d copilot-api
```

LLM Debug records outbound Copilot attempts exactly as captured, including raw
URLs, request and response headers, bodies, authorization, cookies, API keys,
tokens, session identifiers, and other secret-bearing fields. Entries exist
only in process memory, expire after ten minutes, and are pruned during
debug-store operations. It observes Chat Completions, Responses, Embeddings,
and Messages attempts. Replay is narrower and supports logged Chat Completions
and Responses attempts only; replay execution obtains fresh server-side
authorization instead of sending the captured authorization header. Debug
detail, replay, provider-secret changes, configuration export, and other
sensitive operations require the authenticated administrator session.

`GET /usage` returns current GitHub Copilot quota data. The dashboard's local
usage view is a different tracker: minute/model aggregates are retained for
seven days, while separate lifetime counters remain cumulative. Storage is
pruned on load, record, and read and is written atomically.

Configuration exports omit GitHub token files, OAuth/admin stores, the startup
gateway key, and local usage history. Secret-like keys and values in exported
configuration—including provider keys, authorization headers, cookies, tokens,
passwords, and credentials—are replaced with `[REDACTED]`. Provider secrets are
also write-only through dashboard APIs: listings report whether a key is
configured without returning the key or sensitive custom headers.

## Claude Code and Codex integrations

These are compatibility implementations, not hosted identity or cloud services.

### Claude Code

- The Anthropic Messages endpoint supports normal Claude Code model traffic.
- The local OAuth facade implements opaque, scoped Claude Code credentials with
  one-use authorization codes, S256 PKCE, refresh rotation, and revocation. It
  is local gateway identity, not GitHub or Anthropic identity.
- Code-session creation, bridge setup, session APIs, and user actions require an
  OAuth credential with the Claude Code session scope.
- Worker endpoints and SSE use random, expiring capabilities bound to one
  session and worker epoch. Environment poll, acknowledgement, heartbeat, and
  reconnect calls use separate expiring capabilities bound to one environment.
- `/remote` uses the administrator session plus a one-use, short-lived,
  session-bound WebSocket ticket; a session ID is not authorization.
- Direct Connect compatibility stubs are disabled by default. When explicitly
  enabled for private development, `/sessions` and `/ws/direct/:sessionId`
  require an inference-capable credential.
- GrowthBook feature evaluation and the feature-flag UI support client behavior
  overrides on private networks where the client source address is preserved.

The OAuth and bridge credentials above are the primary authorization boundary.
After a gateway, inference-client, or correctly scoped OAuth credential
authorizes a data-plane request, the resolved client IP is exempt from the
process-local failure ban and is persisted as an enabled allowlist entry for
`/transcribe`. New entries use the `authenticated` source; existing
operator-created entries are re-enabled without changing their source or
transparent-proxy permission. Missing or wrong credentials still return `401`;
a newly automatic entry does not authorize credential-free transparent proxy
inference.

### Codex Desktop

- `POST /transcribe` provides dictation through Groq speech-to-text.
- `POST /codex/responses` provides configurable transcript cleanup.
- Statsig overrides can be managed in the dashboard and applied through the
  Statsig proxy middleware. The dedicated nginx template publishes only
  `/v1/initialize`, `/v1/download`, and `/v1/check`; every other path remains
  default-denied.

Set `GROQ_API_KEY` or the equivalent `groqApiKey` config field to enable speech
transcription. The voice WebSocket endpoint is
`/api/ws/speech_to_text/voice_stream`. It authenticates the upgrade with an
OAuth `voice:transcribe` entitlement (derived for Claude Code from
`user:inference`) before allocating audio state. It also validates any supplied
Origin. The gateway does not impose voice frame, audio, duration, idle,
connection, or hourly traffic caps.

Codex Desktop dictation at `POST /transcribe` is authorized only by the
resolved managed/session-allowlisted client IP. Current Desktop builds do not
reliably attach their API-key credential to dictation, so a prior successful
authoritative inference request automatically persists the observed IP for
this route. An operator can also add it manually in the dashboard. Automatic
authenticated entries do not permit credential-free transparent proxy calls;
those still require credentials unless an operator-created allowlist entry or
session lease applies. Transcript cleanup at `/codex/responses` remains
credential-authenticated.

Advanced TLS and proxy templates live under `nginx/`, including WebSocket
upgrade headers and disabled response buffering without project-defined
request pacing, body caps, or proxy timeouts.

## CLI reference

### Commands

| Command | Purpose |
| --- | --- |
| `auth` | Run GitHub device authentication without starting the server |
| `start` | Authenticate if needed and start the gateway |
| `admin` | Reset local administrator auth or generate an environment verifier |
| `check-usage` | Print current GitHub Copilot quota information |
| `debug` | Print version, runtime, data paths, and token-file status |
| `config` | Interactively manage replacements, stored accounts, and custom providers |

Run a command with `--help` to inspect the installed version's current options.

### `start` options

| Option | Alias | Default | Description |
| --- | --- | --- | --- |
| `--port <port>` | `-p` | `4141` | Listening port |
| `--host <host>` |  | Bun default | Listening hostname or IP; use `127.0.0.1` for local-only access |
| `--verbose` | `-v` | off | Enable verbose logging |
| `--account-type <type>` | `-a` | `individual` | `individual`, `business`, or `enterprise` Copilot routing |
| `--manual` |  | off | Prompt before forwarding Chat Completions, Messages, Responses HTTP, and Google requests |
| `--github-token <token>` | `-g` | unset | Use an existing GitHub token for this process |
| `--claude-code` | `-c` | off | Generate a Claude Code launch command from the current model list |
| `--show-token` |  | off | Print full GitHub and Copilot tokens; sensitive troubleshooting only |
| `--proxy-env` |  | off | Reserved proxy initializer; currently ineffective because the supported Bun server path skips it |
| `--insecure` |  | off | Disable TLS certificate verification; unsafe outside controlled debugging |
| `--debug` | `-d` | off | Log raw incoming URLs, headers, and most top-level JSON fields; sensitive troubleshooting only |
| `--api-key-auth <key>` |  | unset | Enable the startup gateway credential for data-plane auth, OAuth authorization, and administrator bootstrap/login |

### Other command options

| Command | Option | Description |
| --- | --- | --- |
| `auth` | `--verbose`, `-v` | Enable verbose authentication logs |
| `auth` | `--show-token` | Print the full GitHub token after authentication |
| `admin` | `--reset` | Interactively remove local admin auth and revoke every dashboard session |
| `admin` | `--hash-password` | Prompt twice with hidden input and print an Argon2id verifier for `COPILOT_ADMIN_PASSWORD_HASH` |
| `debug` | `--json` | Emit diagnostic information as JSON |

## Configuration and persistent data

The default data directory is `~/.local/share/copilot-api`. Override it with
`DATA_DIR`. Docker sets it to `/app/data`.

| File | Contents |
| --- | --- |
| `github_token` | Legacy/single GitHub token storage |
| `github_tokens.json` | Stored GitHub accounts and optional labels |
| `config.json` | Gateway keys, custom providers, prompt/model defaults, voice settings |
| `replacements.json` | Request replacement rules |
| `model_redirects.json` | Ordered model redirect rules |
| `model_settings.json` | Per-model capability and behavior overrides |
| `model_routing.json` | Per-account model enablement overrides |
| `feature_flags.json` | GrowthBook/Claude Code flag overrides |
| `statsig_overrides.json` | Codex/ChatGPT Statsig overrides |
| `ip_allowlist.json` | Managed IP allowlist entries |
| `oauth_tokens.json` | SHA-256 digests and metadata for OAuth codes, token families, and generated inference credentials |
| `admin_auth.json` | Locally managed Argon2id verifier, or a non-secret marker that permanently records migration to environment-managed auth |
| `admin_sessions.json` | Digested server-side administrator sessions and CSRF state |
| `usage.json` | Complete minute/model aggregates and separate lifetime totals |

When GitHub tokens come from environment variables or `--github-token`, the
process uses environment-only token mode and does not read or write GitHub token
files.

### Environment variables

| Variable | Scope | Purpose |
| --- | --- | --- |
| `GITHUB_TOKENS` | Direct and Docker | Comma-separated GitHub tokens; two or more enable multi-account mode |
| `COPILOT_INTEGRATION_ID` | Direct and Docker | Copilot integration identifier; defaults to `vscode-chat` for backwards-compatible entitlement behavior. Use an assigned integration ID when available; do not copy a first-party client ID merely to imitate that client. |
| `DATA_DIR` | Direct and Docker | Override the persistent data directory |
| `COPILOT_API_KEY_AUTH` | Direct and Docker | Gateway key and sole environment-based gateway credential; direct usage also requires the `--api-key-auth` flag without a value |
| `COPILOT_ADMIN_PASSWORD_HASH` | Direct and Docker | Optional authoritative Argon2id PHC verifier for the administrator password; suitable for 1Password/Varlock |
| `COPILOT_ADMIN_ORIGIN` | Direct and Docker | Exact browser origin allowed for dashboard mutations; set this explicitly for a proxied deployment |
| `COPILOT_TRUSTED_PROXY_CIDRS` | Direct and Docker | Comma-separated socket-peer CIDRs allowed to supply forwarding headers; defaults to loopback only |
| `COPILOT_API_ENABLE_DIRECT_CONNECT` | Direct and Docker | Set to `true` only to enable the authenticated experimental Direct Connect routes; disabled by default |
| `COPILOT_INFERENCE_CORS_ORIGINS` | Direct and Docker | Optional comma-separated exact browser origins for inference-only CORS; disabled by default |
| `COPILOT_VOICE_ORIGIN` | Direct and Docker | Optional exact browser Origin for the Claude voice WebSocket; supplied Origins must match |
| `SENTRY_DSN` | Direct and Docker | Enable Sentry tracing and error reporting |
| `SENTRY_TRACES_SAMPLE_RATE` | Direct and Docker | Sentry trace sample rate |
| `SENTRY_AI_RECORD_INPUTS` | Direct and Docker | Set to `false` to stop recording AI inputs/outputs in Sentry spans |
| `GROQ_API_KEY` | Direct and Docker | Enable Groq-backed speech transcription |
| `GH_TOKEN` | Docker entrypoint | Supply one GitHub token through the container entrypoint |
| `COPILOT_HOST` | Docker entrypoint | Set the container listening host |
| `COPILOT_VERBOSE` | Docker entrypoint | Add `--verbose` when set to `true` |
| `COPILOT_DEBUG` | Docker entrypoint | Add `--debug` when set to `true` |
| `OP_TOKEN`, `OP_ENV_ID` | Docker entrypoint | Optionally resolve container secrets through the bundled 1Password/Varlock integration |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Direct and Docker | Setting `0` disables outbound TLS verification process-wide; unsafe outside controlled debugging |
| `CERT_DIR` | HTTPS proxy helper | Certificate directory used by `scripts/https-proxy.mjs` |

Custom providers can reference any process environment variable through
`apiKeyEnv`. Although `--proxy-env` is present in the CLI, it is currently a
no-op in the supported Bun runtime; do not rely on it for outbound proxying.

Use `--port` and update the container port mapping when changing the port.

## Docker

The image stores persistent data in `/app/data`. The entrypoint already invokes
the `start` command; do not append `start` to normal `docker run` arguments.

### Build and authenticate

```sh
docker build -t copilot-api .
docker volume create copilot-api-data
docker run --rm -it -v copilot-api-data:/app/data copilot-api --auth
```

`--auth` is an image-entrypoint shortcut and must be the first image argument.

### Start a protected container

Create an environment file outside the repository/build context, for example
`../copilot-api.env`:

```dotenv
COPILOT_HOST=0.0.0.0
COPILOT_API_KEY_AUTH=replace-with-a-long-random-key
COPILOT_ADMIN_ORIGIN=https://your-domain.example
COPILOT_TRUSTED_PROXY_CIDRS=172.19.0.1/32,127.0.0.1/32,::1/128
```

Then start the container with the host port restricted to loopback:

```sh
docker run -d --name copilot-api --restart unless-stopped -p 127.0.0.1:4141:4141 --env-file ../copilot-api.env -v copilot-api-data:/app/data --health-cmd="wget --spider -q http://127.0.0.1:4141/health/health || exit 1" --health-interval=30s --health-timeout=5s --health-start-period=10s --health-retries=3 copilot-api
```

`GET /health/health` is the intentionally unauthenticated, metadata-free
liveness route. No other health API or session route exists under `/health`.
The image and Compose healthchecks both use this exact path.

### Docker Compose

The tracked Compose file expects the fixed external
`copilot-api_copilot-data` volume and a local `.env` file used by the existing
automatic secret-management flow:

```sh
docker volume create copilot-api_copilot-data
docker compose run --rm copilot-api --auth
docker compose up -d --build
```

The resolved container environment must include `COPILOT_API_KEY_AUTH` as well
as the deployment settings:

```dotenv
COPILOT_HOST=0.0.0.0
COPILOT_API_KEY_AUTH=replace-with-a-long-random-key
COPILOT_ADMIN_ORIGIN=https://your-domain.example
# Set this to the exact host-side Docker bridge address observed by the app.
COPILOT_TRUSTED_PROXY_CIDRS=172.19.0.1/32,127.0.0.1/32,::1/128
```

`OP_TOKEN` and `OP_ENV_ID` are optional and should be supplied together only
when using the 1Password/Varlock integration. `COPILOT_API_KEY_AUTH` comes
through this existing environment/secret-management flow; gateway-key file
mounts are not supported.

To keep the administrator verifier in the same 1Password Environment, generate
an Argon2id PHC string locally and store the exact output as
`COPILOT_ADMIN_PASSWORD_HASH`:

```sh
copilot-api admin --hash-password > admin-password.phc
```

This command prints only the PHC verifier. Copy `admin-password.phc` into
1Password, then securely delete the temporary file. The password prompts use
hidden interactive input and the verifier is written to stdout.

The plaintext password is still what you enter in the dashboard. The PHC hash
is authoritative, is never copied to `admin_auth.json`, and cannot be changed in
the dashboard. To rotate it, replace the 1Password value and recreate/restart
the service; existing administrator sessions then become invalid. On the first
environment-managed startup, any old local verifier is replaced with a
non-secret fingerprint marker. Removing or failing to inject the environment
variable then fails closed instead of restoring that old password. The marker
also makes hash rotations durable across restarts. Imported PHC
strings must use Argon2id v19 with memory cost 65,536–1,048,576 KiB, time cost
3–10, parallelism 1–16, a salt of at least 16 bytes, and a digest of at least 32
bytes. If placing a PHC string in a Compose env file instead, single-quote the
value so its `$` segments remain literal.

For an externally proxied dashboard, set `COPILOT_ADMIN_ORIGIN` explicitly in
the Compose environment. The tracked default leaves it unset, so only
`localhost` and `127.0.0.1` browser origins are accepted. An external HTTPS
dashboard origin is rejected until its exact origin is configured.

The tracked `.dockerignore` excludes environment files, certificates, keys,
the local `secrets/` directory, logs, and local data from the build context.
The Compose healthcheck uses `/health/health`, and its port mapping binds to
`127.0.0.1:4141` so the service is reachable only through the local host or
reverse proxy.

Do not put GitHub tokens into image build arguments. Supply them at runtime or
persist them with the authentication step.

### Updating a Compose checkout

Run the checked-in updater only from a clean `master` checkout:

```sh
./update.sh
```

It performs a fast-forward-only pull, validates the resolved Compose file,
rebuilds/recreates the service, waits for the exact healthcheck to become
healthy, and only then prunes dangling images. It does not migrate or rotate
credentials. When the invoking shell omits the external admin origin or trusted
proxy CIDRs, the updater preserves those two non-secret values from the running
container. Review upstream changes before running it; do not use it to erase
local deployment edits.

On Windows, `start.bat` starts the development server on `127.0.0.1` and opens
the same-origin operator dashboard. Set `COPILOT_API_KEY_AUTH` in the invoking
environment first; the launcher refuses to start without it. It no longer opens
the inherited external usage viewer.

## Reverse proxy deployment

Keep the application bound to loopback or a private container network and put
TLS at the reverse proxy. A client base URL can then be
`https://your-domain.example/v1`, but do not expose the full route tree. Use a
strict allowlist containing only the API and compatibility paths the deployment
actually needs.

The proxy must:

- preserve the request `Host` as required by the selected deployment mode;
- overwrite `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto` rather than
  appending or preserving client-supplied values;
- have its exact socket-peer address or CIDR listed in
  `COPILOT_TRUSTED_PROXY_CIDRS`;
- support WebSocket upgrades, including authenticated `GET` upgrades on
  `/responses` and `/v1/responses` while retaining normal `POST` handling;
- disable request/response buffering for streaming;
- allow long-lived SSE and WebSocket connections;
- avoid local request pacing, connection caps, finite body caps, and
  client/proxy/send timeouts; and
- forward the gateway credential without logging it.

The application reads forwarding headers only when the actual Bun socket peer
falls within a configured trusted CIDR. Direct clients are identified by their
socket address and cannot gain allowlist status by supplying `X-Real-IP` or
`X-Forwarded-For`. Keep the trusted list exact: do not use a broad private range
when only one local proxy address is required.

An exact trusted peer is insufficient when an upstream TCP load balancer
source-NATs every client to that peer: every caller then shares the load
balancer's authorization identity. GrowthBook `/api/eval/*` remains
unpublished. The dedicated Statsig template can be deployed through that
topology only when the operator explicitly accepts that callers reaching the
listener can share or spoof access to the three published Statsig endpoints.
Use authenticated source-address transport such as PROXY protocol when that
risk is not acceptable.

Use hostname-specific, default-deny locations. Publish the inference routes,
the exact OAuth/Claude compatibility paths required by your clients, the
dashboard only on its intended administrator hostname, and exact
`GET /health/health`. Leave unused code stubs and Direct Connect unpublished;
setting `COPILOT_API_ENABLE_DIRECT_CONNECT=true` does not make it appropriate
for a public hostname.

Templates are provided in `nginx/sites-available/`. Replace every template
placeholder, keep `--api-key-auth` enabled, and validate the generated server
configuration before exposing it. See [nginx/README.md](nginx/README.md) for
the template matrix, installation checks, Cloudflare CIDR maintenance, and
WebSocket probes.

## Security and privacy

- **Bind explicitly.** Use `--host 127.0.0.1` for local-only use. Bun otherwise
  listens on all interfaces by default.
- **Layer remote controls.** Use startup `--api-key-auth`, with either a direct
  value or the sole environment-based gateway credential
  `COPILOT_API_KEY_AUTH`, for the data plane and OAuth/bootstrap boundary. Use
  scoped OAuth, administrator sessions, WebSocket tickets, and bridge
  capabilities for their respective routes.
- **Trust IP headers only from exact proxy peers.** Configure
  `COPILOT_TRUSTED_PROXY_CIDRS` with the actual socket peers. Forwarding headers
  from every other peer are ignored. Successful authoritative inference auth
  persists the safely resolved IP for `/transcribe` and exempts it from the
  process-local ban; it does not authorize credential-free inference.
- **Protect the data directory.** It can contain GitHub tokens, gateway/provider
  keys, OAuth/admin digests, custom headers, routing policy, allowlists, and
  request history. Sensitive files and the directory are created with
  restrictive permissions where the platform supports them.
- **Exports are sanitized, not backups.** Dashboard ZIP exports redact
  secret-like configuration and require an authenticated administrator session.
  Preserve full recovery backups through a separately protected filesystem
  process.
- **Treat LLM Debug as raw credential-bearing data.** It intentionally preserves
  exact captured request and response URLs, headers, and bodies without
  redaction, including credentials and session identifiers. Access requires an
  administrator session, and records expire from process memory after ten
  minutes, but anyone viewing or exporting them receives the raw values.
- **Use Sentry deliberately.** When `SENTRY_DSN` is set, AI prompt and completion
  content is recorded by default. Set `SENTRY_AI_RECORD_INPUTS=false` before
  handling sensitive data.
- **Avoid sensitive logging.** `--show-token` prints complete tokens. Debug
  request logging redacts authorization, cookie, API-key, token, and secret
  headers plus secret-like structured body fields, but it still prints the full
  request URL and can expose other prompt or operational content. Do not place
  credentials in query parameters, and keep debug logs private.
- **Keep TLS verification enabled.** Use `--insecure` only for controlled,
  temporary diagnosis of a trusted interception proxy.
- **Use environment references.** Prefer custom-provider `apiKeyEnv` over
  storing provider keys in `config.json`.
- **Rotate exposed credentials and endpoints.** Removing a value from current
  documentation does not remove it from Git history, forks, caches, or logs.

## Troubleshooting

### Requests return `401`

Check whether the route expects the gateway key, a scoped OAuth/inference
credential, an administrator session, or a worker/environment capability.
Expired OAuth access tokens must be refreshed with the latest rotated refresh
token; replaying an older refresh token revokes its token family.

### Responses WebSocket gets an nginx `403`

A WebSocket handshake is an authenticated `GET`, not a `POST`. Do not place
`/responses` or `/v1/responses` behind a POST-only `limit_except` block. Render
the current `nginx/sites-available/public-domain.conf.template`, which allows
normal Responses POSTs and allows GET only when `Upgrade: websocket` is
present. Expected probes are application `401` without a credential and `101`
with a valid inference-capable credential.

### Claude Code reports `Connection closed mid-response`

Check the Nginx error log for `upstream timed out` on `POST /v1/messages`.
The templates use Nginx's maximum accepted client/read/send durations to avoid
its 60-second defaults. If that message appears, verify that the rendered
configuration inherited those maximum-duration directives and reload Nginx.

### The dashboard asks for the administrator password again

Current builds require the gateway key and administrator password only when
creating or signing into the dashboard session. LLM Debug, sanitized
configuration export, provider management, and IP policy then use that session
without a second password prompt. Hard-refresh the dashboard if an older
bundled script is still cached. A current bundle contains no
`/dashboard/auth/reauth` request.

### A model is missing or rejected

Run `GET /v1/models` with the same gateway credential as the client. In
multi-account mode, confirm at least one healthy account advertises the model
and that dashboard routing has not disabled it for every account.

### A custom model routes to Copilot

Use a unique alias. An exact live Copilot ID wins a collision with a custom
provider's exact ID, while a custom alias takes priority.

### A custom provider works for chat but not Responses or Google

This is expected. Custom chat providers cover Chat Completions and Messages;
custom embedding providers cover Embeddings. Other API families are not
automatically routed to custom providers.

### A protected Docker container is unhealthy

Override the image healthcheck to use `/health/health`, as shown above. The
tracked Compose file already uses that route.

### Authentication or path diagnostics

```sh
bunx --bun @ashsec/copilot-api@latest debug
bunx --bun @ashsec/copilot-api@latest debug --json
bunx --bun @ashsec/copilot-api@latest check-usage
```

Use verbose/debug/token-output options only in a private terminal and remove
sensitive logs afterward.

## Development

```sh
bun install
bun run dev start --host 127.0.0.1
```

Useful checks:

```sh
bun run lint:all
bun run typecheck
bun test tests/*.test.ts
bun run build
```

PowerShell does not expand that test glob for Bun. Use:

```powershell
$tests = Get-ChildItem tests -File -Filter *.test.ts
bun test $tests.FullName
```

Run a single test file:

```sh
bun test tests/anthropic-request.test.ts
```

Run the production entry point from source:

```sh
bun run start start --host 127.0.0.1
```

Integration tests under `tests/integration/` make live authenticated requests
and should be run only with a suitable test account and environment.

## Attribution and license

This codebase builds on the original
[ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) project by Erick
Christian Purwanto and has since grown additional compatibility, routing, and
operator-control features.

Released under the [MIT License](LICENSE).
