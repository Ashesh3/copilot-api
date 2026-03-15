# Voice Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Claude Code's `/voice` command via fake OAuth + Groq-powered speech-to-text over WebSocket.

**Architecture:** Fake OAuth endpoints let Claude Code think it's logged into Claude.ai. A WebSocket endpoint receives raw PCM audio, buffers it, converts to WAV, sends to Groq's Whisper API, and returns transcripts in Claude Code's expected protocol.

**Tech Stack:** Hono (routing), Bun (WebSocket, runtime), Groq Whisper API (STT), srvx (server with WebSocket passthrough)

---

## Chunk 1: PCM-to-WAV Utility and Groq STT Client

### Task 1: PCM-to-WAV conversion utility

**Files:**
- Create: `src/routes/voice/pcm-to-wav.ts`

- [ ] **Step 1: Create the PCM-to-WAV function**

```ts
// src/routes/voice/pcm-to-wav.ts

/**
 * Wraps raw PCM audio data (linear16, mono) in a WAV container.
 * Produces a valid WAV file buffer that can be sent to transcription APIs.
 */
export function pcmToWav(
  pcmData: Uint8Array,
  sampleRate: number = 16000,
  channels: number = 1,
  bitsPerSample: number = 16,
): Uint8Array {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  const dataSize = pcmData.length
  const headerSize = 44
  const fileSize = headerSize + dataSize

  const buffer = new ArrayBuffer(fileSize)
  const view = new DataView(buffer)
  const output = new Uint8Array(buffer)

  // RIFF header
  writeString(view, 0, "RIFF")
  view.setUint32(4, fileSize - 8, true) // file size - 8
  writeString(view, 8, "WAVE")

  // fmt sub-chunk
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true) // sub-chunk size (16 for PCM)
  view.setUint16(20, 1, true) // audio format (1 = PCM)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)

  // data sub-chunk
  writeString(view, 36, "data")
  view.setUint32(40, dataSize, true)

  // PCM data
  output.set(pcmData, headerSize)

  return output
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd F:/Projects/copilot-api && bun run typecheck`
Expected: clean output

- [ ] **Step 3: Commit**

```bash
git add src/routes/voice/pcm-to-wav.ts
git commit -m "feat(voice): add PCM-to-WAV conversion utility"
```

---

### Task 2: Groq STT client

**Files:**
- Create: `src/routes/voice/groq-stt.ts`
- Modify: `src/lib/config.ts`

- [ ] **Step 1: Add groq config fields to AppConfig**

In `src/lib/config.ts`, add to the `AppConfig` interface:

```ts
groqApiKey?: string
groqModel?: string
```

- [ ] **Step 2: Create the Groq STT client**

```ts
// src/routes/voice/groq-stt.ts

import { getConfig } from "~/lib/config"

export interface TranscriptionResult {
  text: string
}

/**
 * Sends a WAV audio buffer to Groq's Whisper API for transcription.
 */
export async function transcribe(
  wavData: Uint8Array,
  language?: string,
): Promise<TranscriptionResult> {
  const config = getConfig()
  const apiKey = config.groqApiKey ?? process.env.GROQ_API_KEY

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured")
  }

  const model = config.groqModel ?? "whisper-large-v3-turbo"
  const url = "https://api.groq.com/openai/v1/audio/transcriptions"

  const formData = new FormData()
  formData.append(
    "file",
    new Blob([wavData], { type: "audio/wav" }),
    "audio.wav",
  )
  formData.append("model", model)
  formData.append("response_format", "json")

  if (language && language !== "auto") {
    formData.append("language", language)
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal: AbortSignal.timeout(10000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Groq API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as { text?: string }
  return { text: data.text?.trim() ?? "" }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd F:/Projects/copilot-api && bun run typecheck`
Expected: clean output

- [ ] **Step 4: Commit**

```bash
git add src/routes/voice/groq-stt.ts src/lib/config.ts
git commit -m "feat(voice): add Groq Whisper STT client"
```

---

## Chunk 2: Voice WebSocket Handler

### Task 3: Voice WebSocket route

**Files:**
- Create: `src/routes/voice/route.ts`
- Modify: `src/server.ts`
- Modify: `src/start.ts`

- [ ] **Step 1: Create the voice WebSocket handler**

