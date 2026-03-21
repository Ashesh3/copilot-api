# WebSocket Transport for Responses API — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept WebSocket connections at `/v1/responses` (and `/responses`) so Codex CLI connects without falling back to HTTPS.

**Architecture:** Thin WebSocket-to-SSE bridge. WebSocket handler receives `response.create` JSON messages, calls existing `createResponses()` / `createChatCompletions()` services with streaming, and forwards each event as a WebSocket text frame. Reuses all existing service and proxy logic.

**Tech Stack:** Bun native WebSocket, Hono (unchanged), TypeScript

**Spec:** `docs/superpowers/specs/2026-03-21-websocket-responses-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/routes/responses/websocket.ts` | WebSocket upgrade check, message handler, responses-over-WS logic |
| Modify | `src/routes/responses/handler.ts` | Export 5 functions so websocket.ts can reuse them |
| Modify | `src/routes/voice/route.ts` | Add `type: 'voice'` discriminator to upgrade data |
| Modify | `src/start.ts` | Add responses WS upgrade check, combine WS handlers |

---

## Chunk 1: Implementation

### Task 1: Export shared functions from handler.ts

**Files:**
- Modify: `src/routes/responses/handler.ts`

Currently these functions are `const` (module-private). Add `export` so `websocket.ts` can import them.

- [ ] **Step 1: Add `export` to 5 functions**

Change these declarations from `const` to `export const`:

```typescript
// Line ~49: normalizeResponsesReasoning
export function normalizeResponsesReasoning(...)  // already a function declaration, just add export

// Line ~264: useFunctionApplyPatch
export const useFunctionApplyPatch = (...)

// Line ~296: convertWebSearchTool
export const convertWebSearchTool = (...)

// Line ~472: responsesToChatCompletions
export const responsesToChatCompletions = (...)

// Line ~852: streamChatCompletionsAsResponses
export const streamChatCompletionsAsResponses = (...)
```

No logic changes — only visibility.

- [ ] **Step 2: Verify lint passes**

Run: `bun run lint`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/routes/responses/handler.ts
git commit -m "refactor: export shared response functions for WebSocket reuse"
```

---

### Task 2: Add type discriminator to voice WebSocket

**Files:**
- Modify: `src/routes/voice/route.ts`

The Bun server only supports one `websocket` handler. To dispatch between voice and responses WebSockets, we add a `type` discriminator to the upgrade data.

- [ ] **Step 1: Update the `VoiceSession` data shape**

In `tryUpgradeVoiceWebSocket`, change the upgrade data to include a `type` field:

```typescript
// In tryUpgradeVoiceWebSocket (line ~139):
// Before:
return server.upgrade(req, { data: { session } })

// After:
return server.upgrade(req, { data: { type: "voice" as const, session } })
```

No changes needed to the handler itself — it accesses `ws.data.session` which still works.

- [ ] **Step 2: Commit**

```bash
git add src/routes/voice/route.ts
git commit -m "refactor: add type discriminator to voice WebSocket upgrade data"
```

---

### Task 3: Create WebSocket handler

**Files:**
- Create: `src/routes/responses/websocket.ts`

This is the core new file. It handles WebSocket upgrade, auth validation, message parsing, and streaming responses back over WebSocket.

- [ ] **Step 1: Create `src/routes/responses/websocket.ts`**

```typescript
import consola from "consola"

import { parseModelSuffix } from "~/lib/model-suffix"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

import {
  convertWebSearchTool,
  normalizeResponsesReasoning,
  responsesToChatCompletions,
  streamChatCompletionsAsResponses,
  useFunctionApplyPatch,
} from "./handler"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import { expandCompactionItems, getResponsesRequestOptions } from "./utils"

const RESPONSES_ENDPOINT = "/responses"

// Paths that trigger WebSocket upgrade for responses
const WS_PATHS = ["/v1/responses", "/responses"]

/**
 * Check if a request is a responses WebSocket upgrade and handle it.
 * Returns true if the upgrade was handled (or rejected for auth failure).
 */
