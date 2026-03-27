# Breadcrumb LLM Tracing Integration

## Overview

Integrate the Breadcrumb LLM tracing platform into copilot-api to provide rich trace visualization for all proxied requests. Fork Breadcrumb, replace its PostgreSQL + ClickHouse storage with SQLite, strip it to core trace viewing features, and embed the UI and API directly into copilot-api as a single-process deployment.

## Goals

- Full-depth tracing of every proxied LLM request with sub-spans and message payloads
- Rich trace viewer UI (span tree, input/output inspection, token counts, costs) served from copilot-api
- Zero external database dependencies — SQLite only, no PostgreSQL or ClickHouse
- Always-on tracing with no performance impact on proxy functionality
- Auth gated by existing `COPILOT_API_KEY_AUTH`
- Per-request cost estimation using PricePerToken API for model pricing data

## Non-Goals

- Breadcrumb's Explore (AI analytics/SQL generation)
- Observations/findings system
- MCP endpoint
- AI trace summaries (auto-analyze)
- Multi-user / multi-project / organizations

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     copilot-api (Bun + Hono)                    │
│                                                                 │
│  Existing routes:          New routes:                          │
│  ├─ /v1/messages           ├─ /traces          (React SPA)     │
│  ├─ /v1/chat/completions   ├─ /traces/api/trpc (tRPC API)     │
│  ├─ /v1/models             └─ /traces/assets/* (static)       │
│  ├─ /usage                                                     │
│  └─ ...                                                        │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────┐     │
│  │ Trace        │───>│ SQLite       │<───│ tRPC Router   │     │
│  │ Recorder     │    │ traces.db    │    │ (from fork)   │     │
│  │ (middleware)  │    └──────────────┘    └───────────────┘     │
│  └──────────────┘                              ▲               │
│       ▲                                        │               │
│       │ instruments                      React SPA             │
│  ┌────┴────────────────────────┐        (pre-built static)     │
│  │ Request handlers            │                               │
│  │ (messages, chat-completions)│                               │
│  └─────────────────────────────┘                               │
│                                                                 │
│  ┌──────────────────┐                                          │
│  │ PricePerToken    │  Fetches model pricing on startup +      │
│  │ pricing cache    │  periodic refresh. Used by TraceRecorder  │
│  └──────────────────┘  to calculate input/output cost per span │
└─────────────────────────────────────────────────────────────────┘
```

- **TraceRecorder**: In-process module that writes traces/spans directly to SQLite. No SDK, no HTTP hop.
- **tRPC Router**: Forked from Breadcrumb, adapted to query SQLite instead of ClickHouse. Mounted at `/traces/api/trpc`.
- **React SPA**: Forked from Breadcrumb, stripped to core trace views. Pre-built as static assets, served at `/traces`.
- **SQLite**: Single file at `~/.local/share/copilot-api/traces.db`. WAL mode for concurrent read/write.
- **PricePerToken Cache**: Fetches model pricing from `api.pricepertoken.com` on startup and refreshes periodically (every 6 hours). Provides per-token input/output costs for cost calculation.

---

## Cost Tracking via PricePerToken

Copilot's API does not expose pricing data, but copilot-api knows the model name and token counts for every request. The PricePerToken API provides per-token pricing for all major models.

### Pricing flow

1. **On startup**: Fetch all model pricing via `GET https://api.pricepertoken.com/mcp/mcp` (or the equivalent REST endpoint from the MCP tools — `get_all_models`). Cache in memory.
2. **Periodic refresh**: Re-fetch every 6 hours to pick up price changes.
3. **Per request**: After token counting, look up the model in the pricing cache. Calculate:
   - `input_cost_usd = input_tokens * model.input_price_per_token`
   - `output_cost_usd = output_tokens * model.output_price_per_token`
4. **Fallback**: If model not found in pricing cache, leave costs as 0.

### Model name mapping

copilot-api normalizes model names (e.g., `claude-opus-4-6-1m` → `claude-opus-4.6`). The pricing cache needs a mapping layer to match copilot-api's model names to PricePerToken's model identifiers. This is a simple lookup table maintained in code, supplemented by fuzzy matching on model name.

---

## Breadcrumb Fork Changes

### Stripped (removed entirely)

- Better Auth (login/signup/sessions/OAuth)
- Organizations, projects, members, invitations
- Explore (AI analytics with SQL generation)
- Observations/findings system — including `observationsRouter`, `ObservationsSection` component, and `observations.unreadCount` query in `traces.tsx`
- MCP endpoint
- pgBoss (background job queue)
- AI trace summary/analyze — including `TraceSummary` component, `traces.summary` procedure, `traces.analyze` mutation, Analyze button, and auto-analyze effect in `trace.$traceId.tsx`
- ClickHouse + PostgreSQL drivers and migrations
- API key management (Breadcrumb's own key system)
- Docker/Railway deployment configs
- Docs app (Next.js marketing site)
- SDK packages (not needed — copilot-api writes directly to SQLite)
- `insightsRouter` (spanSample, loopbackRate, topFailingSpans, topSlowestSpans, modelBreakdown)

### Kept and modified

| Component | Current | Modified to |
|-----------|---------|-------------|
| Web app routes | `/projects/$projectId/traces` (plural) | `/traces` (strip project scoping) |
| Web app routes | `/projects/$projectId/trace/$traceId` (singular) | `/traces/$traceId` (unified under `/traces` prefix) |
| tRPC procedures | `traces.list` | SQLite queries, no `projectId` param, AI search replaced with SQLite `LIKE` |
| tRPC procedures | `traces.get` | SQLite queries |
| tRPC procedures | `traces.spans` | SQLite queries |
| tRPC procedures | `traces.environments` | SQLite queries |
| tRPC procedures | `traces.models` | SQLite queries |
| tRPC procedures | `traces.names` | SQLite queries |
| tRPC procedures | `traces.dailyCount` | SQLite queries |
| tRPC procedures | `traces.stats` | SQLite queries (used by Overview section) |
| tRPC procedures | `traces.dailyMetrics` | SQLite queries |
| Span tree utils | `buildTree()`, `collapseTree()` | Unchanged |
| Trace list UI | Filters, table, pagination, Overview tab | Keep Overview + Raw tabs, remove Observations tab |
| Trace detail UI | Span tree, detail panel, I/O | Keep, remove AI summary panel |

### tRPC procedure base migration

All Breadcrumb tRPC procedures currently use `orgViewerProcedure` / `orgMemberProcedure` as their base, which requires a `TRPCContext` with `user` (from Better Auth sessions) and performs organization membership checks via PostgreSQL. These must ALL be rebased to a plain unauthenticated `publicProcedure` (or new `baseProcedure` that skips auth), since copilot-api handles authentication at the Hono middleware layer before requests reach tRPC.

### tRPC transformer

Both the Breadcrumb server and client use `superjson` as the tRPC transformer for serializing complex types (Dates, Maps, etc.). This must be retained in the fork. copilot-api will need `superjson` as a dependency.

### AI search replacement

The `traces.list` procedure's `query` parameter currently triggers AI-powered search (calls Claude to generate ClickHouse WHERE clauses). This must be replaced with simple SQLite text search:

```sql
-- When query parameter is provided
WHERE t.id IN (
  SELECT DISTINCT trace_id FROM spans
  WHERE input LIKE '%' || :query || '%'
     OR output LIKE '%' || :query || '%'
     OR name LIKE '%' || :query || '%'
)
OR t.name LIKE '%' || :query || '%'
```

### Rollups replacement

Breadcrumb's `ROLLUPS_SUBQUERY` references a ClickHouse materialized view (`trace_rollups`) for pre-computed span aggregates. Replace with an inline SQLite subquery:

```sql
-- Replacement for ROLLUPS_SUBQUERY
SELECT
  trace_id,
  COUNT(*) AS span_count,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(input_cost_usd) AS input_cost_usd,
  SUM(output_cost_usd) AS output_cost_usd,
  MAX(end_time) AS max_end_time
FROM spans
GROUP BY trace_id
```

This subquery is used as a LEFT JOIN in `traces.list` and `traces.stats` queries.

### Web app modifications

- Remove `_authed` layout gate (auth handled at Hono middleware level in copilot-api)
- Remove project selector / project list page
- Remove signup/login pages
- Root route goes directly to trace list
- Strip `projectId` param from all tRPC calls (single-tenant)
- Remove `observations.unreadCount` query from `traces.tsx`
- Remove Observations tab from `SIDEBAR_ITEMS` array in `traces.tsx`
- Remove `ObservationsSection` import and render
- Remove `TraceSummary` component, `analyzeMut` mutation, Analyze button, and auto-analyze effect from `trace.$traceId.tsx`
- Remove `trpc.projects.get.useQuery()` call from `trace.$traceId.tsx`
- Replace `useAuth()` hook with a stub that always returns `{ isViewer: false, role: "admin" }` (since auth is handled at the middleware level, all users who reach the UI are authorized)
- Vite `base` config set to `/traces/` for correct asset paths
- tRPC client endpoint changed from `/trpc` to `/traces/api/trpc`
- TanStack Router `basePath` set to `/traces`

---

## SQLite Schema

```sql
CREATE TABLE traces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  status_message TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  input TEXT,
  output TEXT,
  environment TEXT,
  user_id TEXT,
  session_id TEXT,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  status_message TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  input_cost_usd REAL DEFAULT 0,
  output_cost_usd REAL DEFAULT 0,
  input TEXT,
  output TEXT,
  metadata TEXT,
  FOREIGN KEY (trace_id) REFERENCES traces(id)
);

CREATE INDEX idx_spans_trace_id ON spans(trace_id);
CREATE INDEX idx_traces_start_time ON traces(start_time DESC);
CREATE INDEX idx_traces_status ON traces(status);
CREATE INDEX idx_traces_environment ON traces(environment);
CREATE INDEX idx_spans_model ON spans(model);
```

### Key differences from Breadcrumb's ClickHouse schema

- No `project_id` column (single-tenant)
- No `version` column or `argMax` pattern — SQLite uses UPDATE for trace completion
- Costs stored as REAL USD directly (not micro-dollars UInt64)
- No materialized views — rollup stats computed at query time via inline subquery joins
- No monthly partitioning (unnecessary at this scale)

### Trace completion pattern

When a trace starts, a row is inserted with `end_time = NULL`. When it completes, the row is updated with `end_time`, `status`, `output`. This replaces Breadcrumb's versioned-insert deduplication.

### Data retention

Storing full message payloads (100KB+ per request for long conversations) means unbounded database growth. To manage this:

- A `--trace-retention-days N` CLI flag (default: 30) configures automatic cleanup
- On startup and every hour, a cleanup job runs: `DELETE FROM spans WHERE trace_id IN (SELECT id FROM traces WHERE created_at < datetime('now', '-N days')); DELETE FROM traces WHERE created_at < datetime('now', '-N days');`
- A `--trace-retention-days 0` disables cleanup (unbounded growth)

---

## Tracing Instrumentation

### TraceRecorder module

```typescript
// src/lib/trace-recorder.ts
class TraceRecorder {
  private db: Database; // Bun's built-in SQLite
  private pricingCache: Map<string, ModelPricing>;

  startTrace(id, name, input): void   // INSERT trace row
  endTrace(id, status, output): void  // UPDATE trace row
  recordSpan(span: SpanData): void    // INSERT span row (costs calculated via pricingCache)
}
```

### What gets traced per request

```
Trace: "POST /v1/messages" (or /v1/chat/completions, /responses)
├─ Span: "parse-request" [type: step]
│   input: raw request body
│   output: parsed model, token count estimate
├─ Span: "select-token" [type: step]
│   output: { accountId, accountType }
├─ Span: "copilot-api-call" [type: llm]
│   input: messages array sent to Copilot
│   output: response body / streamed chunks assembled
│   model: "claude-sonnet-4-20250514" (normalized)
│   provider: "anthropic" / "openai" (derived from model)
│   input_tokens, output_tokens, input_cost_usd, output_cost_usd
├─ Span: "transform-response" [type: step]
│   input: raw Copilot response format
│   output: translated Anthropic/OpenAI format
└─ Span: "token-counting" [type: step]
    output: { inputTokens, outputTokens }
```

### Trace metadata

- `environment`: from `NODE_ENV`
- `user_id`: account ID used for the request
- `name`: `"POST /v1/messages"` (method + path)
- `input`: full user message payload (request body)
- `output`: full response payload

### Token count sources

- **Input tokens**: Estimated by `gpt-tokenizer` before sending the request (already computed in handlers)
- **Output tokens**: Extracted from the upstream API response's `usage.completion_tokens` field (or counted from streamed chunks)

Both values are available at the end of request processing and are recorded on the `copilot-api-call` span.

### Cost calculation

After token counts are determined, the TraceRecorder looks up the model in the PricePerToken pricing cache:

```typescript
const pricing = this.pricingCache.get(normalizedModelName);
if (pricing) {
  span.input_cost_usd = inputTokens * pricing.inputPricePerToken;
  span.output_cost_usd = outputTokens * pricing.outputPricePerToken;
}
```

### Streaming responses

For streaming requests, the handler currently processes SSE chunks individually without assembling them. The TraceRecorder adds a chunk collector that tees the stream: chunks flow to the client unchanged while also being accumulated in a buffer. After the stream completes, the assembled output is recorded on the `copilot-api-call` span. This adds memory overhead proportional to response size.

The collector hooks into the existing streaming pipeline (e.g., wrapping the `streamSSE` callback or adding a transform to the response stream).

### Error handling

All TraceRecorder operations are wrapped in try/catch. If SQLite writes fail, errors are logged but the proxy request is never blocked. Tracing is best-effort.

---

## UI Integration & Routing

### Browser authentication

copilot-api's existing `apiKeyGuard` silently drops unauthorized requests (returns a promise that never resolves), which works for API clients but would cause browsers to hang indefinitely. The `/traces` routes need a different auth approach:

1. **First visit**: User navigates to `/traces?key=<api-key>` with the API key as a query parameter
2. **Cookie set**: A middleware extracts the key from the query param, validates it, and sets an `HttpOnly` cookie (`traces_session=<api-key>`)
3. **Subsequent requests**: The middleware reads the cookie. The React SPA's tRPC client also sends the cookie automatically (same-origin).
4. **Invalid/missing auth**: Returns HTTP 401 with a simple HTML page prompting the user to provide their API key

This is implemented as a new `/traces`-specific auth middleware, separate from `apiKeyGuard`. The `/traces` routes are mounted **before** `createAuthMiddleware()` in `server.ts` so they are not subject to the Copilot request auth middleware (which validates Copilot JWT tokens, not API keys).

### Route mounting in copilot-api's server.ts

```typescript
// Mount BEFORE apiKeyGuard and createAuthMiddleware
// (traces routes have their own auth middleware)
server.route("/traces/api/trpc", trpcHandler);
server.use("/traces/*", tracesAuthMiddleware);  // cookie/query-param auth
server.get("/traces/assets/*", serveStatic({ root: breadcrumbStaticPath }));
server.get("/traces/*", serveSPA);  // SPA fallback → index.html
server.get("/traces", serveSPA);

// Existing routes (unchanged)
server.use("*", apiKeyGuard);
server.use("*", createAuthMiddleware());
// ... existing API routes
```

### tRPC router adaptation

The forked Breadcrumb tRPC router is exported as a factory that accepts a SQLite database instance:

```typescript
// In Breadcrumb fork
import superjson from "superjson";

const t = initTRPC.create({ transformer: superjson });

export function createTracesRouter(db: Database) {
  return t.router({
    traces: t.router({
      list: /* SQLite query */,
      get: /* SQLite query */,
      spans: /* SQLite query */,
      stats: /* SQLite query */,
      dailyMetrics: /* SQLite query */,
      environments: /* SQLite query */,
      models: /* SQLite query */,
      names: /* SQLite query */,
      dailyCount: /* SQLite query */,
    }),
  });
}
```

copilot-api imports this, creates the router with its SQLite instance, and mounts it via Hono's tRPC adapter at `/traces/api/trpc`.

### Packaging

The Breadcrumb fork is published as a private npm package with two exports:
- `@your-fork/breadcrumb/router` — the tRPC router factory
- `@your-fork/breadcrumb/static` — path to pre-built static assets directory

Dependencies: `superjson`, `@trpc/server`, `zod`.

---

## Data Flow

### Recording a trace (write path)

```
1. Client sends POST /v1/messages
2. apiKeyGuard validates (existing)
3. TraceRecorder.startTrace()
   → INSERT INTO traces (id, name, input, start_time, ...)