```ts
// src/routes/voice/route.ts

import consola from "consola"

import { pcmToWav } from "./pcm-to-wav"
import { transcribe } from "./groq-stt"

// Minimum audio length to send to Groq (0.1s at 16kHz, 16-bit, mono = 3200 bytes)
const MIN_AUDIO_BYTES = 3200

interface VoiceSession {
  pcmChunks: Array<Uint8Array>
  totalBytes: number
  language: string
  closed: boolean
}

function createSession(language: string): VoiceSession {
  return {
    pcmChunks: [],
    totalBytes: 0,
    language,
    closed: false,
  }
}

function appendAudio(session: VoiceSession, data: Uint8Array): void {
  session.pcmChunks.push(data)
  session.totalBytes += data.length
}

function getAudioBuffer(session: VoiceSession): Uint8Array {
  const buffer = new Uint8Array(session.totalBytes)
  let offset = 0
  for (const chunk of session.pcmChunks) {
    buffer.set(chunk, offset)
    offset += chunk.length
  }
  return buffer
}

function clearAudio(session: VoiceSession): void {
  session.pcmChunks = []
  session.totalBytes = 0
}

async function finalizeAudio(
  session: VoiceSession,
  ws: { send(data: string): void },
): Promise<void> {
  if (session.totalBytes < MIN_AUDIO_BYTES) {
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
    clearAudio(session)
    return
  }

  const pcm = getAudioBuffer(session)
  clearAudio(session)

  try {
    const wav = pcmToWav(pcm)
    const result = await transcribe(wav, session.language)

    if (result.text) {
      ws.send(JSON.stringify({ type: "TranscriptText", data: result.text }))
    }
    ws.send(JSON.stringify({ type: "TranscriptEndpoint" }))
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Transcription failed"
    consola.error("[voice]", message)
    ws.send(
      JSON.stringify({ type: "TranscriptError", description: message }),
    )
  }
}

// Export WebSocket handlers for Bun.serve
export const voiceWebSocket = {
  open(ws: { data: { session: VoiceSession } }) {
    consola.debug("[voice] WebSocket connected")
  },

  message(
    ws: { data: { session: VoiceSession }; send(data: string): void },
    message: string | Buffer | Uint8Array,
  ) {
    const session = ws.data.session

    // Binary frame: audio data
    if (typeof message !== "string") {
      const audio =
        message instanceof Uint8Array ? message : new Uint8Array(message)
      appendAudio(session, audio)
      return
    }

    // Text frame: JSON control message
    let parsed: { type: string }
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }

    switch (parsed.type) {
      case "KeepAlive":
        // No-op, keeps connection alive
        break
      case "CloseStream":
        session.closed = true
        finalizeAudio(session, ws)
        break
    }
  },

  close(ws: { data: { session: VoiceSession } }) {
    consola.debug("[voice] WebSocket closed")
  },
}

// Path that Claude Code connects to
export const VOICE_WS_PATH = "/api/ws/speech_to_text/voice_stream"

/**
 * Check if a request is a voice WebSocket upgrade and handle it.
 * Returns true if the upgrade was handled, false otherwise.
 * Called from the fetch handler before Hono routing.
 */
export function tryUpgradeVoiceWebSocket(
  req: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): boolean {
  const url = new URL(req.url)
  if (url.pathname !== VOICE_WS_PATH) return false

  const language = url.searchParams.get("language") ?? "en"
  const session = createSession(language)

  const upgraded = server.upgrade(req, {
    data: { session },
  })

  if (!upgraded) {
    consola.warn("[voice] WebSocket upgrade failed")
  }

  return upgraded
}
```

- [ ] **Step 2: Modify `src/start.ts` to pass WebSocket handlers to srvx**

In `src/start.ts`, update the `serve()` call to include WebSocket config:

```ts
// Add import at top:
import { voiceWebSocket } from "./routes/voice/route"

// Update the serve() call (around line 264):
  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    hostname: options.host,
    bun: {
      idleTimeout: 255,
      websocket: voiceWebSocket,
    },
  })
```

- [ ] **Step 3: Modify `src/server.ts` to handle WebSocket upgrade before Hono**

The WebSocket upgrade must happen in the raw `fetch` handler before Hono processes it. Modify `src/start.ts` to wrap the fetch handler:

