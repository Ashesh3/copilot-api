# WebSocket Transport for Responses API

**Date:** 2026-03-21
**Status:** Approved
**Priority:** Nice-to-have (HTTPS fallback works fine)

## Problem

Codex CLI attempts to connect via WebSocket to `wss://{host}/v1/responses` before falling back to HTTPS. The server currently returns 404 for WebSocket upgrades at this path, causing a warning:

```
Falling back from WebSockets to HTTPS transport. unexpected status 404 Not Found
```

## Solution

Add a thin WebSocket-to-SSE bridge that accepts WebSocket connections at `/v1/responses` (and `/responses`), receives `response.create` JSON messages, proxies them through the existing responses service, and forwards streaming events back as WebSocket text frames.

## Architecture

```
Codex CLI                     copilot-api                      GitHub Copilot
   |                              |                                 |
   |-- WS upgrade -------------->| start.ts: tryUpgradeResponsesWs |
   |  wss://host/v1/responses     |                                 |
   |  Auth: Bearer {key}          |                                 |
   |  OpenAI-Beta: responses_ws   |                                 |
   |<-- 101 Switching Protocols --|                                 |
   |                              |                                 |
   |-- {"type":"response.create", |                                 |
   |   "model":"...", ...} ------>| parse JSON                      |
   |                              |-- POST /responses ------------->|
   |                              |  (streaming SSE)                |
   |                              |<-- SSE events ------------------|
   |<-- {"type":"response.created"|  forward as WS text frames     |
   |    ...} ---------------------|                                 |
   |<-- {"type":"response.output_ |                                 |
   |    text.delta",...} ---------|                                 |
   |<-- {"type":"response.        |                                 |
   |    completed",...} ----------|                                 |
   |                              |                                 |
   |  (connection stays open      |                                 |
   |   for next turn)             |                                 |
```

## Components

### 1. New file: `src/routes/responses/websocket.ts`

Exports:

- `tryUpgradeResponsesWebSocket(req, server)` - Checks if the request path matches `/v1/responses` or `/responses` AND has `upgrade: websocket` header, then upgrades the connection. Returns `true` if upgraded, `false` otherwise.

- `responsesWebSocket` - Bun `WebSocketHandler` object:
  - `open(ws)`: Log connection opened
  - `message(ws, data)`: Parse JSON text frame, validate it's a `response.create` message, call `handleResponsesWs(ws, payload)`
  - `close(ws)`: Log connection closed, cleanup

- `handleResponsesWs(ws, payload)`:
  - Extracts the `response.create` body (same shape as existing `ResponsesPayload`)
  - Runs same logic as `handler.ts`: model suffix parsing, `useFunctionApplyPatch`, `convertWebSearchTool`, `expandCompactionItems`
  - Checks if model supports `/responses` endpoint
  - If native responses: calls `createResponses(payload, opts)` with `stream: true`, iterates SSE events, sends each event's data as a WebSocket text frame via `ws.send()`
  - If ChatCompletions fallback: calls `createChatCompletions()` with streaming, translates CC chunks to Responses events (reusing the same translation logic from `handler.ts`), sends as WebSocket text frames
  - On error: sends `{"type": "error", "error": {"message": "...", "code": "..."}}`

### 2. Modify: `src/start.ts`

- Import `tryUpgradeResponsesWebSocket` and `responsesWebSocket` from the new file
- Add a second WebSocket upgrade check in the `fetch` callback, after the voice check
- Combine both WebSocket handlers into a single Bun `websocket` handler that dispatches based on connection metadata (e.g., a `type` field attached via `ws.data` during upgrade)

### 3. Auth handling

- Auth is extracted from the WebSocket upgrade request's `Authorization` header (Bearer token) or `x-api-key` header
- Validated using existing `apiKeyGuard` logic (checks against `state.apiKeyAuth`)
- If auth fails: reject upgrade by not calling `server.upgrade()` and returning a 401 response
- Rate limiting: checked per `response.create` message, not per connection

### 4. Event format

Each WebSocket text frame is a JSON object identical to the existing SSE event data. The `event` field from SSE becomes the `type` field in the JSON:

```json
{"type": "response.created", "response": {...}, "sequence_number": 0}
{"type": "response.output_item.added", "item": {...}, "output_index": 0, "sequence_number": 1}
{"type": "response.output_text.delta", "delta": "Hello", "item_id": "msg_001", "sequence_number": 2}
{"type": "response.output_text.done", "text": "Hello world", "sequence_number": 10}
{"type": "response.output_item.done", "item": {...}, "sequence_number": 11}
{"type": "response.completed", "response": {...}, "sequence_number": 15}
```

## Out of Scope (YAGNI)

- `previous_response_id` / server-side response caching (Codex handles client-side)
- `x-codex-turn-state` sticky routing (not needed for single-server proxy)
- 60-minute connection timeout enforcement (Bun's `idleTimeout: 255` handles this)
- Web search tool interception over WebSocket (can add later if needed)
- Realtime API (`/v1/realtime`) support (different protocol, not requested)

## Testing

- Manual testing with Codex CLI pointed at copilot-api
- Verify WebSocket connects without fallback warning
- Verify streaming responses arrive correctly
- Verify multi-turn conversation works over single connection
- Verify auth rejection works for bad tokens
