# Responses API Port — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the OpenAI Responses API (`/v1/responses`) and enhanced Anthropic Messages routing from caozhiyuan's fork to @ashsec/copilot-api, bumping version to 0.8.0.

**Architecture:** Additive port — copy new files from source fork, make minimal edits to existing files to wire them in. Preserve existing Azure OpenAI and auto-replace features unique to the target fork.

**Tech Stack:** TypeScript, Hono, Bun, fetch-event-stream, zod

**Source fork:** `C:\Users\asheshkumar\Downloads\Compressed\Codex-Windows-main\copilot-api` (branch: feature/responses-api)
**Target fork:** `C:\Users\asheshkumar\Documents\tmp\copilot-api` (branch: master, v0.7.13)

---

### Task 1: Add config.ts — App configuration system

**Files:**
- Copy from source: `src/lib/config.ts`
- Verify: `src/lib/paths.ts` has `CONFIG_PATH`

**Step 1: Check that PATHS.CONFIG_PATH exists in target**

Read `src/lib/paths.ts` in target fork. If `CONFIG_PATH` is missing, add it:
```typescript
CONFIG_PATH: path.join(APP_DIR, "config.json"),
```

**Step 2: Copy config.ts from source to target**

Copy `src/lib/config.ts` from source fork verbatim to target fork at `src/lib/config.ts`.

**Step 3: Verify no import conflicts**

Run: `bun run typecheck`
Expected: May have errors (later tasks not done yet), but `config.ts` itself should have no issues.

**Step 4: Commit**

```bash
git add src/lib/config.ts src/lib/paths.ts
git commit -m "feat: add app configuration system (config.ts)"
```

---

### Task 2: Add logger.ts — Handler logging utility

**Files:**
- Copy from source: `src/lib/logger.ts`

**Step 1: Copy logger.ts from source to target**

Copy `src/lib/logger.ts` from source fork. Read it first to understand its interface.

**Step 2: Commit**

```bash
git add src/lib/logger.ts
git commit -m "feat: add handler logging utility"
```

---

### Task 3: Add request-auth.ts — API key authentication middleware

**Files:**
- Copy from source: `src/lib/request-auth.ts`

**Step 1: Copy request-auth.ts from source to target**

Copy verbatim. This depends on `config.ts` (Task 1).

**Step 2: Commit**

```bash
git add src/lib/request-auth.ts
git commit -m "feat: add API key authentication middleware"
```

---

### Task 4: Add create-responses.ts — Copilot Responses API service

**Files:**
- Copy from source: `src/services/copilot/create-responses.ts`

**Step 1: Copy create-responses.ts from source to target**

This file contains the service function and all Responses API type definitions. Copy verbatim.

**Step 2: Verify imports resolve**

The file imports from `~/lib/api-config`, `~/lib/state`, `~/lib/token`. These all exist in the target.

**Step 3: Commit**

```bash
git add src/services/copilot/create-responses.ts
git commit -m "feat: add Copilot Responses API service"
```

---

### Task 5: Add create-messages.ts — Copilot native Messages API service

**Files:**
- Copy from source: `src/services/copilot/create-messages.ts`

**Step 1: Copy create-messages.ts from source to target**

This enables the native Anthropic Messages API passthrough for Claude models.

**Step 2: Commit**

```bash
git add src/services/copilot/create-messages.ts
git commit -m "feat: add Copilot native Messages API service"
```

---

### Task 6: Add responses route files

**Files:**
- Copy from source: `src/routes/responses/route.ts`
- Copy from source: `src/routes/responses/handler.ts`
- Copy from source: `src/routes/responses/stream-id-sync.ts`
- Copy from source: `src/routes/responses/utils.ts`

**Step 1: Create directory and copy all 4 files**

```bash
mkdir -p src/routes/responses
```

Copy all 4 files from source fork's `src/routes/responses/` to target.

**Step 2: Review handler.ts imports**

The handler imports:
- `~/lib/config` (Task 1)
- `~/lib/logger` (Task 2)
- `~/lib/approval`, `~/lib/rate-limit`, `~/lib/state` (exist in target)
- `~/services/copilot/create-responses` (Task 4)

All dependencies should be in place.

**Step 3: Commit**