```ts
// Replace the serve() call with:
import { tryUpgradeVoiceWebSocket } from "./routes/voice/route"

  serve({
    fetch(req: Request, server: unknown) {
      // WebSocket upgrade must happen before Hono routing
      if (
        req.headers.get("upgrade")?.toLowerCase() === "websocket"
        && tryUpgradeVoiceWebSocket(
          req,
          server as { upgrade(req: Request, opts?: object): boolean },
        )
      ) {
        return undefined as unknown as Response
      }
      return (server.fetch as ServerHandler)(req, server)
    },
    port: options.port,
    hostname: options.host,
    bun: {
      idleTimeout: 255,
      websocket: voiceWebSocket,
    },
  })
```

Wait — srvx wraps the fetch internally. We need a different approach. Since srvx passes `bun` options through to `Bun.serve`, and srvx's own fetch handler gets the `server` object, we need to intercept at the srvx level.

Actually, the simplest approach: use srvx's `manual` mode to get the server instance, then add middleware that checks for upgrades. But looking at srvx source, the `fetch` in the options IS the user-provided fetch, and srvx wraps it. The bun server object is passed as the second arg.

Let me revise. The correct approach is to NOT use srvx for this and switch to `Bun.serve` directly:

```ts
// In start.ts, replace serve() call:
import { voiceWebSocket, tryUpgradeVoiceWebSocket } from "./routes/voice/route"

  const bunServer = Bun.serve({
    port: options.port,
    hostname: options.host,
    idleTimeout: 255,
    fetch(req, bunSrv) {
      if (
        req.headers.get("upgrade")?.toLowerCase() === "websocket"
        && tryUpgradeVoiceWebSocket(req, bunSrv)
      ) {
        return undefined as unknown as Response
      }
      return server.fetch(req)
    },
    websocket: voiceWebSocket,
  })

  consola.info(`Listening on: http://${options.host ?? "localhost"}:${options.port}/`)
```

- [ ] **Step 4: Verify typecheck**

Run: `cd F:/Projects/copilot-api && bun run typecheck`
Expected: clean output

- [ ] **Step 5: Commit**

```bash
git add src/routes/voice/route.ts src/start.ts
git commit -m "feat(voice): add voice WebSocket handler with Groq STT"
```

---

## Chunk 3: OAuth Fake Layer

### Task 4: OAuth endpoints

**Files:**
- Create: `src/routes/oauth/route.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Create the OAuth routes**

```ts
// src/routes/oauth/route.ts

import { Hono } from "hono"

import { getConfig } from "~/lib/config"

export const oauthRoutes = new Hono()

const SCOPES =
  "user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload org:create_api_key"

/**
 * Get the access token to return in OAuth responses.
 * Uses the first configured API key from config.json.
 */
function getAccessToken(): string {
  const config = getConfig()
  const keys = config.auth?.apiKeys ?? []
  if (keys.length > 0) return keys[0]
  return "copilot-api-token"
}

// GET /oauth/authorize — browser redirect, auto-approve
oauthRoutes.get("/authorize", (c) => {
  const redirectUri = c.req.query("redirect_uri")
  const state = c.req.query("state")

  if (!redirectUri) {
    return c.text("Missing redirect_uri", 400)
  }

  const url = new URL(redirectUri)
  url.searchParams.set("code", "copilot-api-auth-code")
  if (state) url.searchParams.set("state", state)

  return c.redirect(url.toString(), 302)
})

// GET /oauth/code/success — success page after auth
oauthRoutes.get("/oauth/code/success", (c) => {
  return c.html(
    "<html><body><h1>Login successful</h1><p>You can close this tab.</p></body></html>",
  )
})

// GET /oauth/code/callback — manual callback fallback
oauthRoutes.get("/oauth/code/callback", (c) => {
  const code = "copilot-api-auth-code"
  return c.html(
    `<html><body><h1>Authorization Code</h1><p>Copy this code into Claude Code:</p><pre>${code}</pre></body></html>`,
  )
})

// POST /v1/oauth/token — token exchange and refresh
oauthRoutes.post("/v1/oauth/token", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, string>
  const grantType = body.grant_type

  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return c.json({ error: "unsupported_grant_type" }, 400)
  }

  return c.json({
    access_token: getAccessToken(),
    refresh_token: "ref-copilot-api",
    expires_in: 86400,
    scope: SCOPES,
    token_type: "bearer",
  })
})

// GET /api/oauth/profile — fake profile
oauthRoutes.get("/api/oauth/profile", (c) => {
  return c.json({
    account: {
      uuid: "copilot-api-user",
      display_name: "Copilot API User",
      created_at: "2025-01-01T00:00:00Z",
    },
    organization: {
      uuid: "copilot-api-org",
      organization_type: "claude_max",
      rate_limit_tier: "max",
      billing_type: "self-serve",
      has_extra_usage_enabled: true,
      subscription_created_at: "2025-01-01T00:00:00Z",
    },
  })
})

// GET /api/oauth/claude_cli/roles — empty roles
oauthRoutes.get("/api/oauth/claude_cli/roles", (c) => {
  return c.json([])
})

// GET /api/claude_code_penguin_mode — empty response
oauthRoutes.get("/api/claude_code_penguin_mode", (c) => {
  return c.json({})
})

// GET /api/claude_cli_profile — empty response
oauthRoutes.get("/api/claude_cli_profile", (c) => {
  return c.json({})
})

// POST /api/event_logging/batch — silently accept telemetry
oauthRoutes.post("/api/event_logging/batch", (c) => {
  return c.json({ success: true })
})
```