4. Handler processes request:
   ├─ recordSpan("parse-request")      → INSERT INTO spans
   ├─ recordSpan("select-token")       → INSERT INTO spans
   ├─ recordSpan("copilot-api-call")   → INSERT INTO spans
   │   (streaming: chunks collected via tee, span recorded after stream ends)
   │   (costs calculated from pricingCache + token counts)
   ├─ recordSpan("transform-response") → INSERT INTO spans
   └─ recordSpan("token-counting")     → INSERT INTO spans
5. TraceRecorder.endTrace()
   → UPDATE traces SET end_time, status, output WHERE id = ?
6. Response sent to client (unchanged)
```

### Viewing traces (read path)

```
1. User opens http://localhost:4141/traces?key=<api-key>
2. tracesAuthMiddleware validates key, sets cookie, redirects to /traces
3. Hono serves index.html (React SPA)
4. React app calls /traces/api/trpc/traces.list (cookie sent automatically)
   → SQLite: SELECT traces LEFT JOIN (rollups subquery) ...
   → Returns paginated trace list with token/cost aggregates
5. User clicks a trace → /traces/{traceId}
6. React app calls traces.get + traces.spans
   → SQLite: SELECT from traces, SELECT from spans WHERE trace_id = ?
7. UI renders span tree with input/output inspection panels and cost data
```

### Concurrency

- Bun's SQLite is synchronous and single-writer — fine for this workload (~5 spans per request)
- WAL mode enabled for concurrent reads (UI queries) while writes happen
- No batching needed (unlike ClickHouse) — individual INSERTs are fast in SQLite

---

## Summary of Decisions

| Decision | Choice |
|----------|--------|
| Deployment | Breadcrumb fork with SQLite, embedded in copilot-api |
| Trace depth | Full — sub-spans + message payloads |
| UI hosting | Same process/port at `/traces` |
| Auth (API) | Existing `COPILOT_API_KEY_AUTH` |
| Auth (UI) | Query-param key → HttpOnly cookie |
| Feature scope | Core — trace list, detail, span tree, filters, overview stats |
| Tracing | Always on, stored in `traces.db` |
| Packaging | Breadcrumb fork as npm package with router + static exports |
| Cost tracking | PricePerToken API for model pricing, calculated per-request |
| Data retention | 30-day default, configurable via `--trace-retention-days` |
| DB location | `~/.local/share/copilot-api/traces.db` |
| tRPC transformer | `superjson` (retained from Breadcrumb) |
| Search | Simple SQLite `LIKE` text search (replaces AI-powered search) |
