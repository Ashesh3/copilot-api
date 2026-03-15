# Voice Mode for copilot-api

## Problem

Claude Code's `/voice` command requires OAuth authentication to Claude.ai. Users running copilot-api with `ANTHROPIC_API_KEY` bypass OAuth, so `iH()` returns `false`, making voice mode hidden and disabled. Voice mode streams raw PCM audio over a WebSocket to Claude.ai's speech-to-text infrastructure, which is not accessible to copilot-api users.

## Solution

Fake the OAuth layer so Claude Code thinks it's logged into Claude.ai, implement a WebSocket endpoint matching Claude Code's voice protocol, and use Groq's Whisper API for speech-to-text transcription.

## Architecture

Three components:

1. **OAuth fake layer** — endpoints that satisfy Claude Code's OAuth login flow
2. **Voice WebSocket server** — receives audio, sends back transcripts
3. **Groq STT integration** — converts buffered audio to text

## 1. OAuth Fake Layer

### Why

Claude Code checks `iH()` to determine if OAuth is needed. With `ANTHROPIC_API_KEY` set, `iH()` returns `false`, disabling voice. Removing `ANTHROPIC_API_KEY` and faking OAuth makes `iH()` return `true`, enabling voice without patching Claude Code.

### Auth flow

1. User runs `/login` in Claude Code (selects "Claude.ai" login method)
2. Claude Code starts a local HTTP server on a random port
3. Browser opens `https://claude.ai/oauth/authorize?redirect_uri=http://localhost:PORT/callback&state=STATE&code_challenge=CHALLENGE&...`
4. Our server reads `redirect_uri` and `state`, immediately redirects browser back to `redirect_uri?code=FAKE_CODE&state=STATE`
5. Claude Code receives the code, POSTs to `https://platform.claude.com/v1/oauth/token`
6. Our server returns `{ access_token: "<cop-key>", refresh_token: "ref-copilot-api", scope: "...", expires_in: 86400 }`
7. Claude Code fetches profile at `https://api.anthropic.com/api/oauth/profile`
8. Our server returns a fake profile with `organization_type: "claude_max"`

The `access_token` is the cop- key itself. When the SDK sends `Authorization: Bearer cop-...`, copilot-api's `extractRequestApiKey()` extracts it and matches against configured API keys.

### Endpoints

| Route | Method | Domain | Response |
|---|---|---|---|
| `/oauth/authorize` | GET | `claude.ai` | 302 redirect to `redirect_uri?code=FAKE&state=STATE` |
| `/oauth/code/success` | GET | `platform.claude.com` | HTML: "Login successful, you can close this tab" |
| `/oauth/code/callback` | GET | `platform.claude.com` | HTML: shows code for manual paste |
| `/v1/oauth/token` | POST | `platform.claude.com` | JSON: `{ access_token, refresh_token, scope, expires_in }` |
| `/api/oauth/profile` | GET | `api.anthropic.com` | JSON: fake profile with claude_max org type |
| `/api/oauth/claude_cli/roles` | GET | `api.anthropic.com` | JSON: `[]` |
| `/api/claude_code_penguin_mode` | GET | `api.anthropic.com` | JSON: `{}` |
| `/api/claude_cli_profile` | GET | `api.anthropic.com` | JSON: `{}` |

### Token response format

```json
{
  "access_token": "<cop-key-from-config>",
  "refresh_token": "ref-copilot-api",
  "expires_in": 86400,
  "scope": "user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload org:create_api_key"
}
```

### Profile response format

```json
{
  "account": {
    "uuid": "copilot-api-user",
    "display_name": "Copilot API User",
    "created_at": "2025-01-01T00:00:00Z"
  },
  "organization": {
    "uuid": "copilot-api-org",
    "organization_type": "claude_max",
    "rate_limit_tier": "max",
    "billing_type": "self-serve",
    "has_extra_usage_enabled": true,
    "subscription_created_at": "2025-01-01T00:00:00Z"
  }
}
```

### Settings change

Remove `ANTHROPIC_API_KEY` from `~/.claude/settings.json` env block. User authenticates via `/login` which hits our server. The returned OAuth access_token (the cop- key) is used for all subsequent API calls via `Authorization: Bearer` header.

### Access token source

The `/v1/oauth/token` endpoint needs to return the cop- key as the access_token. It reads this from:
1. `config.json` `auth.apiKeys[0]` (first configured API key)
2. Or a new `oauthAccessToken` field in config

## 2. Voice WebSocket

### Endpoint