- [ ] **Step 2: Mount OAuth routes in `src/server.ts`**

Add to the pre-middleware section (before `server.use(apiKeyGuard)`):

```ts
import { oauthRoutes } from "./routes/oauth/route"

// OAuth fake layer — must be before auth middleware
server.route("/oauth", oauthRoutes)
server.route("/v1/oauth", oauthRoutes)
server.route("/api/oauth", oauthRoutes)
server.route("/api/claude_code_penguin_mode", oauthRoutes)
server.route("/api/claude_cli_profile", oauthRoutes)
server.route("/api/event_logging", oauthRoutes)
```

Wait — the routes in `oauthRoutes` have full paths like `/authorize`, `/api/oauth/profile`, etc. We need to structure this so that mounting works correctly. Since all these endpoints come from different path prefixes, the simplest approach is to mount at root level with each sub-path handled inside the Hono app:

Actually, let me restructure. The Hono router mounts strip the prefix. So `server.route("/oauth", app)` means `app.get("/authorize")` handles `/oauth/authorize`. Let me split by mount point:

```ts
// In server.ts, the pre-middleware section becomes:

import { oauthBrowserRoutes, oauthApiRoutes, oauthTokenRoutes, miscApiRoutes } from "./routes/oauth/route"

// OAuth + misc API — must be before auth middleware
server.route("/oauth", oauthBrowserRoutes)
server.route("/v1/oauth", oauthTokenRoutes)
server.route("/api", oauthApiRoutes)
server.route("/api", miscApiRoutes)
```

Let me revise the route file to export separate Hono apps per mount point. This is cleaner:

```ts
// src/routes/oauth/route.ts

import { Hono } from "hono"
import { getConfig } from "~/lib/config"

const SCOPES =
  "user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload org:create_api_key"

function getAccessToken(): string {
  const config = getConfig()
  const keys = config.auth?.apiKeys ?? []
  if (keys.length > 0) return keys[0]
  return "copilot-api-token"
}

// --- Browser routes: mounted at /oauth ---

export const oauthBrowserRoutes = new Hono()

oauthBrowserRoutes.get("/authorize", (c) => {
  const redirectUri = c.req.query("redirect_uri")
  const state = c.req.query("state")
  if (!redirectUri) return c.text("Missing redirect_uri", 400)
  const url = new URL(redirectUri)
  url.searchParams.set("code", "copilot-api-auth-code")
  if (state) url.searchParams.set("state", state)
  return c.redirect(url.toString(), 302)
})

oauthBrowserRoutes.get("/code/success", (c) => {
  return c.html(
    "<html><body><h1>Login successful</h1><p>You can close this tab.</p></body></html>",
  )
})

oauthBrowserRoutes.get("/code/callback", (c) => {
  return c.html(
    "<html><body><h1>Authorization Code</h1><p>Copy this code into Claude Code:</p><pre>copilot-api-auth-code</pre></body></html>",
  )
})

// --- Token routes: mounted at /v1/oauth ---

export const oauthTokenRoutes = new Hono()

oauthTokenRoutes.post("/token", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, string>
  const grantType = body.grant_type
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return c.json({ error: "unsupported_grant_type" }, 400)
  }
  return c.json({
    access_token: getAccessToken(),
    refresh_token: "ref-copilot-api",
    expires_in: 86400,
    scope: SCOPES,
    token_type: "bearer",
  })
})

// --- API routes: mounted at /api ---

export const oauthApiRoutes = new Hono()

oauthApiRoutes.get("/oauth/profile", (c) => {
  return c.json({
    account: {
      uuid: "copilot-api-user",
      display_name: "Copilot API User",
      created_at: "2025-01-01T00:00:00Z",
    },
    organization: {
      uuid: "copilot-api-org",
      organization_type: "claude_max",
      rate_limit_tier: "max",
      billing_type: "self-serve",
      has_extra_usage_enabled: true,
      subscription_created_at: "2025-01-01T00:00:00Z",
    },
  })
})

oauthApiRoutes.get("/oauth/claude_cli/roles", (c) => c.json([]))
oauthApiRoutes.get("/claude_code_penguin_mode", (c) => c.json({}))
oauthApiRoutes.get("/claude_cli_profile", (c) => c.json({}))
oauthApiRoutes.post("/event_logging/batch", (c) => c.json({ success: true }))
```

