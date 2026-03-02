# Web Search Support via GitHub MCP — Code Review Guide

## What Changed

Claude Code sends `web_search_20250305` as a server-side Anthropic tool. Previously, copilot-api either crashed on it (`params.type` error) or silently filtered it out. This PR makes web searches work end-to-end by:

1. Converting the server-side tool into a regular function tool
2. When the model calls it, intercepting the call and executing the search via GitHub's MCP endpoint (`/mcp/readonly`)
3. Injecting results back into the conversation and re-sending to the model
4. Returning the final response to Claude Code transparently

## Architecture

```
Claude Code → POST /v1/messages (with web_search_20250305 tool)
  → copilot-api converts to function tool "web_search"
  → sends to Copilot API (ChatCompletions or Responses)
  → model responds with tool_call: web_search({query: "..."})
  → copilot-api intercepts, calls GitHub MCP /mcp/readonly
  → gets search results as text
  → appends tool results to conversation, re-sends to model
  → model generates final response with search context
  → copilot-api returns to Claude Code
```

## Files Changed

### NEW: `src/services/copilot/mcp-web-search.ts`

The MCP web search client. This is the core new module.

**Review focus:**
- MCP session lifecycle: `initializeSession()` (lines 65-87) sends JSON-RPC `initialize`, extracts `Mcp-Session-Id` header
- `ensureSession()` (lines 89-93) — lazy init, cached session ID in module-level `mcpSessionId`
- `executeWebSearch()` (lines 97-139) — main entry point. Calls `tools/call` via JSON-RPC 2.0. Has retry on 401/403 (session expiry). Catches all errors and returns error string instead of throwing (so the model sees the error gracefully)
- `parseSearchResponse()` (lines 141-160) — extracts text content from MCP response
- Tool definitions: `WEB_SEARCH_FUNCTION_TOOL` (ChatCompletions format, line 164) and `WEB_SEARCH_RESPONSES_TOOL` (Responses API format, line 180)
- `isWebSearchToolType()` (line 195) — detects `web_search_*` type strings

**Things to verify:**
- Is module-level `mcpSessionId` safe for concurrent requests? (Single process, sequential requests — should be fine, but worth confirming)
- Error handling: does returning error strings to the model (instead of throwing) make sense?
- Auth: uses `state.copilotToken` directly. Headers are minimal (no `Copilot-Integration-Id` etc). Is that sufficient for MCP?
- No retry logic on the MCP fetch itself (unlike `copilotFetch`). Should it use `copilotFetch`? The MCP endpoint path is different from the normal API base.

### MODIFIED: `src/routes/messages/non-stream-translation.ts`

**What changed:** `translateAnthropicToolsToOpenAI()` (lines 247-278)

Previously filtered out all tools without `input_schema`. Now checks `isWebSearchToolType(tool)` first and converts matching tools to `WEB_SEARCH_FUNCTION_TOOL`. Other tools without `input_schema` are still filtered.

**Review focus:**
- Import added: `isWebSearchToolType`, `WEB_SEARCH_FUNCTION_TOOL` (lines 10-13)
- The conversion loop (lines 254-278): iterates tools, converts web_search, filters unknown server-side tools, passes through normal function tools
- No behavioral change for non-web-search tools

### MODIFIED: `src/routes/messages/responses-translation.ts`

**What changed:** `convertAnthropicTools()` (lines 353-383)

Same pattern as above but for the Responses API format. Uses `WEB_SEARCH_RESPONSES_TOOL` instead.

**Review focus:**
- Import added: `isWebSearchToolType`, `WEB_SEARCH_RESPONSES_TOOL` (lines 29-32)
- The conversion loop (lines 358-383)

### MODIFIED: `src/routes/messages/handler.ts`

This is the largest change. Adds web search interception loops to both the ChatCompletions and Responses API paths.

**New imports:** `executeWebSearch` (line 38), `ChatCompletionsPayload`, `Message`, `ToolCall` (lines 32-34), `ResponseInputItem`, `ResponsesPayload` (lines 36-37), `AnthropicResponse` (line 42)

