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
> apply conservative rate limits, and do not use this project to evade service
> limits.

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
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Attribution and license](#attribution-and-license)

## Compatibility

These are compatibility endpoints and translation layers, not claims of complete
parity with every feature of the upstream APIs.

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
  and performs bounded failover for authentication, quota, and network errors.

### Operations

- Integrated dashboard for usage, sessions, environments, request inspection,
  replay, model redirects/settings/routing, custom providers, replacements,
  feature flags, IP allowlists, and configuration export.
- Current GitHub Copilot quota reporting through both the CLI and `GET /usage`.
- Local request/token tracking for dashboard utilization views.
- Manual approval for primary generation endpoints and token-bucket rate
  limiting for supported generation and compaction transports.
- Optional Sentry tracing.

### Client compatibility

- Claude Code Messages, OAuth compatibility, Remote Control, environments,
  sessions, feature flags, and Direct Connect compatibility stubs.
- Codex Desktop dictation, transcript cleanup, and Statsig override support.
- Groq-backed speech-to-text for voice and dictation endpoints.

## Quick start

### Requirements

- A GitHub account with an active Copilot subscription.
- Bun for package and source usage. Docker is an alternative.

Start the published package on loopback:

```sh
bunx --bun @ashsec/copilot-api@latest start --host 127.0.0.1
```

On the first run, follow the GitHub device-authentication prompt. The resulting
token and configuration are stored under the application data directory.

List the models available to that account:

```sh
curl http://127.0.0.1:4141/v1/models
```

Choose an ID returned by that endpoint and make a request:

```sh
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID_FROM_V1_MODELS","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

Open the operator dashboard at `http://127.0.0.1:4141/dashboard`.

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

Copilot API has two separate credentials:

1. **GitHub credentials** authenticate the server to GitHub Copilot. Obtain one
   through device authentication, `auth`, `--github-token`, stored accounts, or
   `GITHUB_TOKENS`.
2. **Gateway credentials** authenticate clients to this server. Enable this
   boundary with `--api-key-auth` or, in Docker, `COPILOT_API_KEY_AUTH`.

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

HTTP requests passing through the startup key guard are deliberately held open
when the key is wrong rather than receiving a normal API response. This can look
like a timeout. When a trusted reverse proxy supplies an IP header, three failed
guarded LLM-route attempts block a resolvable, non-whitelisted source IP until
the process restarts or the UTC date changes. Direct clients without those
headers are not strike-tracked, and dashboard/WebSocket auth failures use
different responses.

`config.json` also supports `auth.apiKeys`. When no startup key is active, those
keys produce conventional `401` responses on globally protected API routes.
They do not supplement a startup key and do not protect pre-auth compatibility
surfaces.

The dashboard HTML shell is served without authentication. Its data and mutation
APIs are protected only when startup `--api-key-auth` is enabled. Do not expose
an unprotected dashboard to an untrusted network.

> [!CAUTION]
> A startup key does not make every route safe for direct public exposure. The
> OAuth compatibility token exchange and some compatibility routes are mounted
> before the global key guards. In particular, the current OAuth flow can return
> the active gateway key through an unauthenticated refresh-token exchange, and
> Direct Connect session routes/WebSockets and selected code stubs are not
> key- or IP-guarded. Until those runtime limitations are fixed, keep the app on
> loopback or a private network. If it must sit behind a remote reverse proxy,
> use a strict path allowlist and block `/oauth*`, `/v1/oauth*`, `/sessions*`,
> `/ws/direct*`, `/health/`, `/health/api/*`, and every unused pre-auth
> compatibility path. If health monitoring is required, allow only the exact
> `/health/health` path.

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
      "timeoutMs": 120000,
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

Provider coverage is intentionally limited:

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

LLM Debug records raw outbound Copilot attempts, including complete request
bodies and upstream authorization headers, plus raw upstream responses. Entries
expire after ten minutes and are pruned on the next debug-store operation; an
idle process may retain expired entries longer. It observes Chat Completions,
Responses, Embeddings, and Messages attempts. Replay is narrower and supports
logged Chat Completions and Responses attempts only.

`GET /usage` returns current GitHub Copilot quota data. The dashboard's local
usage view is a different, persisted request/token tracker.

Configuration exports omit GitHub token files, the startup gateway key, and
local usage history, but they can still contain `auth.apiKeys`, provider keys,
and custom headers. Treat every export as a secret.

## Claude Code and Codex integrations

These are compatibility implementations, not hosted identity or cloud services.

### Claude Code

- The Anthropic Messages endpoint supports normal Claude Code model traffic.
- The local OAuth facade emulates endpoints Claude Code expects. Its browser
  login form is gated only by startup `--api-key-auth`; it is not GitHub or
  Anthropic identity.
- Code Sessions and SSE endpoints support the newer Remote Control protocol.
- Environments and session routes support the polling compatibility bridge.
- Direct Connect compatibility stubs expose in-memory session management and
  `/ws/direct/:sessionId`; they do not implement a full terminal bridge.
- `/remote` provides a browser interface for compatible remote sessions.
- GrowthBook feature evaluation and the feature-flag UI support client behavior
  overrides.

Several compatibility surfaces exist before the global API-key middleware.
`/v1/code/sessions`, `/v1/environments`, `/v1/sessions`, and `/api/eval` use the
managed IP allowlist. Direct Connect session creation/list/deletion and its
WebSocket, `/ws/remote/*`, the voice WebSocket, and selected code stubs currently
use neither the global startup-key guard nor the managed IP allowlist. Keep them
unreachable except through a trusted, path-restricting reverse proxy.

### Codex Desktop

- `POST /transcribe` provides dictation through Groq speech-to-text.
- `POST /codex/responses` provides configurable transcript cleanup.
- Statsig overrides can be managed in the dashboard and applied through the
  Statsig proxy middleware and bundled nginx template.

Set `GROQ_API_KEY` or the equivalent `groqApiKey` config field to enable speech
transcription. The voice WebSocket endpoint is
`/api/ws/speech_to_text/voice_stream`.

Codex Desktop calls must also satisfy gateway-key or managed/session-IP
authorization. For authenticated non-local Desktop routing, use the supplied
trusted-host/TLS template and an intentional client-side host mapping.

Advanced TLS and proxy templates live under `nginx/`, including WebSocket
upgrade headers, disabled response buffering, and long streaming timeouts.

## CLI reference

### Commands

| Command | Purpose |
| --- | --- |
| `auth` | Run GitHub device authentication without starting the server |
| `start` | Authenticate if needed and start the gateway |
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
| `--rate-limit <seconds>` | `-r` | unset | Token-bucket pacing for Chat Completions, Messages, Responses HTTP/compact/WebSocket, and Google requests |
| `--wait` | `-w` | off | Wait instead of erroring when the configured rate limit is hit |
| `--github-token <token>` | `-g` | unset | Use an existing GitHub token for this process |
| `--claude-code` | `-c` | off | Generate a Claude Code launch command from the current model list |
| `--show-token` |  | off | Print full GitHub and Copilot tokens; sensitive troubleshooting only |
| `--proxy-env` |  | off | Reserved proxy initializer; currently ineffective because the supported Bun server path skips it |
| `--insecure` |  | off | Disable TLS certificate verification; unsafe outside controlled debugging |
| `--debug` | `-d` | off | Log raw incoming URLs, headers, and most top-level JSON fields; sensitive troubleshooting only |
| `--api-key-auth <key>` |  | unset | Enable the startup gateway-key guard for the main API and dashboard/feature-flag APIs; review pre-auth routes separately |

### Other command options

| Command | Option | Description |
| --- | --- | --- |
| `auth` | `--verbose`, `-v` | Enable verbose authentication logs |
| `auth` | `--show-token` | Print the full GitHub token after authentication |
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
| `usage.json` | Local request and token history |

When GitHub tokens come from environment variables or `--github-token`, the
process uses environment-only token mode and does not read or write GitHub token
files.

### Environment variables

| Variable | Scope | Purpose |
| --- | --- | --- |
| `GITHUB_TOKENS` | Direct and Docker | Comma-separated GitHub tokens; two or more enable multi-account mode |
| `DATA_DIR` | Direct and Docker | Override the persistent data directory |
| `COPILOT_API_KEY_AUTH` | Direct and Docker | Gateway key; direct usage also requires the `--api-key-auth` flag without a value |
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

Although it is present in `.env.schema`, `COPILOT_PORT` is currently unused. Use
`--port` and update the container port mapping when changing the port.

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
```

Then start the container with the host port restricted to loopback:

```sh
docker run -d --name copilot-api --restart unless-stopped -p 127.0.0.1:4141:4141 --env-file ../copilot-api.env -v copilot-api-data:/app/data --health-cmd="wget --spider -q http://127.0.0.1:4141/health/health || exit 1" --health-interval=30s --health-timeout=5s --health-start-period=10s --health-retries=3 copilot-api
```

The explicit health command matters: the image's built-in healthcheck probes
the startup-key-protected root route, while `/health/health` is the
unauthenticated container-health route.

### Docker Compose

The tracked Compose file expects an external volume with a fixed name and a
local `.env` file:

```sh
docker volume create copilot-api_copilot-data
docker compose run --rm copilot-api --auth
docker compose up -d --build
```

At minimum, `.env` must provide:

```dotenv
COPILOT_HOST=0.0.0.0
COPILOT_API_KEY_AUTH=replace-with-a-long-random-key
```

`OP_TOKEN` and `OP_ENV_ID` are optional and should be supplied together only
when using the 1Password/Varlock integration.

> [!WARNING]
> The current `.dockerignore` does not exclude `.env`, and the Dockerfile copies
> the repository into the builder stage. A repository-local `.env` can therefore
> enter the Docker build context/cache during `docker compose up --build`. Keep
> its values non-sensitive, add a local Docker-ignore rule before building, or
> provide Compose secrets from outside the build context.

The Compose healthcheck already uses `/health/health`. Its tracked port mapping
publishes on all host interfaces; change it to
`127.0.0.1:4141:4141` before starting Compose if the gateway should be reachable
only through a local reverse proxy.

Do not put GitHub tokens into image build arguments. Supply them at runtime or
persist them with the authentication step.

## Reverse proxy deployment

Keep the application bound to loopback or a private container network and put
TLS at the reverse proxy. A client base URL can then be
`https://your-domain.example/v1`, but do not expose the full route tree. Use a
strict allowlist containing only the API and compatibility paths the deployment
actually needs.

The proxy must:

- preserve the request `Host` as required by the selected deployment mode;
- set trusted `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto` values;
- support WebSocket upgrades;
- disable request/response buffering for streaming;
- allow long-lived SSE and WebSocket connections;
- permit the required request body size; and
- forward the gateway credential without logging it.

Explicitly deny the OAuth, Direct Connect, code-stub, admin, and other pre-auth
paths identified in [Authentication and network exposure](#authentication-and-network-exposure)
unless that client workflow truly needs them and an equivalent proxy-side
authorization control is in place.

The Direct Connect router is also mounted under `/health`. Expose only the exact
`/health/health` probe; deny `/health/` and `/health/api/*`, which otherwise
create or manage unauthenticated in-memory sessions.

Templates are provided in `nginx/sites-available/` and
`nginx/snippets/proxy-limits.conf.template`. Replace every template placeholder,
keep `--api-key-auth` enabled, and validate the generated server configuration
before exposing it.

## Security and privacy

- **Bind explicitly.** Use `--host 127.0.0.1` for local-only use. Bun otherwise
  listens on all interfaces by default.
- **Layer remote controls.** Use startup `--api-key-auth` or Docker's
  `COPILOT_API_KEY_AUTH` for the main API, and enforce reverse-proxy path and
  authentication controls for every required pre-auth compatibility route.
- **Trust IP headers only from your proxy.** The strike tracker and managed
  allowlist depend on `X-Real-IP` or the rightmost `X-Forwarded-For`; overwrite
  client-supplied values at the trusted proxy.
- **Protect the data directory.** It can contain GitHub tokens, gateway/provider
  keys, custom headers, routing policy, allowlists, and request history.
- **Protect exports.** Dashboard ZIP exports can contain config-file API keys
  and provider secrets even though GitHub token files, the startup gateway key,
  and usage history are excluded.
- **Treat LLM Debug as sensitive.** Raw outbound bodies, upstream authorization
  headers, and responses expire after ten minutes but are pruned lazily, so an
  idle process can retain them longer.
- **Use Sentry deliberately.** When `SENTRY_DSN` is set, AI prompt and completion
  content is recorded by default. Set `SENTRY_AI_RECORD_INPUTS=false` before
  handling sensitive data.
- **Avoid sensitive logging.** `--show-token` prints complete tokens. `--debug`
  logs full URLs/query strings, every header (only authorization/API-key names
  are prefix-masked), and every top-level JSON field except `messages` and
  `prompt`; cookies and other secret-bearing fields are not masked.
- **Keep TLS verification enabled.** Use `--insecure` only for controlled,
  temporary diagnosis of a trusted interception proxy.
- **Use environment references.** Prefer custom-provider `apiKeyEnv` over
  storing provider keys in `config.json`.
- **Rotate exposed credentials and endpoints.** Removing a value from current
  documentation does not remove it from Git history, forks, caches, or logs.

## Troubleshooting

### Requests time out instead of returning `401`

The startup API-key guard intentionally holds unauthorized LLM requests open.
Check the Bearer, `x-api-key`, or `x-goog-api-key` value and verify that the
source IP has not accumulated failed attempts.

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
