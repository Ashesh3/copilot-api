# Design: Port Responses API to @ashsec/copilot-api

**Date**: 2026-02-19
**Version**: 0.7.13 -> 0.8.0
**Source**: caozhiyuan/copilot-api feature/responses-api branch

## Context

The OpenAI Responses API (`/v1/responses`) is a newer API format used by tools like Codex CLI instead of `/v1/chat/completions`. Our fork lacks this endpoint. We port it from caozhiyuan's fork while preserving our unique features (Azure OpenAI, auto-replace rules).

## Approach: Additive Port

Copy new files directly from source fork, make minimal edits to existing files to wire them in. No restructuring of existing code.

## New Files

| File | Purpose |
|------|---------|
| `src/routes/responses/route.ts` | POST /v1/responses endpoint |
| `src/routes/responses/handler.ts` | Request processing, tool transforms, streaming |
| `src/routes/responses/stream-id-sync.ts` | Fix ID consistency for @ai-sdk/openai |
| `src/routes/responses/utils.ts` | Vision/initiator detection |
| `src/services/copilot/create-responses.ts` | Copilot Responses API client + full type defs |
| `src/services/copilot/create-messages.ts` | Copilot native Messages API client |
| `src/routes/messages/responses-translation.ts` | Anthropic -> Responses format translation |
| `src/routes/messages/responses-stream-translation.ts` | Stream event translation |
| `src/routes/messages/subagent-marker.ts` | Claude Code agent detection |
| `src/lib/config.ts` | App config (extra prompts, reasoning effort, useFunctionApplyPatch) |
| `src/lib/request-auth.ts` | API key authentication middleware |
| `src/lib/logger.ts` | Logging utility |

## Existing Files Modified

| File | Change |
|------|--------|
| `src/server.ts` | Register `/responses` and `/v1/responses` routes, add auth middleware |
| `src/lib/api-config.ts` | Update Copilot version to 0.37.6, API version to 2025-10-01 |
| `src/lib/state.ts` | Add `verbose` field |
| `src/routes/messages/handler.ts` | Add Responses API routing path alongside existing chat-completions |
| `src/start.ts` | Initialize app config on startup |
| `package.json` | Bump version to 0.8.0 |

## Untouched

- Azure OpenAI integration
- Auto-replace rules (routes, lib, CLI command)
- Embeddings, models, usage, token routes
- Existing tests

## Verification

1. `bun run typecheck` passes
2. `bun run dev start` starts server, lists models
3. `/v1/responses` endpoint responds (not 404)
4. Existing `/v1/chat/completions` still works
5. Existing `/v1/messages` still works (with new Responses routing)