**ChatCompletions non-streaming path** (`handleWithChatCompletions`, starting ~line 140):
- After getting response, calls `resolveWebSearchCalls()` (line 193) before translating
- `resolveWebSearchCalls()` (lines 570-617): loops up to `MAX_WEB_SEARCH_ITERATIONS=3`, extracts web_search tool calls, executes them in parallel via `executeWebSearch`, appends assistant+tool messages, re-sends
- `extractWebSearchCalls()` (lines 619-631): filters tool_calls for `web_search`

**ChatCompletions streaming path** (~line 204):
- Buffers ALL chunks first (lines 213-231) instead of streaming through
- Checks for web_search tool calls during buffering
- If found: reconstructs full response via `reconstructFromChunks()`, resolves searches, emits result as stream via `emitAnthropicResponseAsStream()`
- If not found: replays buffered chunks normally (lines 256-268)

**Review concern:** Buffering the entire stream adds latency for ALL streaming requests on the ChatCompletions path, even when there's no web search. This is the biggest tradeoff.

**Responses API path** (`handleWithResponsesApi`, starting ~line 271):
- Streaming: buffers all events, checks for web_search in `response.output_item.done` events
- Non-streaming: calls `resolveResponsesWebSearchCalls()` before translating
- `resolveResponsesWebSearchCalls()` (lines 881-943): similar loop pattern but builds Responses API input items

**Helper: `reconstructFromChunks()`** (lines 633-732):
- Reassembles a `ChatCompletionResponse` from streaming `ChatCompletionChunk`s
- Accumulates content, tool calls, reasoning text, usage

**Helper: `emitAnthropicResponseAsStream()`** (lines 737-879):
- Takes a complete `AnthropicResponse` and emits it as SSE events (message_start, content_block_start/delta/stop, message_delta, message_stop)
- Handles text, thinking, and tool_use blocks

### MODIFIED: `src/routes/responses/handler.ts`

**What changed:**
- `removeWebSearchTool` → `convertWebSearchTool` (lines 313-322): maps `{type:"web_search"}` to `WEB_SEARCH_RESPONSES_TOOL` instead of filtering
- Added `resolveResponsesWebSearch()` (lines 326-371): same pattern as messages handler
- Added `buildResolvedInput()` (lines 373-397): constructs new input array from original input + output items + tool results
- Added `emitResponsesResultAsStream()` (lines 403-478): emits a non-streaming ResponsesResult as stream events
- Streaming path (lines 148-244): buffers events, checks for web_search, resolves if found
- Non-streaming path (lines 248-271): resolves before returning

**New imports:** `ResponseInputItem` (line 26), `executeWebSearch`, `WEB_SEARCH_RESPONSES_TOOL` (lines 31-34)

### NOT MODIFIED (intentionally): `src/services/copilot/create-chat-completions.ts`

The `normalizePayload` guard for `!tool.function.parameters` (line 22) was already added in a previous session and remains as defense-in-depth.

### NOT MODIFIED (intentionally): `src/routes/messages/anthropic-types.ts`

`AnthropicTool.type` and `input_schema` are already optional (lines 89-93), which was done in the previous session.

## Key Review Questions

1. **Streaming latency**: Both ChatCompletions and Responses streaming paths now buffer ALL chunks before forwarding, even when no web search is present. Is this acceptable? Alternative: peek at first few chunks, forward immediately if no tool call detected (harder to implement correctly).

2. **Concurrency**: `mcpSessionId` is a module-level variable. Safe for single-process sequential handling, but could be an issue if requests overlap. Consider: is session reuse even needed, or should each search initialize fresh?

3. **Error propagation**: Web search errors are returned as text strings to the model (e.g., "Web search failed: 403"). The model will see this and can tell the user. Is this the right UX, or should we fail the request?

4. **MCP protocol correctness**: The implementation sends `initialize` then `tools/call`. Does GitHub's MCP require `initialized` notification after init? Does it require specific `protocolVersion`? The protocol version `2025-03-26` is hardcoded.

5. **No retry on MCP fetch**: Unlike `copilotFetch`, the MCP calls use raw `fetch` without retry. Should they use `copilotFetch` (which prepends `copilotBaseUrl()`)?