export function tryUpgradeResponsesWebSocket(
  req: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): boolean {
  const url = new URL(req.url)
  if (!WS_PATHS.includes(url.pathname)) return false

  // Validate API key auth if enabled
  if (state.apiKeyAuth) {
    const apiKey = extractApiKeyFromRequest(req)
    if (apiKey !== state.apiKeyAuth) {
      consola.debug("[responses-ws] Rejected: invalid API key")
      return false // Let Hono return 401
    }
  }

  return server.upgrade(req, { data: { type: "responses" as const } })
}

function extractApiKeyFromRequest(req: Request): string | null {
  const xApiKey = req.headers.get("x-api-key")?.trim()
  if (xApiKey) return xApiKey

  const authorization = req.headers.get("authorization")
  if (!authorization) return null

  const [scheme, ...rest] = authorization.trim().split(/\s+/)
  if (scheme.toLowerCase() !== "bearer") return null

  return rest.join(" ").trim() || null
}

// Bun WebSocket handler for responses
export const responsesWebSocket = {
  open(_ws: { data: { type: "responses" } }) {
    consola.debug("[responses-ws] WebSocket connected")
  },

  async message(
    ws: {
      data: { type: "responses" }
      send(data: string | ArrayBuffer | Uint8Array): void
      close(code?: number, reason?: string): void
    },
    message: string | Buffer | Uint8Array,
  ) {
    if (typeof message !== "string") {
      ws.send(
        JSON.stringify({
          type: "error",
          error: { message: "Binary frames not supported", code: "invalid_request" },
        }),
      )
      return
    }

    let parsed: { type?: string; [key: string]: unknown }
    try {
      parsed = JSON.parse(message)
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          error: { message: "Invalid JSON", code: "invalid_request" },
        }),
      )
      return
    }

    if (parsed.type !== "response.create") {
      ws.send(
        JSON.stringify({
          type: "error",
          error: {
            message: `Unsupported message type: ${parsed.type}`,
            code: "invalid_request",
          },
        }),
      )
      return
    }

    try {
      await handleResponseCreate(ws, parsed)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Internal server error"
      consola.error("[responses-ws] Error:", errorMessage)
      ws.send(
        JSON.stringify({
          type: "error",
          error: { message: errorMessage, code: "server_error" },
        }),
      )
    }
  },

  close(_ws: { data: { type: "responses" } }) {
    consola.debug("[responses-ws] WebSocket closed")
  },
}

async function handleResponseCreate(
  ws: { send(data: string): void },
  message: Record<string, unknown>,
): Promise<void> {
  await checkRateLimit(state)

  // Strip the "type" field — the rest is the ResponsesPayload
  const { type: _type, ...rest } = message
  const payload = rest as unknown as ResponsesPayload

  // Force streaming for WebSocket mode
  payload.stream = true

  // Apply same transformations as HTTP handler
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    payload.model,
  )
  payload.model = baseModel
  normalizeResponsesReasoning(payload, suffixEffort)

  useFunctionApplyPatch(payload)
  convertWebSearchTool(payload)
  expandCompactionItems(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (!supportsResponses) {
    consola.debug(
      `[responses-ws] Model ${payload.model} does not support /responses, falling back to ChatCompletions`,
    )
    await streamChatCompletionsOverWs(ws, payload)
    return
  }

  // Native responses streaming
  const response = await createResponses(payload, { vision, initiator })

  if (!isAsyncIterable(response)) {
    // Shouldn't happen since we forced stream: true, but handle gracefully
    ws.send(JSON.stringify({ type: "response.completed", response }))
    return
  }

  const idTracker = createStreamIdTracker()
  for await (const chunk of response) {
    const data = (chunk as { data?: string }).data
    if (!data) continue

    const event = (chunk as { event?: string }).event
    const processed = fixStreamIds(data, event, idTracker)
    ws.send(processed)
  }
}

