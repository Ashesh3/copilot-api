# Breadcrumb LLM Tracing Integration

## Overview

Integrate the Breadcrumb LLM tracing platform into copilot-api to provide rich trace visualization for all proxied requests. Fork Breadcrumb, replace its PostgreSQL + ClickHouse storage with SQLite, strip it to core trace viewing features, and embed the UI and API directly into copilot-api as a single-process deployment.

## Goals

- Full-depth tracing of every proxied LLM request with sub-spans and message payloads
- Rich trace viewer UI (span tree, input/output inspection, token counts) served from copilot-api
- Zero external dependencies — SQLite only, no PostgreSQL or ClickHouse
- Always-on tracing with no performance impact on proxy functionality
- Auth gated by existing `COPILOT_API_KEY_AUTH`

## Non-Goals

- Breadcrumb's Explore (AI analytics/SQL generation)
- Observations/findings system
- MCP endpoint
- AI trace summaries
- Multi-user / multi-project / organizations
- Cost tracking (Copilot API doesn't expose cost data)
- Automatic data retention/cleanup (future enhancement)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     copilot-api (Bun + Hono)                │
│                                                             │
│  Existing routes:          New routes:                      │
│  ├─ /v1/messages           ├─ /traces          (React SPA) │
│  ├─ /v1/chat/completions   ├─ /traces/api/trpc (tRPC API)  │
│  ├─ /v1/models             └─ /traces/assets/* (static)    │
│  ├─ /usage                                                  │
│  └─ ...                                                     │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ Trace        │───>│ SQLite       │<───│ tRPC Router   │  │
│  │ Recorder     │    │ traces.db    │    │ (from fork)   │  │
│  │ (middleware)  │    └──────────────┘    └───────────────┘  │
│  └──────────────┘                              ▲            │
│       ▲                                        │            │
│       │ instruments                      React SPA          │
│  ┌────┴────────────────────────┐        (pre-built static)  │
│  │ Request handlers            │                            │
│  │ (messages, chat-completions)│                            │
│  └─────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

- **TraceRecorder**: In-process module that writes traces/spans directly to SQLite. No SDK, no HTTP hop.
- **tRPC Router**: Forked from Breadcrumb, adapted to query SQLite instead of ClickHouse. Mounted at `/traces/api/trpc`.
- **React SPA**: Forked from Breadcrumb, stripped to core trace views. Pre-built as static assets, served at `/traces`.
- **SQLite**: Single file at `~/.local/share/copilot-api/traces.db`. WAL mode for concurrent read/write.

---

## Breadcrumb Fork Changes

### Stripped (removed entirely)

- Better Auth (login/signup/sessions/OAuth)
- Organizations, projects, members, invitations
- Explore (AI analytics with SQL generation)
- Observations/findings system
- MCP endpoint
- pgBoss (background job queue)
- AI trace summary/analyze
- ClickHouse + PostgreSQL drivers and migrations
- API key management (Breadcrumb's own key system)
- Docker/Railway deployment configs
- Docs app (Next.js marketing site)
- SDK packages (not needed — copilot-api writes directly to SQLite)

### Kept and modified

| Component | Current | Modified to |
|-----------|---------|-------------|
| Web app routes | `/projects/$projectId/traces` | `/traces` (strip project scoping) |
| Web app routes | `/projects/$projectId/trace/$traceId` | `/traces/$traceId` |
| tRPC procedures | `traces.list` | Same API, SQLite queries, no `projectId` param |
| tRPC procedures | `traces.get` | Same API, SQLite queries |
| tRPC procedures | `traces.spans` | Same API, SQLite queries |
| tRPC procedures | `traces.environments` | Same API, SQLite queries |
| tRPC procedures | `traces.models` | Same API, SQLite queries |
| tRPC procedures | `traces.names` | Same API, SQLite queries |
| Span tree utils | `buildTree()`, `collapseTree()` | Unchanged |
| Trace list UI | Filters, table, pagination | Keep, remove Observations/Explore tabs |
| Trace detail UI | Span tree, detail panel, I/O | Keep, remove AI summary panel |

### Web app modifications

- Remove `_authed` layout gate (auth handled at Hono middleware level in copilot-api)
- Remove project selector / project list page
- Remove signup/login pages
- Root route goes directly to trace list
- Strip `projectId` param from all tRPC calls (single-tenant)
- Remove auto-refetch of summary, observations unread count
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
- No materialized views — rollup stats computed at query time via JOIN aggregations
- No monthly partitioning (unnecessary at this scale)

### Trace completion pattern

When a trace starts, a row is inserted with `end_time = NULL`. When it completes, the row is updated with `end_time`, `status`, `output`. This replaces Breadcrumb's versioned-insert deduplication.

---

## Tracing Instrumentation

### TraceRecorder module

```typescript
// src/lib/trace-recorder.ts
class TraceRecorder {
  private db: Database; // Bun's built-in SQLite

  startTrace(id, name, input): void   // INSERT trace row
  endTrace(id, status, output): void  // UPDATE trace row
  recordSpan(span: SpanData): void    // INSERT span row
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
│   input_tokens, output_tokens
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

### Streaming responses

For streaming requests, the `copilot-api-call` span output is assembled from SSE chunks in memory. The span is recorded after the stream completes. This matches how the existing request logger already collects streaming data.

### Error handling

All TraceRecorder operations are wrapped in try/catch. If SQLite writes fail, errors are logged but the proxy request is never blocked. Tracing is best-effort.

### Cost tracking

Skipped — `input_cost_usd` and `output_cost_usd` remain 0. Copilot's API does not expose pricing data. Token counts come from the existing `gpt-tokenizer` usage already in the handlers.

---

## UI Integration & Routing

### Route mounting in copilot-api's server.ts

```
Existing routes (unchanged):
├─ /v1/messages
├─ /v1/chat/completions
├─ /v1/models
├─ /usage
└─ ...

New routes (all behind apiKeyGuard):
├─ /traces/api/trpc/*    → Breadcrumb's tRPC router (SQLite-backed)
├─ /traces/assets/*      → Static assets (JS, CSS, fonts)
├─ /traces               → Serve index.html (SPA entry)
├─ /traces/*             → Serve index.html (SPA client-side routing fallback)
```

### tRPC router adaptation

The forked Breadcrumb tRPC router is exported as a factory that accepts a SQLite database instance:

```typescript
// In Breadcrumb fork
export function createTracesRouter(db: Database) {
  return t.router({
    list: /* SQLite query */,
    get: /* SQLite query */,
    spans: /* SQLite query */,
    environments: /* SQLite query */,
    models: /* SQLite query */,
    names: /* SQLite query */,
  });
}
```

copilot-api imports this, creates the router with its SQLite instance, and mounts it via Hono's tRPC adapter at `/traces/api/trpc`.

### Packaging

The Breadcrumb fork is published as a private npm package with two exports:
- `@your-fork/breadcrumb/router` — the tRPC router factory
- `@your-fork/breadcrumb/static` — path to pre-built static assets directory

### Auth for the UI

The `/traces` and `/traces/*` routes are behind the same `apiKeyGuard` middleware used by the API. The React SPA passes the API key via a query parameter, cookie, or header (matching however apiKeyGuard currently works).

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
   │   (streaming: span recorded after stream completes)
   ├─ recordSpan("transform-response") → INSERT INTO spans
   └─ recordSpan("token-counting")     → INSERT INTO spans
5. TraceRecorder.endTrace()
   → UPDATE traces SET end_time, status, output WHERE id = ?
6. Response sent to client (unchanged)
```

### Viewing traces (read path)

```
1. User opens http://localhost:4141/traces
2. apiKeyGuard validates
3. Hono serves index.html (React SPA)
4. React app calls /traces/api/trpc/traces.list
   → SQLite: SELECT traces + JOIN spans for token/cost rollups
   → Returns paginated trace list
5. User clicks a trace → /traces/{traceId}
6. React app calls traces.get + traces.spans
   → SQLite: SELECT from traces, SELECT from spans WHERE trace_id = ?
7. UI renders span tree with input/output inspection panels
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
| Auth | Existing `COPILOT_API_KEY_AUTH` |
| Feature scope | Core only — trace list, detail, span tree, filters |
| Tracing | Always on, stored in `traces.db` |
| Packaging | Breadcrumb fork as npm package with router + static exports |
| Cost tracking | Skipped (Copilot doesn't expose cost) |
| Data retention | Unbounded initially |
| DB location | `~/.local/share/copilot-api/traces.db` |