- [ ] **Step 3: Update `src/server.ts` imports and mounts**

```ts
// Add to imports:
import {
  oauthBrowserRoutes,
  oauthTokenRoutes,
  oauthApiRoutes,
} from "./routes/oauth/route"

// Add to the pre-middleware section (before server.use(apiKeyGuard)):
server.route("/oauth", oauthBrowserRoutes)
server.route("/v1/oauth", oauthTokenRoutes)
server.route("/api", oauthApiRoutes)
```

- [ ] **Step 4: Verify typecheck**

Run: `cd F:/Projects/copilot-api && bun run typecheck`
Expected: clean output

- [ ] **Step 5: Commit**

```bash
git add src/routes/oauth/route.ts src/server.ts
git commit -m "feat(oauth): add fake OAuth layer for Claude Code voice mode"
```

---

## Chunk 4: Settings Change and SSL Setup

### Task 5: Remove ANTHROPIC_API_KEY, update settings

**Files:**
- Modify: `~/.claude/settings.json`
- Modify: hosts file

- [ ] **Step 1: Update `~/.claude/settings.json`**

Remove `ANTHROPIC_API_KEY` from the env block. After the fake OAuth is working, the user authenticates via `/login` instead.

```json
{
  "env": {
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "ENABLE_TOOL_SEARCH": "true",
    "NODE_EXTRA_CA_CERTS": "D:\\Network Shared\\SIXCERT\\mitmproxy-ca-cert.pem"
  }
}
```

- [ ] **Step 2: Add hosts entries** (as Administrator)

```
127.0.0.1 api.anthropic.com
127.0.0.1 claude.ai
127.0.0.1 platform.claude.com
```

- [ ] **Step 3: Generate SSL certs for new domains**

Using the SixCert CA at `D:\Network Shared\SIXCERT\`, generate certs for `claude.ai` and `platform.claude.com`:

```bash
# From D:\Network Shared\SIXCERT\
# Generate claude.ai cert
openssl req -new -nodes -keyout claude.ai.key -out claude.ai.csr -subj "/CN=claude.ai" -addext "subjectAltName=DNS:claude.ai"
openssl x509 -req -in claude.ai.csr -CA mitmproxy-ca-cert.pem -CAkey mitmproxy-ca.key -CAserial mitmproxy-ca-cert.srl -out claude.ai.crt -days 365 -extfile <(echo "subjectAltName=DNS:claude.ai")

# Generate platform.claude.com cert
openssl req -new -nodes -keyout platform.claude.com.key -out platform.claude.com.csr -subj "/CN=platform.claude.com" -addext "subjectAltName=DNS:platform.claude.com"
openssl x509 -req -in platform.claude.com.csr -CA mitmproxy-ca-cert.pem -CAkey mitmproxy-ca.key -CAserial mitmproxy-ca-cert.srl -out platform.claude.com.crt -days 365 -extfile <(echo "subjectAltName=DNS:platform.claude.com")
```

Copy all cert files to `F:\Projects\copilot-api\dist\`.

- [ ] **Step 4: Update HTTPS proxy to handle SNI for multiple domains**

Replace `dist/https-proxy.mjs` with an SNI-aware version:

```js
import { readFileSync } from "node:fs"
import { createServer, createSecureContext } from "node:tls"
import { request } from "node:http"
import { join } from "node:path"

const CERT_DIR = import.meta.dirname ?? "."
const UPSTREAM = { host: "127.0.0.1", port: 4141 }