6. **MAX_WEB_SEARCH_ITERATIONS=3**: Is this sufficient? Too many? The constant is defined in both `handler.ts` and `responses/handler.ts` — should it be shared?

7. **Responses handler duplication**: `resolveResponsesWebSearch` and `buildResolvedInput` exist in both `src/routes/messages/handler.ts` and `src/routes/responses/handler.ts`. Consider extracting to a shared module.

## How to Test

1. Start copilot-api, connect Claude Code
2. Ask Claude Code to search the web: "Search for the latest Node.js release"
3. Watch logs for:
   - `MCP session initialized: <session-id>`
   - `Executing 1 web search(es), iteration 1`
   - `Web search query: ...`
4. Verify search results appear in Claude's response
5. Verify non-web-search requests still work normally (no regressions from stream buffering)
6. Test with both ChatCompletions models (e.g., claude-sonnet-4) and Responses API models (e.g., claude-opus-4.6)

---

## Post-Review Fixes Applied

The following issues were found during code review and have been fixed:

### [P1] Inconsistent `item_id` in synthesized Responses stream
**File:** `src/routes/responses/handler.ts` — `emitResponsesResultAsStream()`

**Problem:** When `function_call` items lacked `item.id`, `output_item.added` and `output_item.done` emitted the raw item without an id, but `function_call_arguments.done` synthesized `fc_${item.call_id}`. Downstream parsers couldn't correlate events.

**Fix:** Generate one stable `itemId` per output item at the top of the loop (`item.id ?? fc_${call_id} ?? item_${i}`), then reuse it across all emitted events (`output_item.added`, content deltas, `function_call_arguments.done`, `output_item.done`). The `itemWithId` spread ensures the item object itself always carries the id.

### [P1] Upstream stream errors dropped during replay
**File:** `src/routes/messages/handler.ts` — Responses streaming replay loop

**Problem:** The replay loop had `if (parsed.type === "error") continue`, silently dropping upstream error details. Clients only saw a generic "stream ended without completion" error.

**Fix:** Instead of skipping, translate error events into Anthropic error events via `buildErrorEvent()` and forward them. The error message is extracted from the parsed event's `message` field.

### [P1] Global MCP session state race under parallel searches
**File:** `src/services/copilot/mcp-web-search.ts`

**Problem:** `mcpSessionId` was a bare module-level variable. `executeWebSearch` runs in parallel via `Promise.all`. Multiple calls could race on `ensureSession()` (triggering duplicate initializations) and on session reset (one call resetting a session that another call just initialized).

**Fix:** Three changes:
1. **Promise-based init lock** (`mcpSessionPromise`): `ensureSession()` now checks for an in-flight init promise. If one exists, all callers await it instead of starting a new one. The promise is cleared on completion or error.
2. **Local session capture**: `executeWebSearch()` captures the session ID into a local variable before any async work, so it uses a consistent session throughout.
3. **Compare-and-swap invalidation**: `invalidateSession(callerSessionId)` only resets the global if it still matches the caller's session. This prevents a stale caller from blowing away a freshly-initialized session.
4. **`mcpFetch` takes explicit session ID**: No longer reads the global directly — the caller passes the session ID it captured.

### [P2] Keepalive ping events no longer forwarded
**File:** `src/routes/messages/handler.ts` — Responses streaming buffering loop

**Problem:** Ping events were dropped with `if (eventName === "ping") continue` during the buffering phase, causing long-running streams to lose keepalive traffic and risk proxy idle timeouts.

**Fix:** Forward ping events immediately during buffering (`await stream.writeSSE(...)`) before continuing to the next chunk. Pings are side-effect-free and don't need to be buffered for web_search detection.

### [P2] Multi-choice tool-call extraction vs single-choice replay
**File:** `src/routes/messages/handler.ts` — `extractWebSearchCalls()`

**Problem:** `extractWebSearchCalls` iterated all choices, but the replay assistant message only included `choices[0].tool_calls`. If `n>1`, tool_result messages could reference tool_call_ids from other choices that were never declared in the appended assistant message.

**Fix:** Restrict extraction to `choices[0]` only. Added a comment explaining the constraint. The assistant message replay already uses `choices[0]`, and copilot-api never sends `n>1`.
