# Code Review Request: Sentry AI Agent Monitoring Integration

## Context

This project (`copilot-api`) is a Hono/Bun proxy server that translates GitHub Copilot's API into OpenAI and Anthropic-compatible formats. In this session, we added LLM observability by integrating Sentry's AI Agent Monitoring.

**Note:** An initial approach using a custom Breadcrumb tracing platform (SQLite + embedded React UI) was built first, then replaced with Sentry's native AI monitoring. The final net changes are what matter for review.

## Commits to Review

```
28b5641 refactor: remove Breadcrumb tracing integration
70680f4 feat: add Sentry AI Agent Monitoring spans for LLM observability
```

The earlier commits in this session (Breadcrumb integration) were fully reverted by `28b5641`. Only these two commits represent the final state.

## What Changed (Net Effect)

**Files modified:**
- `src/lib/sentry.ts` — Added `tracesSampleRate: 1.0` to enable tracing
- `src/routes/messages/handler.ts` — Wrapped LLM API calls with `Sentry.startSpan()` using `op: "gen_ai.request"`
- `src/routes/chat-completions/handler.ts` — Same Sentry span instrumentation
- `src/routes/responses/handler.ts` — Same Sentry span instrumentation
- `src/server.ts` — Removed Breadcrumb `/traces` routes (cleanup)
- `src/start.ts` — Removed Breadcrumb initialization code (cleanup)
- `package.json` / `bun.lock` — Removed `@breadcrumb/server`, `@trpc/server`, `superjson` deps

**Files deleted:**
- `src/lib/trace-recorder.ts` — Custom SQLite trace writer (replaced by Sentry)
- `src/lib/trace-db.ts` — SQLite database initialization (replaced by Sentry)
- `src/lib/traces-auth.ts` — Cookie-based auth for embedded trace UI (no longer needed)
- `src/lib/pricing-cache.ts` — PricePerToken API client (Sentry calculates costs natively)

## How It Works

Each proxied LLM request is wrapped with a Sentry span:

```typescript
await Sentry.startSpan(
  {
    op: "gen_ai.request",
    name: `request ${model}`,
    attributes: {
      "gen_ai.request.model": model,
      "gen_ai.request.messages": JSON.stringify(messages),
    },
  },
  async (span) => {
    const response = await createChatCompletions(payload)
    span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
    span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
    span.setAttribute("gen_ai.response.text", JSON.stringify([responseText]))
  },
)
```

This follows Sentry's [AI Agent Monitoring spec](https://docs.sentry.io/platforms/javascript/guides/node/ai-agent-monitoring/) with `gen_ai.*` attributes. Sentry automatically calculates costs from token counts and model names.

## Three Handlers Instrumented

### 1. `src/routes/messages/handler.ts` (Anthropic Messages API)
- **ChatCompletions path** (`executeChatCompletions`): Wraps `createChatCompletions()` with Sentry span. Handles both streaming and non-streaming. For streaming, tokens are captured from the final chunk's `usage` field after stream completes.
- **Responses API path** (`handleWithResponsesApi`): Wraps `createResponses()` with Sentry span. Streaming captures tokens from `response.completed` events.

### 2. `src/routes/chat-completions/handler.ts` (OpenAI Chat Completions API)
- Wraps `createChatCompletions()` in `executeRequest()`. Extracted into `handleNonStreamingResponse()` and `handleStreamingResponse()` for clarity.

### 3. `src/routes/responses/handler.ts` (Copilot Responses API)
- Wraps `createResponses()` with Sentry span. Handles native Responses streaming with web search buffering.
- Also instruments the ChatCompletions fallback path (`handleWithChatCompletions`).

## Review Focus Areas

1. **Sentry span placement** — Are the `Sentry.startSpan()` calls placed correctly around the LLM API calls? Do they capture the full request lifecycle including streaming?

2. **Streaming token capture** — For streaming responses, tokens are set on the span after the stream completes (inside the `streamSSE` callback). Is this reliable? Could the span close before tokens are set?

3. **Attribute correctness** — Are `gen_ai.request.messages`, `gen_ai.response.text`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` set correctly per [Sentry's spec](https://docs.sentry.io/platforms/javascript/guides/node/ai-agent-monitoring/#ai-request-span)?

4. **Error handling** — If the LLM call fails, does the span correctly capture the error? Sentry auto-captures exceptions within `startSpan`, but verify this works with the existing `HTTPError` retry patterns.

5. **Performance impact** — `tracesSampleRate: 1.0` means every request is traced. Should this be configurable via environment variable (e.g., `SENTRY_TRACES_SAMPLE_RATE`)?

6. **Cleanup completeness** — Are there any leftover references to the removed Breadcrumb system (`trace-recorder`, `trace-db`, `traces-auth`, `pricing-cache`, `@breadcrumb/server`, `@trpc/server`, `superjson`)?

7. **Privacy** — Full user prompts are stored as `gen_ai.request.messages`. Should `recordInputs`/`recordOutputs` be configurable? Is `beforeSend` scrubbing sufficient?

8. **Streaming span lifecycle** — The `Sentry.startSpan()` wraps the `streamSSE()` call. The SSE stream keeps the HTTP response open. Does the span stay open for the entire stream duration, or does it close when `startSpan`'s callback returns (before streaming finishes)?

## How to View the Diff

```bash
# See the two relevant commits
git show 28b5641   # Breadcrumb removal
git show 70680f4   # Sentry AI spans addition

# Net diff of handler changes only
git diff 9789f22~1..HEAD -- src/routes/ src/lib/sentry.ts

# Check for leftover Breadcrumb references
git grep -i "breadcrumb\|trace-recorder\|trace-db\|traces-auth\|pricing-cache\|@trpc"
```

## Related Docs

- [Sentry AI Agent Monitoring](https://docs.sentry.io/platforms/javascript/guides/node/ai-agent-monitoring/)
- [Sentry AI Request Span Attributes](https://docs.sentry.io/platforms/javascript/guides/node/ai-agent-monitoring/#ai-request-span)
- [Sentry Token Usage & Cost Calculation](https://docs.sentry.io/platforms/javascript/guides/node/ai-agent-monitoring/#token-usage-and-cost-gotchas)