`GET /api/ws/speech_to_text/voice_stream` — upgrades to WebSocket.

Query parameters (from Claude Code):
- `encoding=linear16`
- `sample_rate=16000`
- `channels=1`
- `endpointing_ms=300`
- `utterance_end_ms=1000`
- `language=en`

### Protocol

**Client → Server:**
- Binary frames: raw PCM audio chunks (linear16, 16kHz, mono, little-endian)
- JSON text frames:
  - `{"type":"KeepAlive"}` — sent on connect and every 8s
  - `{"type":"CloseStream"}` — recording stopped, finalize

**Server → Client:**
- `{"type":"TranscriptText","data":"transcribed text"}` — transcript result
- `{"type":"TranscriptEndpoint"}` — marks end of utterance
- `{"type":"TranscriptError","description":"error message"}` — error

### Audio buffering strategy (buffer-and-batch)

1. On WebSocket open: initialize empty PCM buffer
2. On binary message: append to PCM buffer
3. On `CloseStream`:
   - If buffer is empty or too short (< 0.1s = 3200 bytes at 16kHz mono 16-bit), send `TranscriptEndpoint` immediately
   - Otherwise: convert PCM to WAV, send to Groq, return result as `TranscriptText` + `TranscriptEndpoint`
4. On `KeepAlive`: no-op (keeps connection alive)

### PCM to WAV conversion

Add a 44-byte WAV header to the raw PCM buffer:
- RIFF header
- Format: PCM (1), mono (1 channel), 16kHz sample rate, 16-bit depth
- Data chunk with the raw PCM bytes

This is a pure byte manipulation — no external dependencies needed.

## 3. Groq STT Integration

### API call

```
POST https://api.groq.com/openai/v1/audio/transcriptions
Authorization: Bearer <GROQ_API_KEY>
Content-Type: multipart/form-data

file: audio.wav (the WAV buffer)
model: whisper-large-v3-turbo
language: <from WebSocket query param, omit if "auto">
response_format: json
```

### Response

```json
{"text": "the transcribed text"}
```

### Configuration

- `GROQ_API_KEY` env var or `groqApiKey` field in `config.json`
- Model defaults to `whisper-large-v3-turbo` (fast, good quality)

### Error handling

- Groq API errors → send `TranscriptError` to client
- Empty transcription → send `TranscriptEndpoint` without `TranscriptText`
- Network timeout (5s) → send `TranscriptError`

## 4. SSL / Hosts Setup

### Hosts file entries

```
127.0.0.1 api.anthropic.com
127.0.0.1 claude.ai
127.0.0.1 platform.claude.com
```

### SSL certificates

Generate certs for `claude.ai` and `platform.claude.com` using the same SixCert CA (mitmproxy CA). Two options:
- **Multi-SAN cert**: one cert with all 3 domains as Subject Alternative Names
- **Per-domain certs**: separate certs, HTTPS proxy uses SNI callback

Multi-SAN is simpler. Update `https-proxy.mjs` to use it.

### Production (nginx)

In production, nginx terminates TLS for all 3 domains and proxies to copilot-api on port 4141. No changes to copilot-api itself.

## 5. File Structure

```
src/routes/oauth/
  route.ts              — OAuth endpoints (authorize, token, profile, roles)
src/routes/voice/
  route.ts              — WebSocket upgrade + voice handler
  groq-stt.ts           — Groq Whisper API client
  pcm-to-wav.ts         — PCM buffer → WAV conversion utility
```

## 6. Server Routing

In `server.ts`, mount before auth middleware (same pattern as GrowthBook and feature-flags):

```ts
// OAuth fake layer
server.route("/oauth", oauthRoutes)
server.route("/api/oauth", oauthApiRoutes)
server.route("/api/claude_code_penguin_mode", penguinRoute)
server.route("/api/claude_cli_profile", cliProfileRoute)

// Voice WebSocket
server.route("/api/ws", voiceRoutes)
```

The `/v1/oauth/token` endpoint needs to be mounted at the v1 prefix level.

## 7. Config Changes

Add to `AppConfig`:

```ts
groqApiKey?: string
groqModel?: string  // defaults to "whisper-large-v3-turbo"
oauthAccessToken?: string  // defaults to auth.apiKeys[0]
```

## Constraints

- Groq accepts max 25MB files (free tier), 100MB (dev tier)
- Minimum billed length is 10 seconds
- Supported formats: wav (we use this)
- No streaming/real-time STT — batch only
- Latency: ~200-500ms for short utterances via Groq