async function streamChatCompletionsOverWs(
  ws: { send(data: string): void },
  payload: ResponsesPayload,
): Promise<void> {
  const ccPayload = responsesToChatCompletions(payload)
  ccPayload.stream = true
  ccPayload.stream_options = { include_usage: true }

  const response = await createChatCompletions(ccPayload)
  const ccStream = response as AsyncIterable<{ data?: string; event?: string }>

  // Reuse the CC→Responses streaming translator with a WebSocket-backed writer
  const wsStream = {
    writeSSE: async (data: { event?: string; data: string }) => {
      ws.send(data.data)
    },
  }

  await streamChatCompletionsAsResponses(wsStream, ccStream, payload.model)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value) &&
  typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
```

- [ ] **Step 2: Verify lint passes**

Run: `bun run lint`
Expected: No new errors (may need to adjust lint issues)

- [ ] **Step 3: Commit**

```bash
git add src/routes/responses/websocket.ts
git commit -m "feat: add WebSocket handler for /v1/responses endpoint"
```

---

### Task 4: Wire up WebSocket in start.ts

**Files:**
- Modify: `src/start.ts`

Combine voice and responses WebSocket handlers into a single Bun `websocket` handler that dispatches based on the `type` field in `ws.data`.

- [ ] **Step 1: Add imports**

At the top of `start.ts`, add:

```typescript
import {
  tryUpgradeResponsesWebSocket,
  responsesWebSocket,
} from "./routes/responses/websocket"
```

- [ ] **Step 2: Add responses upgrade check in fetch callback**

In the `Bun.serve()` fetch callback (around line 268-276), add the responses WebSocket check after the voice check:

```typescript
fetch(req, bunServer) {
  // WebSocket upgrade must happen before Hono routing
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (tryUpgradeVoiceWebSocket(req, bunServer)) {
      return undefined as unknown as Response
    }
    if (tryUpgradeResponsesWebSocket(req, bunServer)) {
      return undefined as unknown as Response
    }
  }
  return server.fetch(req)
},
```

- [ ] **Step 3: Replace single websocket handler with combined dispatcher**

Replace `websocket: voiceWebSocket` with a combined handler:

```typescript
websocket: {
  open(ws: { data: { type: string } }) {
    if (ws.data.type === "voice") {
      voiceWebSocket.open(ws as Parameters<typeof voiceWebSocket.open>[0])
    } else if (ws.data.type === "responses") {
      responsesWebSocket.open(ws as Parameters<typeof responsesWebSocket.open>[0])
    }
  },
  message(
    ws: { data: { type: string }; send: (data: string | ArrayBuffer | Uint8Array) => void; close: (code?: number, reason?: string) => void },
    message: string | Buffer | Uint8Array,
  ) {
    if (ws.data.type === "voice") {
      voiceWebSocket.message(ws as Parameters<typeof voiceWebSocket.message>[0], message)
    } else if (ws.data.type === "responses") {
      void responsesWebSocket.message(
        ws as Parameters<typeof responsesWebSocket.message>[0],
        message,
      )
    }
  },
  close(ws: { data: { type: string } }) {
    if (ws.data.type === "voice") {
      voiceWebSocket.close(ws as Parameters<typeof voiceWebSocket.close>[0])
    } else if (ws.data.type === "responses") {
      responsesWebSocket.close(ws as Parameters<typeof responsesWebSocket.close>[0])
    }
  },
},
```

- [ ] **Step 4: Verify lint passes**

Run: `bun run lint`
Expected: No new errors

- [ ] **Step 5: Verify build passes**

Run: `bun run build`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add src/start.ts
git commit -m "feat: wire up WebSocket responses handler in server startup"
```

---

### Task 5: Manual test with Codex CLI

- [ ] **Step 1: Start copilot-api**

```bash
bun run dev
```

- [ ] **Step 2: Point Codex CLI at local server**

Configure Codex to use `http://localhost:4141` as the base URL and verify:
1. No "Falling back from WebSockets to HTTPS transport" warning
2. Responses stream correctly over WebSocket
3. Multi-turn conversation works over a single connection
4. Auth rejection works when using wrong API key

- [ ] **Step 3: Final commit (if any fixes needed)**