```bash
git add src/routes/responses/
git commit -m "feat: add /v1/responses endpoint"
```

---

### Task 7: Add messages translation files

**Files:**
- Copy from source: `src/routes/messages/responses-translation.ts`
- Copy from source: `src/routes/messages/responses-stream-translation.ts`
- Copy from source: `src/routes/messages/subagent-marker.ts`

**Step 1: Copy all 3 files to target's messages directory**

These files are new (don't exist in target). Copy verbatim.

**Step 2: Commit**

```bash
git add src/routes/messages/responses-translation.ts src/routes/messages/responses-stream-translation.ts src/routes/messages/subagent-marker.ts
git commit -m "feat: add Anthropic-to-Responses translation and subagent marker"
```

---

### Task 8: Update api-config.ts — Bump Copilot/API versions

**Files:**
- Modify: `src/lib/api-config.ts`

**Step 1: Update version constants**

Change these lines:
```typescript
// FROM:
const COPILOT_VERSION = "0.26.7"
const API_VERSION = "2025-04-01"
// TO:
const COPILOT_VERSION = "0.37.6"
const API_VERSION = "2025-10-01"
```

Also change the `openai-intent` header value:
```typescript
// FROM:
"openai-intent": "conversation-panel",
// TO:
"openai-intent": "conversation-agent",
```

**Step 2: Commit**

```bash
git add src/lib/api-config.ts
git commit -m "feat: update Copilot API version to 0.37.6 and API version to 2025-10-01"
```

---

### Task 9: Update state.ts — Add verbose field

**Files:**
- Modify: `src/lib/state.ts`

**Step 1: Add verbose field to State interface and default**

Add `verbose: boolean` to the interface (after the `debug` field) and `verbose: false` to the default state. Keep all existing fields (including Azure OpenAI fields).

```typescript
export interface State {
  // ... existing fields ...
  debug: boolean
  verbose: boolean  // ADD THIS
  // ... existing Azure fields ...
}

export const state: State = {
  // ... existing defaults ...
  debug: false,
  verbose: false,  // ADD THIS
}
```

**Step 2: Commit**

```bash
git add src/lib/state.ts
git commit -m "feat: add verbose field to state"
```

---

### Task 10: Update start.ts — Initialize config and verbose state

**Files:**
- Modify: `src/start.ts`

**Step 1: Import mergeConfigWithDefaults**

Add to imports:
```typescript
import { mergeConfigWithDefaults } from "./lib/config"
```

**Step 2: Set verbose state and initialize config**

After `state.debug = options.debug` add:
```typescript
state.verbose = options.verbose
```

After `await ensurePaths()` add:
```typescript
mergeConfigWithDefaults()
```

**Step 3: Commit**

```bash
git add src/start.ts
git commit -m "feat: initialize app config and verbose state on startup"
```

---

### Task 11: Update server.ts — Register responses routes and auth middleware

**Files:**
- Modify: `src/server.ts`

**Step 1: Add imports**

Add these imports:
```typescript
import { createAuthMiddleware } from "./lib/request-auth"
import { responsesRoutes } from "./routes/responses/route"
```

**Step 2: Add auth middleware**

After `server.use(cors())` add:
```typescript
server.use("*", createAuthMiddleware())
```

**Step 3: Register responses routes**

After the existing legacy routes block, add:
```typescript
server.route("/responses", responsesRoutes)
```

In the v1 prefix block, add:
```typescript
server.route("/v1/responses", responsesRoutes)
```

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: register /v1/responses routes and auth middleware"
```

---

### Task 12: Replace messages handler — Add Responses API routing

**Files:**
- Replace: `src/routes/messages/handler.ts`

This is the biggest change. The source fork's handler has completely different routing logic (Messages API, Responses API, Chat Completions fallback) compared to the target's (Chat Completions only with Azure support).

**Step 1: Replace handler.ts with source fork's version**

Copy the source fork's `src/routes/messages/handler.ts` to overwrite the target's version.

**Step 2: Add back Azure OpenAI support to the chat completions path**

The source fork's `handleWithChatCompletions` doesn't have Azure support. Add it back by modifying the function to check `isAzureOpenAIModel()` before calling `createChatCompletions()`, similar to the original target handler.

In the `handleWithChatCompletions` function, add:
```typescript
import { createAzureOpenAIChatCompletions, isAzureOpenAIModel } from "~/services/azure-openai"
```

And modify the API call to check for Azure models:
```typescript
const isAzureModel = isAzureOpenAIModel(openAIPayload.model)
const response = isAzureModel && state.azureOpenAIConfig
  ? await createAzureOpenAIChatCompletions(state.azureOpenAIConfig, openAIPayload)
  : await createChatCompletions(openAIPayload, { initiator: initiatorOverride })
```

**Step 3: Add back auto-replace support**

In `handleWithChatCompletions`, re-add `applyReplacementsToPayload` and `normalizeModelName` calls from the original target handler:
```typescript
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { normalizeModelName } from "~/lib/model-resolver"
```

**Step 4: Verify the anthropic-types.ts in target has all needed types**

Read target's `src/routes/messages/anthropic-types.ts` and compare with source. If the source adds new types (e.g., `AnthropicTextBlock`, `AnthropicToolResultBlock`), add them.

**Step 5: Commit**

```bash
git add src/routes/messages/handler.ts src/routes/messages/anthropic-types.ts
git commit -m "feat: add Responses API and Messages API routing to Anthropic handler"
```

---

### Task 13: Update get-models.ts — Ensure Model type has supported_endpoints

**Files:**
- Check: `src/services/copilot/get-models.ts`

**Step 1: Check Model type definition**

The messages handler checks `selectedModel?.supported_endpoints?.includes(...)` and `selectedModel?.capabilities.supports.adaptive_thinking`. Verify the `Model` type in `get-models.ts` includes these fields. If not, add them:

```typescript
interface Model {
  // ... existing fields ...
  supported_endpoints?: Array<string>
  capabilities?: {
    supports?: {
      adaptive_thinking?: boolean
    }
  }
}
```

**Step 2: Commit if changed**

```bash
git add src/services/copilot/get-models.ts
git commit -m "feat: add supported_endpoints and capabilities to Model type"
```

---

### Task 14: Bump version to 0.8.0

**Files:**
- Modify: `package.json`

**Step 1: Update version**

Change `"version": "0.7.13"` to `"version": "0.8.0"`.

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.8.0"
```

---

### Task 15: Verify everything works

**Step 1: Type check**

Run: `bun run typecheck`
Expected: No errors

**Step 2: Fix any type errors**

Resolve any import path issues or missing type definitions.

**Step 3: Start dev server**

Run: `bun run dev start`
Expected: Server starts, lists models, no crashes.

**Step 4: Test responses endpoint**

```bash
curl -X POST http://localhost:4141/v1/responses -H "Content-Type: application/json" -d '{"model":"gpt-4o","input":"hello"}'
```
Expected: Either a valid response or an auth error (not 404).

**Step 5: Test existing endpoints still work**

```bash
curl http://localhost:4141/v1/models
```
Expected: Model list returned.

**Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve type errors from responses API port"
```

---

## Summary of All Files

### New files (copy from source):
1. `src/lib/config.ts`
2. `src/lib/logger.ts`
3. `src/lib/request-auth.ts`
4. `src/services/copilot/create-responses.ts`
5. `src/services/copilot/create-messages.ts`
6. `src/routes/responses/route.ts`
7. `src/routes/responses/handler.ts`
8. `src/routes/responses/stream-id-sync.ts`
9. `src/routes/responses/utils.ts`
10. `src/routes/messages/responses-translation.ts`
11. `src/routes/messages/responses-stream-translation.ts`
12. `src/routes/messages/subagent-marker.ts`

### Modified files:
1. `src/lib/api-config.ts` — version bumps
2. `src/lib/state.ts` — add verbose field
3. `src/lib/paths.ts` — add CONFIG_PATH (if missing)
4. `src/start.ts` — init config, set verbose
5. `src/server.ts` — register responses routes, auth middleware
6. `src/routes/messages/handler.ts` — replace with new routing logic + re-add Azure/replacements
7. `src/routes/messages/anthropic-types.ts` — add missing types if needed
8. `src/services/copilot/get-models.ts` — add supported_endpoints to Model type
9. `package.json` — bump to 0.8.0