const certs = {
  "api.anthropic.com": {
    cert: readFileSync(join(CERT_DIR, "api.anthropic.com.crt")),
    key: readFileSync(join(CERT_DIR, "api.anthropic.com.key")),
  },
  "claude.ai": {
    cert: readFileSync(join(CERT_DIR, "claude.ai.crt")),
    key: readFileSync(join(CERT_DIR, "claude.ai.key")),
  },
  "platform.claude.com": {
    cert: readFileSync(join(CERT_DIR, "platform.claude.com.crt")),
    key: readFileSync(join(CERT_DIR, "platform.claude.com.key")),
  },
}

const contexts = {}
for (const [domain, files] of Object.entries(certs)) {
  contexts[domain] = createSecureContext(files)
}

const defaultCert = certs["api.anthropic.com"]

const server = createServer(
  {
    ...defaultCert,
    SNICallback: (hostname, cb) => {
      const ctx = contexts[hostname]
      cb(null, ctx ?? null)
    },
  },
  (req, res) => {
    // Handle WebSocket upgrades
    const isUpgrade = req.headers.upgrade?.toLowerCase() === "websocket"

    const proxy = request(
      {
        hostname: UPSTREAM.host,
        port: UPSTREAM.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: req.headers.host },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 500, upstream.headers)
        upstream.pipe(res)
      },
    )
    proxy.on("error", (err) => {
      console.error("Proxy error:", err.message)
      if (!res.headersSent) {
        res.writeHead(502)
        res.end("Bad Gateway")
      }
    })
    req.pipe(proxy)
  },
)

// Handle WebSocket upgrade at the TLS proxy level
server.on("upgrade", (req, socket, head) => {
  const proxy = request(
    {
      hostname: UPSTREAM.host,
      port: UPSTREAM.port,
      path: req.url,
      method: "GET",
      headers: req.headers,
    },
  )
  proxy.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 ${proxyRes.statusMessage}\r\n` +
      Object.entries(proxyRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") +
      "\r\n\r\n",
    )
    if (proxyHead.length) socket.write(proxyHead)
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })
  proxy.on("error", (err) => {
    console.error("WS proxy error:", err.message)
    socket.destroy()
  })
  proxy.end()
})

server.listen(443, "127.0.0.1", () => {
  console.log("HTTPS proxy listening on https://127.0.0.1:443")
  console.log(`Forwarding to http://${UPSTREAM.host}:${UPSTREAM.port}`)
  console.log("Domains: " + Object.keys(certs).join(", "))
})
```

- [ ] **Step 5: Commit dist changes**

```bash
git add dist/https-proxy.mjs
git commit -m "feat(proxy): add SNI-aware HTTPS proxy with WebSocket support"
```

---

### Task 6: Test the full flow

- [ ] **Step 1: Start copilot-api**

```bash
cd F:\Projects\copilot-api && bun run --watch ./src/main.ts start
```

- [ ] **Step 2: Start HTTPS proxy (as Administrator)**

```bash
cd F:\Projects\copilot-api\dist && node https-proxy.mjs
```

- [ ] **Step 3: Test OAuth authorize endpoint**

```bash
curl -k -v "https://claude.ai/oauth/authorize?redirect_uri=http://localhost:9999/callback&state=test123"
```

Expected: 302 redirect to `http://localhost:9999/callback?code=copilot-api-auth-code&state=test123`

- [ ] **Step 4: Test token exchange**

```bash
curl -k -X POST https://platform.claude.com/v1/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"authorization_code","code":"copilot-api-auth-code","redirect_uri":"http://localhost:9999/callback","client_id":"test"}'
```

Expected: JSON with `access_token`, `refresh_token`, `scope`, `expires_in`

- [ ] **Step 5: Test profile endpoint**

```bash
curl -k https://api.anthropic.com/api/oauth/profile \
  -H "Authorization: Bearer test"
```

Expected: JSON with `account` and `organization` objects

- [ ] **Step 6: Test voice WebSocket**

```bash
# Simple test — connect, send KeepAlive, close
curl -k --include \
  --no-buffer \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://api.anthropic.com/api/ws/speech_to_text/voice_stream?language=en"
```

Expected: 101 Switching Protocols

- [ ] **Step 7: Login in Claude Code**

1. Start Claude Code: `claude --dangerously-skip-permissions`
2. Run `/login`
3. Select "Claude.ai" login method
4. Browser opens, auto-redirects, login completes
5. Run `/voice` — should show "Voice mode enabled"

- [ ] **Step 8: Test voice dictation**

Hold Space to record, speak, release. Should see transcribed text appear.
