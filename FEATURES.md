# Copilot API Features

This document covers every feature copilot-api supports beyond basic LLM proxying, how to configure them, and the exact endpoints involved.

---

## Table of Contents

- [OAuth & Authentication](#oauth--authentication)
- [Feature Flag Management](#feature-flag-management)
- [Remote Control (Code Sessions API)](#remote-control-code-sessions-api)
- [Remote Control (Bridge Environments API)](#remote-control-bridge-environments-api)
- [Sessions Compatibility Layer](#sessions-compatibility-layer)
- [Direct Connect (WebSocket Sessions)](#direct-connect-websocket-sessions)
- [Voice / Speech-to-Text](#voice--speech-to-text)
- [Auto-Replacements](#auto-replacements)
- [Usage Tracking](#usage-tracking)
- [Multi-Token Mode & Session Affinity](#multi-token-mode--session-affinity)
- [Rate Limiting & Manual Approval](#rate-limiting--manual-approval)
- [Custom Providers](#custom-providers)
- [Model Resolution & Reasoning Effort](#model-resolution--reasoning-effort)
- [Sentry Integration](#sentry-integration)
- [Proxy Support](#proxy-support)
- [API Stubs (Claude Code Compatibility)](#api-stubs-claude-code-compatibility)
- [Remote Control Web UI](#remote-control-web-ui)
- [Admin Dashboard](#admin-dashboard)
- [Deployment Guide](#deployment-guide)

---

## OAuth & Authentication

Copilot API implements a full OAuth flow so Claude Code can authenticate using its standard `/login` command. No real identity provider is needed — the server acts as its own OAuth provider.

### How It Works

1. Claude Code opens `GET /oauth/authorize?redirect_uri=...&state=...` in a browser
2. If `--api-key-auth` is set, a login form prompts for the API key. Otherwise, it auto-redirects.
3. On success, redirects to `redirect_uri?code=copilot-api-auth-code&state=...`
4. Claude Code exchanges the code via `POST /v1/oauth/token` for an access token
5. All subsequent API calls use `Authorization: Bearer <token>`

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/oauth/authorize` | No | Show login form / auto-redirect |
| POST | `/oauth/authorize` | No | Validate API key, issue auth code |
| GET | `/oauth/code/success` | No | Success landing page |
| GET | `/v1/oauth/hello` | No | Connectivity check |
| POST | `/v1/oauth/token` | No | Exchange code for access token |
| GET | `/api/oauth/profile` | Yes | Return user + organization profile |
| GET | `/api/oauth/usage` | Yes | Usage data for settings panel |

### Configuration

```bash
# Require an API key for all requests (recommended for remote access)
copilot-api start --api-key-auth my-secret-key

# Or via environment variable
COPILOT_API_KEY_AUTH=my-secret-key copilot-api start
```

### Claude Code Setup

After starting the server, run `/login` in Claude Code. It will open the OAuth flow in your browser. If you set `--api-key-auth`, enter that key in the login form.

Alternatively, configure Claude Code manually via `.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "my-secret-key"
  }
}
```

---

## Feature Flag Management

Control Claude Code's behavior by toggling GrowthBook feature flags. Claude Code's GrowthBook SDK calls your server for flag evaluation, so you can enable/disable features without modifying Claude Code itself.

### Admin Dashboard

Open `http://localhost:4141/feature-flags/` in your browser to view and manage flags through a web UI.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/feature-flags/` | No | Admin dashboard (HTML) |
| GET | `/feature-flags/api` | API key | List all flags |
| POST | `/feature-flags/api` | API key | Set a flag |
| DELETE | `/feature-flags/api` | API key | Remove a flag |
| POST | `/api/eval/:clientKey` | No | GrowthBook SDK remote eval |

### Setting a Flag

```bash
curl -X POST http://localhost:4141/feature-flags/api \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret-key" \
  -d '{"name": "tengu_bridge_repl_v2", "value": true}'
```

### Default Flags

These flags are enabled by default to support key Claude Code features:

| Flag | Default | Effect |
|------|---------|--------|
| `tengu_bridge_repl_v2` | `true` | Enable env-less bridge (v2 Remote Control protocol) |
| `tengu_remote_backend` | `true` | Enable remote TUI backend |
| `tengu_amber_quartz_disabled` | `false` | Voice mode stays enabled |

User-set flags (via the API or dashboard) override defaults. Flags persist to `~/.local/share/copilot-api/feature_flags.json`.

### How Claude Code Uses Flags

Claude Code's GrowthBook SDK sends `POST /api/eval/{clientKey}` on startup and periodically. The response contains all flags in GrowthBook format:

```json
{
  "features": {
    "tengu_bridge_repl_v2": { "defaultValue": true },
    "tengu_remote_backend": { "defaultValue": true }
  }
}
```

---

## Remote Control (Code Sessions API)

This is the modern v2 protocol that powers Claude Code's Remote Control feature. When Claude Code runs `claude remote-control` or uses `/remote-control`, it connects to your server via this API.

### How It Works

1. Claude Code creates a session via `POST /v1/code/sessions`
2. It fetches worker credentials via `POST /v1/code/sessions/{id}/bridge` (each call bumps the worker epoch)
3. The worker connects to the SSE event stream at `GET /v1/code/sessions/{id}/events/stream`
4. Events flow bidirectionally: worker writes via `POST .../worker/events`, clients write via `POST .../events`
5. Worker reports state (idle/running/requires_action) via `PUT .../worker`
6. Heartbeats keep the session alive via `POST .../worker/heartbeat`
7. Session is archived on teardown via `POST /v1/sessions/{id}/archive`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/code/sessions` | Create a session |
| POST | `/v1/code/sessions/:id/bridge` | Get worker JWT + API base URL |
| PATCH | `/v1/code/sessions/:id` | Update session (e.g. title) |
| PUT | `/v1/code/sessions/:id/worker` | Report worker state |
| GET | `/v1/code/sessions/:id/worker` | Read worker state |
| POST | `/v1/code/sessions/:id/worker/heartbeat` | Worker heartbeat |
| POST | `/v1/code/sessions/:id/worker/events` | Write client events (batch) |
| POST | `/v1/code/sessions/:id/worker/events/delivery` | Acknowledge event delivery |
| POST | `/v1/code/sessions/:id/worker/internal-events` | Write internal events |
| GET | `/v1/code/sessions/:id/worker/internal-events` | Read internal events |
| GET | `/v1/code/sessions/:id/events/stream` | SSE event stream |
| POST | `/v1/code/sessions/:id/events` | Post event to session |

### Session Lifecycle Example

```bash
# 1. Create a session
curl -X POST http://localhost:4141/v1/code/sessions \
  -H "Content-Type: application/json" \
  -d '{"title": "My Session", "bridge": {}}'
# → {"session": {"id": "cse_abc123...", "title": "My Session"}}

# 2. Get bridge credentials
curl -X POST http://localhost:4141/v1/code/sessions/cse_abc123/bridge \
  -H "Content-Type: application/json" -d '{}'
# → {"worker_jwt": "worker_cse_abc123_1_uuid", "api_base_url": "http://...", "expires_in": 3600, "worker_epoch": 1}

# 3. Report worker state
curl -X PUT http://localhost:4141/v1/code/sessions/cse_abc123/worker \
  -H "Content-Type: application/json" \
  -d '{"worker_epoch": 1, "worker_status": "idle"}'

# 4. Subscribe to SSE stream (in a real client, this is a long-lived connection)
curl -N http://localhost:4141/v1/code/sessions/cse_abc123/events/stream

# 5. Write events
curl -X POST http://localhost:4141/v1/code/sessions/cse_abc123/worker/events \
  -H "Content-Type: application/json" \
  -d '{"worker_epoch": 1, "events": [{"payload": {"type": "user", "message": {"role": "user", "content": "hello"}}}]}'
```

### SSE Stream Format

The event stream uses standard Server-Sent Events:

```
event: client_event
id: 1
data: {"event_id":"uuid","sequence_num":1,"event_type":"user","source":"worker","payload":{...},"created_at":"..."}

:keepalive

event: client_event
id: 2
data: {"event_id":"uuid","sequence_num":2,...}
```

Clients can resume from a specific point using `?from_sequence_num=N` or the `Last-Event-ID` header.

---

## Remote Control (Bridge Environments API)

The v1 poll-based protocol for Remote Control. Some Claude Code versions use this path. It adds an "environment" dispatch layer on top of sessions.

### How It Works

1. Claude Code registers a bridge environment via `POST /v1/environments/bridge`
2. It polls for work via `GET /v1/environments/{id}/work/poll`
3. When work arrives, it acknowledges via `POST .../work/{workId}/ack`
4. Heartbeats extend the work lease via `POST .../work/{workId}/heartbeat`
5. On shutdown, deregisters via `DELETE /v1/environments/bridge/{id}`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/environments/bridge` | Register bridge environment |
| DELETE | `/v1/environments/bridge/:id` | Deregister environment |
| GET | `/v1/environments/:id/work/poll` | Poll for work (204 = no work) |
| POST | `/v1/environments/:id/work/:workId/ack` | Acknowledge work |
| POST | `/v1/environments/:id/work/:workId/stop` | Stop work |
| POST | `/v1/environments/:id/work/:workId/heartbeat` | Extend work lease |
| POST | `/v1/environments/:id/bridge/reconnect` | Reconnect session |

### Registration Example

```bash
# Register
curl -X POST http://localhost:4141/v1/environments/bridge \
  -H "Content-Type: application/json" \
  -d '{"machine_name": "my-laptop", "directory": "/home/user/project", "branch": "main"}'
# → {"environment_id": "env_abc123", "environment_secret": "uuid"}

# Poll for work (returns 204 when no work available)
curl http://localhost:4141/v1/environments/env_abc123/work/poll

# Deregister
curl -X DELETE http://localhost:4141/v1/environments/bridge/env_abc123
```

---

## Sessions Compatibility Layer

Bridges the gap between old `session_*` IDs and new `cse_*` IDs. Used by both v1 and v2 protocols for session archival and event forwarding.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/sessions/:id/archive` | Archive a session |
| POST | `/v1/sessions/:id/events` | Send events to a session |

IDs starting with `session_` are automatically mapped to `cse_*` format.

---

## Direct Connect (WebSocket Sessions)

Supports Claude Code's `--server` mode for web-based terminal sessions. Creates interactive sessions accessible via WebSocket.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions` | Create a direct-connect session |
| GET | `/health` | Server health check |
| GET | `/api/sessions` | List active sessions |
| DELETE | `/api/sessions/:id` | Kill a session |
| WS | `/ws/direct/:sessionId` | WebSocket connection |

### Usage

```bash
# Create a session
curl -X POST http://localhost:4141/sessions \
  -H "Content-Type: application/json" \
  -d '{"cwd": "/home/user/project"}'
# → {"session_id": "dc_abc123", "ws_url": "ws://localhost:4141/ws/direct/dc_abc123", "work_dir": "/home/user/project"}

# Health check
curl http://localhost:4141/health
# → {"status": "ok", "activeSessions": 1}

# Connect via WebSocket (using websocat or similar)
websocat ws://localhost:4141/ws/direct/dc_abc123
# ← {"type": "session", "token": "dc_abc123"}
```

### WebSocket Protocol

- **On connect:** Server sends `{"type": "session", "token": "sessionId"}`
- **Text frames:** JSON control messages
- **Close:** Session remains in store until explicitly destroyed

---

## Voice / Speech-to-Text

Real-time voice transcription via WebSocket using Groq's Whisper API. Claude Code connects to this for voice input mode.

### Configuration

```bash
# Set the Groq API key (required for voice to work)
GROQ_API_KEY=gsk_... copilot-api start

# Or configure via the interactive menu
copilot-api config
```

### WebSocket Endpoint

| Path | Description |
|------|-------------|
| `/api/ws/speech_to_text/voice_stream?language=en` | Voice STT stream |

### Protocol

**Client sends:**
- Binary frames: Raw PCM audio (16kHz, 16-bit, mono)
- `{"type": "KeepAlive"}` — Heartbeat
- `{"type": "CloseStream"}` — End recording, trigger transcription

**Server responds:**
- `{"type": "TranscriptText", "data": "transcribed text"}` — Transcription result
- `{"type": "TranscriptEndpoint"}` — End of transcript
- `{"type": "TranscriptError", "description": "error message"}` — Error

---

## Auto-Replacements

Text substitution rules applied to requests before they're sent to the Copilot API. Useful for stripping headers, normalizing content, or injecting custom patterns.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/replacements` | List all rules (system + user) |
| POST | `/replacements` | Add a new rule |
| DELETE | `/replacements/:id` | Remove a rule |
| PATCH | `/replacements/:id` | Update a rule |
| PATCH | `/replacements/:id/toggle` | Toggle rule on/off |
| DELETE | `/replacements` | Clear all user rules |

### Adding a Rule

```bash
# String replacement
curl -X POST http://localhost:4141/replacements \
  -H "Content-Type: application/json" \
  -d '{"pattern": "old-text", "replacement": "new-text", "name": "my rule"}'

# Regex replacement
curl -X POST http://localhost:4141/replacements \
  -H "Content-Type: application/json" \
  -d '{"pattern": "\\bfoo\\b", "replacement": "bar", "isRegex": true, "name": "regex rule"}'
```

### Built-in System Rules

- **`system-anthropic-billing`** — Removes Anthropic billing headers from responses (auto-enabled in multi-token mode)

Rules persist to `~/.local/share/copilot-api/replacements.json`. Manage interactively via `copilot-api config`.

---

## Usage Tracking

Monitor your GitHub Copilot API usage and quotas.

### Endpoint

| Method | Path | Description |
|--------|------|-------------|
| GET | `/usage` | Get usage statistics |

### Web Dashboard

After starting the server, a usage dashboard URL is displayed in the console. Open it in your browser to see quotas, request counts, and rate limit status.

---

## Multi-Token Mode & Session Affinity

Distribute load across multiple GitHub Copilot accounts for higher throughput and redundancy.

### Setup

```bash
# Comma-separated tokens (2+ enables multi-token mode)
GITHUB_TOKENS=ghp_token1,ghp_token2,ghp_token3 copilot-api start

# Or add accounts interactively
copilot-api config
# → Account management → Add account
```

### How It Works

- **Round-robin:** Requests are distributed across accounts that have access to the requested model
- **Session affinity:** When Claude Code sends the `X-Claude-Code-Session-Id` header, requests in the same session are routed to the same account (prevents mid-conversation account switches that break thinking block signatures)
- **Failover:** On 401/403/429 errors, automatically retries with an alternative account
- **Health tracking:** Accounts that fail authentication are marked unhealthy and automatically recover on token refresh

### Token Storage

Tokens persist to `~/.local/share/copilot-api/github_tokens.json` so you don't need to re-authenticate on restart.

---

## Rate Limiting & Manual Approval

### Rate Limiting

```bash
# Enforce minimum 30 seconds between requests
copilot-api start --rate-limit 30

# Wait instead of rejecting (blocks until cooldown expires)
copilot-api start --rate-limit 30 --wait
```

Without `--wait`, exceeding the rate limit returns `429 Too Many Requests`.

### Manual Approval

```bash
# Prompt before each request
copilot-api start --manual
```

Every incoming request shows an interactive prompt: `Accept incoming request? (Y/n)`. Declining returns `403 Forbidden`.

---

## Custom Providers

copilot-api can expose additional OpenAI-compatible providers through the same OpenAI endpoints while keeping Copilot as the default backend.

### Supported Surfaces

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/v1/models` | Lists Copilot models plus configured custom provider models and aliases |
| POST | `/v1/chat/completions` | Routes configured custom chat models to `{baseUrl}/chat/completions` |
| POST | `/v1/embeddings` | Routes configured custom embedding models to `{baseUrl}/embeddings` |

### Configuration

Custom providers live in `~/.local/share/copilot-api/config.json` under `customProviders`. They can also be managed in the admin dashboard at `/dashboard` > Custom Providers, or seeded from `copilot-api config` with the Nebius Qwen3 embedding preset.
The dashboard stores provider API keys directly in the same config file used for other persistent settings. Manual config files may use `apiKeyEnv` instead of `apiKey` when an environment variable is preferred.

```json
{
  "customProviders": [
    {
      "id": "nebius",
      "name": "Nebius",
      "type": "openai-compatible",
      "baseUrl": "https://api.studio.nebius.com/v1",
      "apiKey": "<nebius api key>",
      "headers": {},
      "models": [
        {
          "id": "Qwen/Qwen3-Embedding-8B",
          "aliases": ["qwen3-embedding-8b"],
          "kind": "embedding",
          "dimensions": 4096
        }
      ]
    },
    {
      "id": "openai-compatible-example",
      "name": "Custom OpenAI Compatible",
      "type": "openai-compatible",
      "baseUrl": "https://example.com/v1",
      "apiKey": "<provider api key>",
      "models": [
        {
          "id": "custom-chat-model",
          "kind": "chat",
          "supportsStreaming": true
        }
      ]
    }
  ]
}
```

Provider requests use `Authorization: Bearer <api key>` plus any static `headers`. Missing keys return a clear configuration error and are not logged.

### Routing Rules

- Custom aliases route to their provider before any Copilot fallback.
- Exact Copilot model IDs stay on Copilot if a custom provider defines the same ID.
- Exact custom model IDs route to the provider when no Copilot model with that ID is available.
- Aliases are rewritten to the provider's canonical model ID upstream, while responses keep the client-requested model name.

### Nebius Qwen3 Embeddings

```json
{
  "model": "qwen3-embedding-8b",
  "input": ["incident cpu saturation", "postgres connection timeout"]
}
```

The response is OpenAI-compatible, preserves input order, and validates the configured `dimensions` value when provided.

---

## Model Resolution & Reasoning Effort

### Reasoning Effort Suffixes

Append `:low`, `:medium`, `:high`, or `:xhigh` to model names to control reasoning effort:

```
claude-sonnet-4.6:high    → High reasoning effort
gpt-5.3-codex:xhigh      → Extra-high reasoning effort
claude-opus-4.6:low       → Low reasoning effort
```

Virtual models with these suffixes appear in `GET /v1/models`.

### Model Name Normalization

The server normalizes model names between Anthropic and Copilot formats:

- `claude-opus-4-6[1m]` → `claude-opus-4.6-1m`
- Date suffixes like `-20251001` are stripped
- Dashes between digits become dots: `4-6` → `4.6`

### Configuration

Override reasoning effort per model in `~/.local/share/copilot-api/config.json`:

```json
{
  "modelReasoningEfforts": {
    "gpt-5-mini": "low",
    "claude-sonnet-4.6": "medium"
  }
}
```

---

## Sentry Integration

Monitor errors and performance with Sentry.

### Configuration

```bash
SENTRY_DSN=https://your-sentry-dsn copilot-api start

# Optional: control trace sampling (default 1.0 = all traces)
SENTRY_TRACES_SAMPLE_RATE=0.5

# Optional: disable recording AI prompts in spans (default true)
SENTRY_AI_RECORD_INPUTS=false
```

### What's Tracked

- Error reporting with stack traces
- Performance traces for API requests
- AI agent spans (model, tokens, duration) for the Sentry AI dashboard
- Cached input tokens and reasoning token reporting
- Sensitive headers (Authorization, Cookie, API keys) are scrubbed automatically

---

## Proxy Support

For corporate networks behind HTTP proxies:

```bash
# Use environment proxy variables
copilot-api start --proxy-env
# Reads: http_proxy, https_proxy, HTTP_PROXY, HTTPS_PROXY

# Disable SSL verification (self-signed corporate proxy certs)
copilot-api start --insecure

# Or via environment variable
NODE_TLS_REJECT_UNAUTHORIZED=0 copilot-api start

# Custom certificate directory
CERT_DIR=/path/to/certs copilot-api start
```

---

## API Stubs (Claude Code Compatibility)

These endpoints return mock/empty data to prevent Claude Code from erroring on missing server features. They allow Claude Code to function without a real Anthropic backend for these features.

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/oauth/claude_cli/organizations` | Organization list (mock) |
| GET | `/api/oauth/claude_cli/roles` | `[]` |
| GET | `/api/oauth/claude_cli/client_data` | `{}` |
| POST | `/api/oauth/claude_cli/create_api_key` | `{ api_key: "..." }` |
| GET | `/api/claude_code/user_settings` | `{}` |
| PUT | `/api/claude_code/user_settings` | `{ success: true }` |
| GET | `/api/claude_code/organizations/:orgId/mcp_servers` | `{ mcp_servers: [] }` |
| POST | `/api/claude_code/organizations/:orgId/mcp_servers` | `{ success: true }` |
| GET | `/api/claude_code/organizations/:orgId/integrations` | `{ integrations: [] }` |
| GET | `/api/claude_code/organizations/:orgId/policy_limits` | `{ limits: {}, policies: [] }` |
| POST | `/api/claude_code/organizations/:orgId/file_upload` | `{ success: true }` |
| GET | `/api/claude_code/task_runners` | `{ task_runners: [] }` |
| POST | `/api/claude_code/tasks` | `{ success: true }` |
| GET | `/api/claude_code/environments` | `{ environments: [] }` |
| GET | `/api/claude_code/skill_search` | `{ results: [] }` |
| PATCH | `/api/claude_code/sessions/:id` | `{ success: true }` |
| GET | `/api/claude_code_penguin_mode` | `{}` |
| GET | `/api/claude_cli_profile` | `{}` |
| POST | `/api/claude_cli_feedback` | `{ success: true }` |
| POST | `/api/claude_code/metrics` | `{ success: true }` |
| GET | `/api/claude_code/organizations/metrics_enabled` | `{ enabled: false }` |
| POST | `/api/claude_code/link_vcs_account` | `{ success: true }` |
| GET | `/api/organization/:id` | Organization details (mock) |
| POST | `/api/event_logging/batch` | `{ success: true }` (telemetry sink) |
| GET | `/api/web/domain_info?domain=X` | `{ domain, can_fetch: true }` |
| GET | `/api/hello` | `{ status: "ok" }` |

---

## Remote Control Web UI

A chat-style web interface for interacting with Claude Code sessions remotely from any device — phone, tablet, or another computer.

### How It Works

1. Start a Remote Control session in Claude Code: `/remote-control` or `claude --remote-control`
2. Claude Code creates a session on the copilot-api server and shows a URL
3. Open the URL or go to `/remote` — the web UI connects via WebSocket and shows the live conversation
4. Type messages from the web UI — they flow to Claude Code's worker, which processes them and streams responses back

### Endpoints

| Path | Description |
|------|-------------|
| `/remote` | Remote Control web UI (session picker) |
| `/remote?session=cse_xxx` | Direct connect to a specific session |
| `/code/session_xxx` | Redirects to `/remote?session=cse_xxx` (the URL Claude Code prints) |
| `wss://host/ws/remote/:sessionId` | WebSocket connection for live events |

### Features

- **Session picker** — lists all active code sessions, click to connect
- **Chat interface** — iMessage-style dark theme with user (blue) and assistant (gray) bubbles
- **Live streaming** — sees tool use, assistant responses, and turn completions in real-time
- **Permission requests** — shows tool approval cards with Allow/Deny buttons
- **Mobile-friendly** — designed for phone use with safe-area support
- **WebSocket-based** — works through Cloudflare and reverse proxies (not SSE)
- **Keepalive** — server sends ping every 30s to prevent proxy idle timeouts
- **Auth** — same API key auth as dashboard, persisted in localStorage

### Accessing from Claude Code

When you run `/remote-control`, Claude Code prints:
```
/remote-control is active · Code in CLI or at https://claude.ai/code/session_xxx
```

If your hosts file points `claude.ai` to your copilot-api server, clicking that URL automatically redirects to the remote control chat page. The `session_` prefix is mapped to `cse_` internally.

---

## Admin Dashboard

A single-page admin dashboard at `/dashboard` for managing all copilot-api features.

### Sections

| Section | Description |
|---------|-------------|
| Overview | Server health, active session counts, uptime |
| Sessions | List all code sessions + direct-connect sessions, with Remote Control button to open chat UI |
| Environments | Registered bridge environments (v1 protocol) |
| Feature Flags | Toggle/add/remove GrowthBook feature flags |
| Replacements | Manage auto-replacement rules |
| Custom Providers | Manage OpenAI-compatible chat and embedding providers |
| Usage | Copilot usage/quota with progress bars |
| Settings | Read-only server configuration display |

### Design

- Dark developer theme (slate blue palette)
- Icon sidebar navigation (60px, collapses to bottom nav on mobile)
- Auto-refresh for sessions (10s) and overview/environments (30s)
- Toast notifications for actions
- API key auth persisted in localStorage

### Session Management

Each session card shows:
- Status dot (green = running, orange = requires action, gray = idle)
- Session title, type badge, ID, epoch, time since creation
- **Remote Control button** (green chat icon) — opens `/remote?session=cse_xxx` in new tab
- **View events** button — expands inline event viewer
- **Archive/Destroy** button — removes the session

---

## Deployment Guide

### Local Development

```bash
# Start copilot-api
cd copilot-api
bun run dev

# Access at http://localhost:4141
# Dashboard: http://localhost:4141/dashboard
# Remote Control: http://localhost:4141/remote
```

### Local with HTTPS (for Claude Code Remote Control)

Claude Code connects to `api.anthropic.com` for Remote Control. To redirect it to your local server, you need HTTPS with domain spoofing.

**Option A: Using the built-in HTTPS proxy**

```bash
# 1. Generate or place certs in scripts/certs/
#    Files needed: api.anthropic.com.crt, api.anthropic.com.key,
#                  claude.ai.crt, claude.ai.key

# 2. Add to hosts file (as admin):
#    127.0.0.1 api.anthropic.com
#    127.0.0.1 claude.ai

# 3. Start copilot-api + HTTPS proxy
bun run dev                          # Terminal 1: HTTP on :4141
node scripts/https-proxy.mjs         # Terminal 2: HTTPS on :443 (needs admin)

# 4. Trust the CA cert for Claude Code (Bun's fetch)
#    Set NODE_EXTRA_CA_CERTS as an OS-level env var (not in settings.json):
export NODE_EXTRA_CA_CERTS=/path/to/your/ca-cert.pem
```

**Option B: Using mitmproxy**

If you use mitmproxy for HTTPS interception, point `NODE_EXTRA_CA_CERTS` to mitmproxy's CA cert. Important: this must be set as an **OS environment variable** before launching Claude Code, not in `.claude/settings.json`, because Bun's native `fetch()` reads it at process startup.

### Production with Nginx

For remote access (e.g., from your phone), deploy behind nginx with proper WebSocket support.

**Nginx configuration:**

```nginx
# Required: WebSocket upgrade mapping (place in http {} block or before server block)
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.crt;
    ssl_certificate_key /path/to/cert.key;

    location / {
        proxy_pass http://localhost:4141;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (required for Remote Control and Voice)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # SSE/streaming support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        chunked_transfer_encoding on;
    }
}
```

**Critical nginx settings:**

| Setting | Why |
|---------|-----|
| `proxy_set_header Upgrade $http_upgrade` | Forwards WebSocket upgrade header to backend |
| `proxy_set_header Connection $connection_upgrade` | Sets `Connection: upgrade` for WebSocket, `close` for HTTP |
| `proxy_buffering off` | Required for SSE streaming (event streams, usage data) |
| `proxy_read_timeout 300s` | Prevents nginx from killing long-lived connections |
| `map $http_upgrade $connection_upgrade` | Conditionally sets Connection header based on request type |

**Common mistake:** Setting `proxy_set_header Connection ''` or omitting the Upgrade/Connection headers entirely. This strips the WebSocket handshake and causes `1006` close errors.

### Nginx for Claude Code API Spoofing

If you want Claude Code to connect through your remote server (instead of local HTTPS proxy), you need an additional nginx server block that spoofs `api.anthropic.com`:

```nginx
server {
    listen 443 ssl;
    server_name api.anthropic.com claude.ai;

    ssl_certificate /path/to/spoofed-cert.crt;
    ssl_certificate_key /path/to/spoofed-cert.key;

    location / {
        proxy_pass http://localhost:4141;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        chunked_transfer_encoding on;
    }
}
```

Then point your hosts file to the nginx server's IP and trust the spoofed cert via `NODE_EXTRA_CA_CERTS`.

### Cloudflare

If using Cloudflare in front of nginx:

1. **Enable WebSockets** in Cloudflare dashboard: Network > WebSockets > ON
2. **Keepalive** is handled automatically — the server sends WebSocket pings every 30s to prevent Cloudflare's idle timeout
3. **SSL mode** should be Full (strict) if your origin has a valid cert, or Full if self-signed

### TLS Certificate Troubleshooting

Claude Code uses two different HTTP clients:
- **axios** (for API calls like `/v1/messages`, `/worker/events`, heartbeats) — respects `NODE_EXTRA_CA_CERTS` set at any time
- **Bun's native `fetch()`** (for SSE stream at `/worker/events/stream`) — reads `NODE_EXTRA_CA_CERTS` **only at process startup**

If Remote Control sessions create but the worker never connects to the SSE stream (you see `0 SSE subscribers` in logs), the issue is almost certainly TLS:

```bash
# Wrong: setting in .claude/settings.json (too late for Bun's fetch)
{
  "env": {
    "NODE_EXTRA_CA_CERTS": "/path/to/ca.pem"
  }
}

# Right: set as OS environment variable before launching claude
export NODE_EXTRA_CA_CERTS=/path/to/ca.pem
claude
```

Alternatively, set `NODE_TLS_REJECT_UNAUTHORIZED=0` in settings.json for testing (disables all cert verification).

### Feature Flags for Remote Control

These GrowthBook flags must be `true` for Remote Control to work:

| Flag | Purpose | Default |
|------|---------|---------|
| `tengu_ccr_bridge` | Enable Remote Control entitlement | `true` |
| `tengu_bridge_repl_v2` | Enable v2 (env-less) bridge protocol | `true` |
| `tengu_remote_backend` | Enable remote TUI backend | `true` |

These are set as defaults in copilot-api and served via the GrowthBook endpoint at `/api/eval/:clientKey`. You can toggle them in the dashboard or Feature Flags admin page.

**Important:** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` disables GrowthBook entirely, which prevents flag evaluation and blocks Remote Control. Do not set this env var if you want Remote Control.
