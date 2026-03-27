# Breadcrumb LLM Tracing Integration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed Breadcrumb's trace viewer UI into copilot-api with SQLite storage, full request tracing, and PricePerToken cost estimation.

**Architecture:** Fork Breadcrumb, strip to core trace list + detail views, replace ClickHouse/PostgreSQL with SQLite, export as npm package. In copilot-api, add a TraceRecorder that writes every proxied LLM request to SQLite, mount Breadcrumb's tRPC router and pre-built React SPA at `/traces`.

**Tech Stack:** Hono, tRPC, superjson, SQLite (Bun built-in), React 19, TanStack Router, Vite, PricePerToken API.

**Spec:** `docs/superpowers/specs/2026-03-27-breadcrumb-tracing-design.md`

**Two repos involved:**
- Breadcrumb fork: `F:\Temp\breadcrumb` (will become an npm package)
- copilot-api: `F:\Projects\copilot-api` (the consumer)

**Sequential dependency:** Chunks 1-2 (Breadcrumb fork) must be completed before Chunks 3-6 (copilot-api), because copilot-api imports tRPC types from the fork.

---

## Chunk 1: Breadcrumb Fork — Strip & SQLite Server

This chunk modifies the Breadcrumb fork to remove unnecessary features and replace the database layer with SQLite.

### Task 1: Strip unnecessary packages and services from monorepo

**Files:**
- Modify: `F:\Temp\breadcrumb\turbo.json`
- Delete: `F:\Temp\breadcrumb\apps\docs\` (entire directory)
- Delete: `F:\Temp\breadcrumb\packages\ai-sdk\` (entire directory)
- Delete: `F:\Temp\breadcrumb\packages\sdk-typescript\` (entire directory)
- Delete: `F:\Temp\breadcrumb\packages\skills\` (entire directory)
- Delete: `F:\Temp\breadcrumb\examples\` (entire directory)
- Modify: `F:\Temp\breadcrumb\package.json` (root)

- [ ] **Step 1: Delete SDK packages, docs app, and examples**

```bash
cd F:\Temp\breadcrumb
rm -rf apps/docs packages/ai-sdk packages/sdk-typescript packages/skills examples
```

- [ ] **Step 2: Update root package.json workspaces**

Remove deleted workspace entries. Keep only `services/server` and `apps/web`.

- [ ] **Step 3: Update turbo.json**

Remove build/lint/test tasks referencing deleted packages.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: strip SDK, docs, and examples packages"
```

---

### Task 2: Replace server database layer with SQLite

**Files:**
- Create: `F:\Temp\breadcrumb\services\server\src\db\sqlite.ts`
- Create: `F:\Temp\breadcrumb\services\server\src\db\schema.ts`
- Delete: `F:\Temp\breadcrumb\services\server\src\shared\db\` (Drizzle Postgres schema)
- Delete: `F:\Temp\breadcrumb\services\server\drizzle\` (Postgres migrations)
- Delete: `F:\Temp\breadcrumb\infra\` (ClickHouse migrations, docker configs)
- Modify: `F:\Temp\breadcrumb\services\server\package.json`

- [ ] **Step 1: Create SQLite schema module**

Create `services/server/src/db/schema.ts`:

```typescript
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS traces (
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

CREATE TABLE IF NOT EXISTS spans (
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

CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_start_time ON traces(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
CREATE INDEX IF NOT EXISTS idx_traces_environment ON traces(environment);
CREATE INDEX IF NOT EXISTS idx_spans_model ON spans(model);
`;
```

- [ ] **Step 2: Create SQLite connection module**

Create `services/server/src/db/sqlite.ts`:

```typescript
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema";

export function createDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA_SQL);
  return db;
}

export type { Database } from "bun:sqlite";
```

- [ ] **Step 3: Remove old database infrastructure and unused server files**

```bash
rm -rf services/server/src/shared
rm -rf services/server/drizzle
rm -rf infra
rm -f services/server/src/cron.ts
rm -f services/server/src/env.ts
```

- [ ] **Step 4: Update server package.json**

Remove dependencies: `@clickhouse/client`, `postgres`, `drizzle-orm`, `drizzle-kit`, `pg-boss`, `better-auth`, `jose`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `ai`, `@polyglot-sql/sdk`.

Keep: `hono`, `@hono/node-server`, `@trpc/server`, `zod`, `superjson`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: replace PostgreSQL + ClickHouse with SQLite"
```

---

### Task 3: Rewrite tRPC router for SQLite

**Files:**
- Rewrite: `F:\Temp\breadcrumb\services\server\src\trpc.ts` (NOTE: this file is at the src root, not inside api/trpc/)
- Rewrite: `F:\Temp\breadcrumb\services\server\src\api\trpc\router.ts`
- Rewrite: `F:\Temp\breadcrumb\services\server\src\api\trpc\traces\router.ts`
- Rewrite: `F:\Temp\breadcrumb\services\server\src\api\trpc\traces\list.ts`
- Rewrite: `F:\Temp\breadcrumb\services\server\src\api\trpc\traces\detail.ts`
- Rewrite: `F:\Temp\breadcrumb\services\server\src\api\trpc\traces\metadata.ts`
- Rewrite: `F:\Temp\breadcrumb\services\server\src\api\trpc\traces\stats.ts`
- Delete: `F:\Temp\breadcrumb\services\server\src\api\trpc\traces\insights.ts`
- Delete: `F:\Temp\breadcrumb\services\server\src\api\trpc\` (all non-traces routers: projects, apiKeys, mcpKeys, members, invitations, aiProviders, explores, observations, config)

- [ ] **Step 1: Simplify tRPC base — remove auth procedures**

Rewrite `services/server/src/trpc.ts` (at src root, NOT inside api/trpc/):

```typescript
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { Database } from "./db/sqlite";

export type TRPCContext = {
  db: Database;
};

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const procedure = t.procedure;
```

- [ ] **Step 2: Delete non-traces routers**

These are flat `.ts` files in `services/server/src/api/trpc/` (not directories). Also delete `insights.ts` from traces.

```bash
cd services/server/src/api/trpc
rm -f projects.ts api-keys.ts mcp-keys.ts members.ts invitations.ts
rm -f ai-providers.ts explore.ts config.ts observations.ts
rm -f traces/insights.ts
```

- [ ] **Step 3: Rewrite traces list procedure (SQLite)**

Rewrite `services/server/src/api/trpc/traces/list.ts`:

```typescript
import { z } from "zod";
import { procedure } from "../../../trpc";

export const listProcedure = procedure
  .input(
    z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      from: z.string().optional(),
      to: z.string().optional(),
      names: z.array(z.string()).optional(),
      models: z.array(z.string()).optional(),
      statuses: z.array(z.enum(["ok", "error"])).optional(),
      environments: z.array(z.string()).optional(),
      query: z.string().optional(),
      sortBy: z
        .enum([
          "name",
          "status",
          "spanCount",
          "tokens",
          "cost",
          "duration",
          "startTime",
        ])
        .default("startTime"),
      sortDir: z.enum(["asc", "desc"]).default("desc"),
    }),
  )
  .query(({ ctx, input }) => {
    const { db } = ctx;
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (input.from) {
      conditions.push("t.start_time >= $from");
      params.$from = input.from;
    }
    if (input.to) {
      conditions.push("t.start_time <= $to");
      params.$to = input.to;
    }
    if (input.statuses?.length) {
      const placeholders = input.statuses
        .map((_, i) => `$status${i}`)
        .join(",");
      conditions.push(`t.status IN (${placeholders})`);
      input.statuses.forEach((s, i) => {
        params[`$status${i}`] = s;
      });
    }
    if (input.environments?.length) {
      const placeholders = input.environments
        .map((_, i) => `$env${i}`)
        .join(",");
      conditions.push(`t.environment IN (${placeholders})`);
      input.environments.forEach((e, i) => {
        params[`$env${i}`] = e;
      });
    }
    if (input.names?.length) {
      const placeholders = input.names.map((_, i) => `$name${i}`).join(",");
      conditions.push(`t.name IN (${placeholders})`);
      input.names.forEach((n, i) => {
        params[`$name${i}`] = n;
      });
    }
    if (input.models?.length) {
      const placeholders = input.models.map((_, i) => `$model${i}`).join(",");
      conditions.push(
        `t.id IN (SELECT DISTINCT trace_id FROM spans WHERE model IN (${placeholders}))`,
      );
      input.models.forEach((m, i) => {
        params[`$model${i}`] = m;
      });
    }
    if (input.query) {
      conditions.push(
        `(t.name LIKE $query OR t.id IN (SELECT DISTINCT trace_id FROM spans WHERE input LIKE $query OR output LIKE $query OR name LIKE $query))`,
      );
      params.$query = `%${input.query}%`;
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sortMap: Record<string, string> = {
      name: "t.name",
      status: "t.status",
      spanCount: "COALESCE(r.span_count, 0)",
      tokens: "COALESCE(r.input_tokens, 0) + COALESCE(r.output_tokens, 0)",
      cost: "COALESCE(r.input_cost_usd, 0) + COALESCE(r.output_cost_usd, 0)",
      duration:
        "CASE WHEN t.end_time IS NOT NULL THEN (julianday(t.end_time) - julianday(t.start_time)) * 86400000 ELSE NULL END",
      startTime: "t.start_time",
    };
    const orderCol = sortMap[input.sortBy] || "t.start_time";

    const sql = `
      SELECT
        t.id,
        t.name,
        t.status,
        t.status_message AS statusMessage,
        t.start_time AS startTime,
        COALESCE(t.end_time, r.max_end_time) AS endTime,
        t.user_id AS userId,
        t.environment,
        COALESCE(r.input_tokens, 0) AS inputTokens,
        COALESCE(r.output_tokens, 0) AS outputTokens,
        COALESCE(r.input_cost_usd, 0) + COALESCE(r.output_cost_usd, 0) AS costUsd,
        COALESCE(r.span_count, 0) AS spanCount
      FROM traces t
      LEFT JOIN (
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
      ) r ON r.trace_id = t.id
      ${whereClause}
      ORDER BY ${orderCol} ${input.sortDir}
      LIMIT $limit OFFSET $offset
    `;

    params.$limit = input.limit;
    params.$offset = input.offset;

    const rows = db.prepare(sql).all(params);
    return { traces: rows };
  });
```

- [ ] **Step 4: Rewrite traces detail procedures (SQLite)**

Rewrite `services/server/src/api/trpc/traces/detail.ts`:

```typescript
import { z } from "zod";
import { procedure } from "../../../trpc";

const traceInput = z.object({
  traceId: z.string(),
});

export const getProcedure = procedure
  .input(traceInput)
  .query(({ ctx, input }) => {
    const row = ctx.db
      .prepare("SELECT name, status FROM traces WHERE id = $traceId")
      .get({ $traceId: input.traceId });
    return row ?? null;
  });

export const spansProcedure = procedure
  .input(traceInput)
  .query(({ ctx, input }) => {
    const rows = ctx.db
      .prepare(
        `SELECT
          id,
          parent_span_id AS parentSpanId,
          name, type, status,
          status_message AS statusMessage,
          start_time AS startTime,
          end_time AS endTime,
          provider, model,
          input_tokens AS inputTokens,
          output_tokens AS outputTokens,
          input_cost_usd AS inputCostUsd,
          output_cost_usd AS outputCostUsd,
          input, output, metadata
        FROM spans
        WHERE trace_id = $traceId
        ORDER BY start_time ASC`,
      )
      .all({ $traceId: input.traceId });
    return rows;
  });
```

- [ ] **Step 5: Rewrite metadata procedures (SQLite)**

Rewrite `services/server/src/api/trpc/traces/metadata.ts`:

```typescript
import { procedure } from "../../../trpc";

export const environmentsProcedure = procedure.query(({ ctx }) => {
  const rows = ctx.db
    .prepare(
      "SELECT DISTINCT environment FROM traces WHERE environment IS NOT NULL ORDER BY environment",
    )
    .all();
  return rows.map((r: any) => r.environment);
});

export const modelsProcedure = procedure.query(({ ctx }) => {
  const rows = ctx.db
    .prepare(
      "SELECT DISTINCT model FROM spans WHERE model IS NOT NULL ORDER BY model LIMIT 100",
    )
    .all();
  return rows.map((r: any) => r.model);
});

export const namesProcedure = procedure.query(({ ctx }) => {
  const rows = ctx.db
    .prepare(
      "SELECT DISTINCT name FROM traces ORDER BY name LIMIT 500",
    )
    .all();
  return rows.map((r: any) => r.name);
});

export const dailyCountProcedure = procedure.query(({ ctx }) => {
  const rows = ctx.db
    .prepare(
      `SELECT date(start_time) AS day, COUNT(*) AS count
       FROM traces
       WHERE start_time >= datetime('now', '-30 days')
       GROUP BY date(start_time)
       ORDER BY day ASC`,
    )
    .all();
  return rows;
});
```

- [ ] **Step 6: Rewrite stats procedures (SQLite)**

Rewrite `services/server/src/api/trpc/traces/stats.ts`:

```typescript
import { z } from "zod";
import { procedure } from "../../../trpc";

const filterInput = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  environments: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  names: z.array(z.string()).optional(),
});

export const statsProcedure = procedure
  .input(filterInput)
  .query(({ ctx, input }) => {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (input.from) {
      conditions.push("t.start_time >= $from");
      params.$from = input.from;
    }
    if (input.to) {
      conditions.push("t.start_time <= $to");
      params.$to = input.to;
    }
    if (input.environments?.length) {
      const ph = input.environments.map((_, i) => `$env${i}`).join(",");
      conditions.push(`t.environment IN (${ph})`);
      input.environments.forEach((e, i) => {
        params[`$env${i}`] = e;
      });
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT
        COUNT(DISTINCT t.id) AS traceCount,
        SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS errorCount,
        COALESCE(SUM(r.input_tokens + r.output_tokens), 0) AS totalTokens,
        COALESCE(SUM(r.input_cost_usd + r.output_cost_usd), 0) AS totalCostUsd,
        AVG(CASE WHEN t.end_time IS NOT NULL
          THEN (julianday(t.end_time) - julianday(t.start_time)) * 86400000
          ELSE NULL END) AS avgDurationMs
      FROM traces t
      LEFT JOIN (
        SELECT trace_id,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(input_cost_usd) AS input_cost_usd,
          SUM(output_cost_usd) AS output_cost_usd
        FROM spans GROUP BY trace_id
      ) r ON r.trace_id = t.id
      ${where}
    `;

    const row: any = ctx.db.prepare(sql).get(params);
    const traceCount = row?.traceCount ?? 0;
    const errorCount = row?.errorCount ?? 0;

    return {
      traceCount,
      errorCount,
      errorRate: traceCount > 0 ? errorCount / traceCount : 0,
      totalTokens: row?.totalTokens ?? 0,
      totalCostUsd: row?.totalCostUsd ?? 0,
      avgDurationMs: row?.avgDurationMs ?? 0,
    };
  });

export const dailyMetricsProcedure = procedure
  .input(filterInput)
  .query(({ ctx, input }) => {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (input.from) {
      conditions.push("t.start_time >= $from");
      params.$from = input.from;
    }
    if (input.to) {
      conditions.push("t.start_time <= $to");
      params.$to = input.to;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT
        date(t.start_time) AS day,
        COUNT(DISTINCT t.id) AS traces,
        SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS errors,
        COALESCE(SUM(r.input_cost_usd + r.output_cost_usd), 0) AS cost,
        AVG(CASE WHEN t.end_time IS NOT NULL
          THEN (julianday(t.end_time) - julianday(t.start_time)) * 86400000
          ELSE NULL END) AS avgDuration
      FROM traces t
      LEFT JOIN (
        SELECT trace_id,
          SUM(input_cost_usd) AS input_cost_usd,
          SUM(output_cost_usd) AS output_cost_usd
        FROM spans GROUP BY trace_id
      ) r ON r.trace_id = t.id
      ${where}
      GROUP BY date(t.start_time)
      ORDER BY day ASC
    `;

    return ctx.db.prepare(sql).all(params);
  });
```

- [ ] **Step 7: Rewrite traces router to compose new procedures**

Rewrite `services/server/src/api/trpc/traces/router.ts`:

```typescript
import { router } from "../../../trpc";
import { listProcedure } from "./list";
import { getProcedure, spansProcedure } from "./detail";
import {
  environmentsProcedure,
  modelsProcedure,
  namesProcedure,
  dailyCountProcedure,
} from "./metadata";
import { statsProcedure, dailyMetricsProcedure } from "./stats";

export const tracesRouter = router({
  list: listProcedure,
  get: getProcedure,
  spans: spansProcedure,
  stats: statsProcedure,
  dailyMetrics: dailyMetricsProcedure,
  environments: environmentsProcedure,
  models: modelsProcedure,
  names: namesProcedure,
  dailyCount: dailyCountProcedure,
});
```

- [ ] **Step 8: Rewrite root router**

Rewrite `services/server/src/api/trpc/router.ts`:

```typescript
import { router, procedure } from "../../trpc";
import { tracesRouter } from "./traces/router";

export const appRouter = router({
  health: procedure.query(() => ({ ok: true })),
  traces: tracesRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: rewrite tRPC router with SQLite queries"
```

---

### Task 4: Create exportable package entry point

**Files:**
- Create: `F:\Temp\breadcrumb\services\server\src\export.ts`
- Modify: `F:\Temp\breadcrumb\services\server\package.json` (add exports field)
- Delete: `F:\Temp\breadcrumb\services\server\src\index.ts` (old server startup)
- Delete: `F:\Temp\breadcrumb\services\server\src\app.ts` (old Hono app)
- Delete: `F:\Temp\breadcrumb\services\server\src\api\ingest\` (ingest routes — not needed, copilot-api writes directly)
- Delete: `F:\Temp\breadcrumb\services\server\src\api\mcp\` (MCP endpoint)
- Delete: `F:\Temp\breadcrumb\services\server\src\api\trpc\handler.ts` (old tRPC Hono adapter — copilot-api creates its own)

- [ ] **Step 1: Delete old server files and unused API routes**

```bash
rm -f services/server/src/index.ts
rm -f services/server/src/app.ts
rm -rf services/server/src/api/ingest
rm -rf services/server/src/api/mcp
rm -f services/server/src/api/trpc/handler.ts
```

- [ ] **Step 2: Create package export entry point**

Create `services/server/src/export.ts`:

```typescript
export { appRouter, type AppRouter } from "./api/trpc/router";
export { router, procedure, type TRPCContext } from "./trpc";
export { createDatabase, type Database } from "./db/sqlite";
export { SCHEMA_SQL } from "./db/schema";
```

- [ ] **Step 3: Update package.json with exports**

Add to `services/server/package.json`:

```json
{
  "name": "@breadcrumb/server",
  "exports": {
    ".": "./src/export.ts"
  },
  "types": "./src/export.ts"
}
```

- [ ] **Step 4: Verify the server package builds**

```bash
cd services/server && npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: create exportable package entry point for embedding"
```

---

## Chunk 2: Breadcrumb Fork — Web App Adaptation

### Task 5: Strip auth, projects, and unnecessary UI from web app

**Files:**
- Modify: `F:\Temp\breadcrumb\apps\web\src\main.tsx`
- Delete or rewrite: `F:\Temp\breadcrumb\apps\web\src\routes\_authed.tsx`
- Delete: `F:\Temp\breadcrumb\apps\web\src\routes\login.tsx`
- Delete: `F:\Temp\breadcrumb\apps\web\src\routes\signup.tsx`
- Delete: `F:\Temp\breadcrumb\apps\web\src\routes\accept-invite.tsx`
- Delete: `F:\Temp\breadcrumb\apps\web\src\routes\_authed\index.tsx` (project list)
- Delete: `F:\Temp\breadcrumb\apps\web\src\routes\_authed\new.tsx` (create project)
- Delete: `F:\Temp\breadcrumb\apps\web\src\routes\_authed\settings.tsx` (account settings)
- Delete: `F:\Temp\breadcrumb\apps\web\src\routes\_authed\projects\$projectId\index.tsx` (project overview)
- Delete: `F:\Temp\breadcrumb\apps\web\src\routes\_authed\projects\$projectId\settings.tsx`
- Delete: `F:\Temp\breadcrumb\apps\web\src\routes\_authed\projects\$projectId\explore.tsx`
- Simplify: `F:\Temp\breadcrumb\apps\web\src\routes\_authed\projects\$projectId.tsx` (project layout — strip project data fetching)
- Modify: `F:\Temp\breadcrumb\apps\web\src\main.tsx` (strip broken imports)
- Modify: `F:\Temp\breadcrumb\apps\web\src\hooks\useAuth.ts`
- Delete: `F:\Temp\breadcrumb\apps\web\src\lib\auth-client.ts`

- [ ] **Step 1: Delete unnecessary route files**

```bash
cd apps/web/src/routes
rm -f login.tsx signup.tsx accept-invite.tsx
rm -f _authed/index.tsx _authed/new.tsx _authed/settings.tsx
rm -f _authed/projects/\$projectId/index.tsx
rm -f _authed/projects/\$projectId/settings.tsx
rm -f _authed/projects/\$projectId/explore.tsx
```

- [ ] **Step 2: Replace useAuth hook with stub**

Rewrite `apps/web/src/hooks/useAuth.ts`:

```typescript
export function useAuth() {
  return {
    isViewer: false,
    role: "admin" as const,
    user: null,
    session: null,
  };
}
```

- [ ] **Step 3: Delete auth client**

```bash
rm -f apps/web/src/lib/auth-client.ts
```

- [ ] **Step 4: Simplify _authed layout — remove session check**

Rewrite `apps/web/src/routes/_authed.tsx` to be a pass-through:

```tsx
import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed")({
  component: () => <Outlet />,
});
```

- [ ] **Step 5: Simplify $projectId layout — remove project data fetching**

The file `apps/web/src/routes/_authed/projects/$projectId.tsx` is the project-level layout. It likely fetches project data via `trpc.projects.get.useQuery()`. Rewrite to be a pass-through:

```tsx
import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/projects/$projectId")({
  component: () => <Outlet />,
});
```

- [ ] **Step 6: Clean up main.tsx — strip broken imports**

In `apps/web/src/main.tsx`:
- Remove `UserJotBridge` import and usage (user tracking — depends on stripped userjot)
- Remove `TelemetryProvider` import and usage (PostHog telemetry — stripped)
- Remove `streamdown/styles.css` import (used by Explore — stripped)
- Remove `unstable_httpSubscriptionLink` and `splitLink` from tRPC client setup (used for Explore streaming — stripped). Keep only the `httpBatchLink`.
- Remove any `authClient` or Better Auth related imports

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: strip auth, project, and settings UI"
```

---

### Task 6: Adapt trace list and detail pages

**Files:**
- Modify: `F:\Temp\breadcrumb\apps\web\src\routes\_authed\projects\$projectId\traces.tsx`
- Modify: `F:\Temp\breadcrumb\apps\web\src\routes\_authed\projects\$projectId\trace.$traceId.tsx`

- [ ] **Step 1: Strip observations, insights, and projects.get from traces.tsx**

In `traces.tsx`:
- Remove `trpc.observations.unreadCount.useQuery()` call
- Remove the Overview tab from the `SIDEBAR_ITEMS` array
- Remove the Observations tab from `SIDEBAR_ITEMS`
- Remove `InsightsSection` and `ObservationsSection` imports and renders
- Remove `projectId` from all tRPC calls (or hardcode a dummy value — depending on how the router handles it)
- Keep only the Raw traces tab (`RawTracesSection`)

- [ ] **Step 2: Strip summary, analyze, projects.get from trace detail page**

In `trace.$traceId.tsx`:
- Remove `trpc.traces.summary.useQuery()` call
- Remove `trpc.traces.analyze.useMutation()` call
- Remove `trpc.projects.get.useQuery()` call
- Remove `TraceSummary` component render
- Remove Analyze button and auto-analyze effect
- Replace `useAuth()` import to use the stub (should work automatically since we rewrote the hook)
- Remove `projectId` from tRPC calls

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: strip observations, insights, and AI summary from trace pages"
```

---

### Task 7: Reconfigure routing for `/traces` base path

**Files:**
- Modify: `F:\Temp\breadcrumb\apps\web\vite.config.ts`
- Modify: `F:\Temp\breadcrumb\apps\web\src\main.tsx`
- Restructure route files to remove project scoping

- [ ] **Step 1: Update Vite config**

In `apps/web/vite.config.ts`:
- Set `base: "/traces/"` so all asset URLs resolve under `/traces/assets/`
- Update the dev proxy to point tRPC calls to `/traces/api/trpc`

- [ ] **Step 2: Update tRPC client endpoint**

In `apps/web/src/main.tsx`:
- Change the `httpBatchLink` URL from `"/trpc"` to `"/traces/api/trpc"`

- [ ] **Step 3: Restructure routes — flatten project scoping**

Move trace routes from `_authed/projects/$projectId/traces.tsx` and `trace.$traceId.tsx` to root-level routes. The exact approach depends on TanStack Router's file-based routing:

Option A: Move files to `routes/traces.tsx` and `routes/traces.$traceId.tsx`
Option B: Keep files in place but update route definitions to ignore `$projectId`

Choose whichever is simpler — verify by regenerating the route tree.

- [ ] **Step 4: Set TanStack Router basePath**

In the router configuration (likely `main.tsx` or a router config file), set `basepath: "/traces"`.

- [ ] **Step 5: Regenerate route tree and verify**

```bash
cd apps/web && npx @tanstack/router-cli generate
```

- [ ] **Step 6: Build the web app and verify**

```bash
cd apps/web && npm run build
```

Verify the output in `dist/` contains correct asset paths under `/traces/`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: reconfigure routing for /traces base path"
```

---

### Task 8: Add static assets export to package

**Files:**
- Modify: `F:\Temp\breadcrumb\apps\web\package.json`

- [ ] **Step 1: Update web app package.json exports**

```json
{
  "name": "@breadcrumb/web",
  "exports": {
    "./static": "./dist"
  }
}
```

- [ ] **Step 2: Build final assets**

```bash
cd apps/web && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: export pre-built static assets"
```

---

## Chunk 3: copilot-api — TraceRecorder & SQLite

### Task 9: Create TraceRecorder module

**Files:**
- Create: `F:\Projects\copilot-api\src\lib\trace-recorder.ts`
- Create: `F:\Projects\copilot-api\src\lib\trace-db.ts`

- [ ] **Step 1: Create SQLite database initialization**

Create `src/lib/trace-db.ts`:

```typescript
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { PATHS } from "./paths";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS traces (
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

CREATE TABLE IF NOT EXISTS spans (
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

CREATE INDEX IF NOT EXISTS idx_spans_trace_id ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_start_time ON traces(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
CREATE INDEX IF NOT EXISTS idx_traces_environment ON traces(environment);
CREATE INDEX IF NOT EXISTS idx_spans_model ON spans(model);
`;

let db: Database | null = null;

export function getTraceDb(): Database {
  if (!db) {
    const dbPath = join(PATHS.APP_DIR, "traces.db");
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(SCHEMA_SQL);
  }
  return db;
}

export function closeTraceDb(): void {
  db?.close();
  db = null;
}
```

- [ ] **Step 2: Create TraceRecorder class**

Create `src/lib/trace-recorder.ts`:

```typescript
import { getTraceDb } from "./trace-db";
import { consola } from "consola";

export interface SpanData {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  type: "llm" | "tool" | "retrieval" | "step" | "custom";
  startTime: string;
  endTime: string;
  status?: "ok" | "error";
  statusMessage?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, string>;
}

class TraceRecorder {
  startTrace(
    id: string,
    name: string,
    input?: unknown,
    meta?: { environment?: string; userId?: string },
  ): void {
    try {
      const db = getTraceDb();
      db.prepare(
        `INSERT INTO traces (id, name, start_time, input, environment, user_id)
         VALUES ($id, $name, $startTime, $input, $env, $userId)`,
      ).run({
        $id: id,
        $name: name,
        $startTime: new Date().toISOString(),
        $input: input ? JSON.stringify(input) : null,
        $env: meta?.environment ?? process.env.NODE_ENV ?? "development",
        $userId: meta?.userId ?? null,
      });
    } catch (err) {
      consola.debug("[trace] Failed to start trace:", err);
    }
  }

  endTrace(
    id: string,
    status: "ok" | "error",
    output?: unknown,
    statusMessage?: string,
  ): void {
    try {
      const db = getTraceDb();
      db.prepare(
        `UPDATE traces
         SET end_time = $endTime, status = $status, output = $output, status_message = $statusMessage
         WHERE id = $id`,
      ).run({
        $id: id,
        $endTime: new Date().toISOString(),
        $status: status,
        $output: output ? JSON.stringify(output) : null,
        $statusMessage: statusMessage ?? null,
      });
    } catch (err) {
      consola.debug("[trace] Failed to end trace:", err);
    }
  }

  recordSpan(span: SpanData): void {
    try {
      const db = getTraceDb();
      db.prepare(
        `INSERT INTO spans (id, trace_id, parent_span_id, name, type, status, status_message,
         start_time, end_time, provider, model, input_tokens, output_tokens,
         input_cost_usd, output_cost_usd, input, output, metadata)
         VALUES ($id, $traceId, $parentSpanId, $name, $type, $status, $statusMessage,
         $startTime, $endTime, $provider, $model, $inputTokens, $outputTokens,
         $inputCostUsd, $outputCostUsd, $input, $output, $metadata)`,
      ).run({
        $id: span.id,
        $traceId: span.traceId,
        $parentSpanId: span.parentSpanId ?? "",
        $name: span.name,
        $type: span.type,
        $status: span.status ?? "ok",
        $statusMessage: span.statusMessage ?? null,
        $startTime: span.startTime,
        $endTime: span.endTime,
        $provider: span.provider ?? null,
        $model: span.model ?? null,
        $inputTokens: span.inputTokens ?? 0,
        $outputTokens: span.outputTokens ?? 0,
        $inputCostUsd: span.inputCostUsd ?? 0,
        $outputCostUsd: span.outputCostUsd ?? 0,
        $input: span.input ? JSON.stringify(span.input) : null,
        $output: span.output ? JSON.stringify(span.output) : null,
        $metadata: span.metadata ? JSON.stringify(span.metadata) : null,
      });
    } catch (err) {
      consola.debug("[trace] Failed to record span:", err);
    }
  }
}

export const traceRecorder = new TraceRecorder();
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/trace-recorder.ts src/lib/trace-db.ts
git commit -m "feat: add TraceRecorder module with SQLite storage"
```

---

### Task 10: Add data retention cleanup

**Files:**
- Modify: `F:\Projects\copilot-api\src\lib\trace-recorder.ts`
- Modify: `F:\Projects\copilot-api\src\start.ts` (add CLI flag)
- Modify: `F:\Projects\copilot-api\src\main.ts` (add CLI arg)

- [ ] **Step 1: Add cleanup method to TraceRecorder**

Add to `src/lib/trace-recorder.ts`:

```typescript
cleanup(retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  try {
    const db = getTraceDb();
    const cutoff = `-${retentionDays} days`;
    db.prepare(
      "DELETE FROM spans WHERE trace_id IN (SELECT id FROM traces WHERE created_at < datetime('now', $cutoff))"
    ).run({ $cutoff: cutoff });
    const result = db.prepare(
      "DELETE FROM traces WHERE created_at < datetime('now', $cutoff)"
    ).run({ $cutoff: cutoff });
    return result.changes;
  } catch (err) {
    consola.debug("[trace] Cleanup failed:", err);
    return 0;
  }
}
```

- [ ] **Step 2: Add `--trace-retention-days` CLI arg and wire to RunServerOptions**

In `src/main.ts`, add to the start command args:

```typescript
traceRetentionDays: {
  type: "string",
  description: "Number of days to retain traces (0 = unlimited)",
  default: "30",
},
```

In `src/start.ts`, add `traceRetentionDays?: number` to the `RunServerOptions` interface (around line 29-44).

In the start command's `run()` function in `src/main.ts`, add the mapping:

```typescript
traceRetentionDays: Number(args.traceRetentionDays ?? 30),
```

- [ ] **Step 3: Start periodic cleanup in start.ts**

In `src/start.ts`, after server starts, add:

```typescript
const retentionDays = Number(options.traceRetentionDays ?? 30);
if (retentionDays > 0) {
  // Run cleanup on startup and every hour
  traceRecorder.cleanup(retentionDays);
  setInterval(() => traceRecorder.cleanup(retentionDays), 60 * 60 * 1000);
}
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add trace data retention with configurable cleanup"
```

---

## Chunk 4: copilot-api — PricePerToken Pricing Cache

### Task 11: Create pricing cache module

**Files:**
- Create: `F:\Projects\copilot-api\src\lib\pricing-cache.ts`

- [ ] **Step 1: Create pricing cache with PricePerToken API integration**

Create `src/lib/pricing-cache.ts`:

```typescript
import { consola } from "consola";

interface ModelPricing {
  inputPricePerToken: number;
  outputPricePerToken: number;
}

const pricingCache = new Map<string, ModelPricing>();

// Map copilot-api model names to PricePerToken model identifiers
const MODEL_NAME_MAP: Record<string, string> = {
  "gpt-4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  "gpt-4.1": "gpt-4.1",
  "gpt-4.1-mini": "gpt-4.1-mini",
  "gpt-4.1-nano": "gpt-4.1-nano",
  "claude-sonnet-4": "claude-sonnet-4",
  "claude-sonnet-4.5": "claude-sonnet-4.5",
  "claude-opus-4": "claude-opus-4",
  "claude-opus-4.6": "claude-opus-4.6",
  "claude-haiku-3.5": "claude-3.5-haiku",
  "o1": "o1",
  "o1-mini": "o1-mini",
  "o3": "o3",
  "o3-mini": "o3-mini",
  "o4-mini": "o4-mini",
  "gemini-2.0-flash": "gemini-2.0-flash",
};

export async function refreshPricingCache(): Promise<void> {
  try {
    // Use PricePerToken REST-like endpoint
    // The MCP endpoint uses JSON-RPC over SSE, but we can also try
    // calling the tool directly via HTTP POST
    const response = await fetch(
      "https://api.pricepertoken.com/mcp/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_all_models",
            arguments: {},
          },
        }),
      },
    );

    if (!response.ok) {
      consola.debug(
        `[pricing] PricePerToken API returned ${response.status}, using fallback`,
      );
      return;
    }

    const data = await response.json();
    // Parse the response and populate cache
    // The exact response format will be determined during implementation
    if (data?.result?.content) {
      for (const item of data.result.content) {
        if (item.type === "text") {
          const models = JSON.parse(item.text);
          for (const model of models) {
            const key =
              model.name?.toLowerCase() || model.id?.toLowerCase();
            if (key && model.input_price != null) {
              pricingCache.set(key, {
                inputPricePerToken: model.input_price,
                outputPricePerToken: model.output_price ?? model.input_price,
              });
            }
          }
        }
      }
      consola.info(`[pricing] Loaded pricing for ${pricingCache.size} models`);
    }
  } catch (err) {
    consola.debug("[pricing] Failed to fetch pricing data:", err);
  }
}

export function getModelPricing(modelName: string): ModelPricing | undefined {
  // Try direct lookup
  const direct = pricingCache.get(modelName.toLowerCase());
  if (direct) return direct;

  // Try mapped name
  const mapped = MODEL_NAME_MAP[modelName.toLowerCase()];
  if (mapped) return pricingCache.get(mapped);

  // Try fuzzy match — find a key that contains the model name
  for (const [key, pricing] of pricingCache) {
    if (
      key.includes(modelName.toLowerCase()) ||
      modelName.toLowerCase().includes(key)
    ) {
      return pricing;
    }
  }

  return undefined;
}

export function calculateCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
): { inputCostUsd: number; outputCostUsd: number } {
  const pricing = getModelPricing(modelName);
  if (!pricing) return { inputCostUsd: 0, outputCostUsd: 0 };
  return {
    inputCostUsd: inputTokens * pricing.inputPricePerToken,
    outputCostUsd: outputTokens * pricing.outputPricePerToken,
  };
}
```

- [ ] **Step 2: Initialize pricing cache on startup**

In `src/start.ts`, after token initialization:

```typescript
import { refreshPricingCache } from "./lib/pricing-cache";

// In runServer(), after token init:
refreshPricingCache(); // fire-and-forget, non-blocking
setInterval(() => refreshPricingCache(), 6 * 60 * 60 * 1000); // refresh every 6h
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/pricing-cache.ts
git commit -m "feat: add PricePerToken pricing cache for cost estimation"
```

---

## Chunk 5: copilot-api — Handler Instrumentation

### Task 12: Instrument the messages handler

**Files:**
- Modify: `F:\Projects\copilot-api\src\routes\messages\handler.ts`

This is the primary handler. Trace instrumentation wraps key phases.

- [ ] **Step 1: Add tracing imports and helper**

At the top of `handler.ts`:

```typescript
import { traceRecorder, type SpanData } from "../../lib/trace-recorder";
import { calculateCost } from "../../lib/pricing-cache";
import { randomUUID } from "node:crypto";

function spanId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function traceId(): string {
  return randomUUID().replace(/-/g, "");
}

function now(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 2: Add trace lifecycle to main handler function**

Wrap the handler entry/exit. At the start of the handler function (around line 112), add trace start. At the end (in the finally/return paths), add trace end.

The exact integration points based on the handler structure:
- **Line ~112**: After `checkRateLimit()`, create trace with `traceRecorder.startTrace()`
- **Line ~119**: Record `parse-request` span with the parsed model and payload
- **Line ~348-351**: After `getLastUsedAccountId()`, record `select-token` span
- **Line ~343-345**: Before/after `createChatCompletions()`, record `copilot-api-call` span
- **For streaming (lines ~382-417)**: Collect chunks in a buffer while streaming, record span after stream ends
- **For non-streaming (lines ~353-374)**: Record span with full response
- **After response translation**: Record `transform-response` span capturing the format conversion (Copilot → Anthropic/OpenAI)
- **After token counting**: Record `token-counting` span with input/output tokens and cost

The implementation should use try/catch around each span recording to ensure tracing never blocks the request.

- [ ] **Step 3: Handle streaming response chunk collection**

For streaming paths, add a chunk accumulator:

```typescript
const chunks: string[] = [];
// Inside the streaming loop, after processing each chunk:
chunks.push(chunkData);
// After stream ends:
const assembledOutput = chunks.join("");
traceRecorder.recordSpan({
  id: spanId(),
  traceId: currentTraceId,
  parentSpanId: rootSpanId,
  name: "copilot-api-call",
  type: "llm",
  startTime: callStartTime,
  endTime: now(),
  model: normalizedModel,
  provider: deriveProvider(normalizedModel),
  inputTokens,
  outputTokens,
  ...calculateCost(normalizedModel, inputTokens, outputTokens),
  input: messages,
  output: assembledOutput,
});
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/handler.ts
git commit -m "feat: instrument messages handler with trace recording"
```

---

### Task 13: Instrument chat-completions and responses handlers

**Files:**
- Modify: `F:\Projects\copilot-api\src\routes\chat-completions\handler.ts`
- Modify: `F:\Projects\copilot-api\src\routes\responses\handler.ts`

- [ ] **Step 1: Instrument chat-completions handler**

Same pattern as messages handler. Key integration points:
- Line ~24: After `checkRateLimit()`, start trace
- Line ~29: Record requested model
- Line ~80: Before/after `createChatCompletions()`, record LLM span
- Line ~88-114: Collect streaming chunks, record span after completion
- After handler returns: end trace

- [ ] **Step 2: Instrument responses handler**

Key integration points:
- Line ~99: After `checkRateLimit()`, start trace
- Line ~149: Before/after `createResponses()`, record LLM span
- Line ~157-254: Handle streaming/non-streaming response recording
- After handler returns: end trace

- [ ] **Step 3: Commit**

```bash
git add src/routes/chat-completions/handler.ts src/routes/responses/handler.ts
git commit -m "feat: instrument chat-completions and responses handlers with tracing"
```

---

## Chunk 6: copilot-api — UI Integration

### Task 14: Create traces auth middleware

**Files:**
- Create: `F:\Projects\copilot-api\src\lib\traces-auth.ts`

- [ ] **Step 1: Create cookie-based auth middleware for trace UI**

Create `src/lib/traces-auth.ts`:

```typescript
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { state } from "./state";

const COOKIE_NAME = "traces_session";

function getConfiguredApiKey(): string | undefined {
  return state.apiKeyAuth || process.env.COPILOT_API_KEY_AUTH;
}

export async function tracesAuthMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const configuredKey = getConfiguredApiKey();

  // If no API key is configured, allow all access
  if (!configuredKey) {
    return next();
  }

  // Check for key in query param (first visit)
  const queryKey = c.req.query("key");
  if (queryKey === configuredKey) {
    // Set cookie and redirect to remove key from URL
    setCookie(c, COOKIE_NAME, configuredKey, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/traces",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    const url = new URL(c.req.url);
    url.searchParams.delete("key");
    return c.redirect(url.toString());
  }

  // Check for key in cookie
  const cookieKey = getCookie(c, COOKIE_NAME);
  if (cookieKey === configuredKey) {
    return next();
  }

  // Check for key in header (tRPC client fallback)
  const headerKey =
    c.req.header("x-api-key") ||
    c.req.header("authorization")?.replace("Bearer ", "");
  if (headerKey === configuredKey) {
    return next();
  }

  // Return 401 with simple HTML prompt
  return c.html(
    `<!DOCTYPE html>
    <html><head><title>Traces - Auth Required</title></head>
    <body style="font-family:system-ui;max-width:400px;margin:100px auto;text-align:center">
      <h2>Authentication Required</h2>
      <p>Append <code>?key=YOUR_API_KEY</code> to the URL to access traces.</p>
    </body></html>`,
    401,
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/traces-auth.ts
git commit -m "feat: add cookie-based auth middleware for traces UI"
```

---

### Task 15: Mount tRPC router and static assets in server.ts

**Files:**
- Modify: `F:\Projects\copilot-api\src\server.ts`
- Modify: `F:\Projects\copilot-api\src\start.ts`
- Modify: `F:\Projects\copilot-api\package.json`

- [ ] **Step 1: Install Breadcrumb fork and tRPC dependencies**

```bash
cd F:\Projects\copilot-api
# Install the forked breadcrumb package (from local path or git URL)
bun add ../breadcrumb/services/server
# Install tRPC dependencies
bun add @trpc/server superjson
```

Note: The exact install command depends on how the fork is published. For local development, use a file path or workspace link.

- [ ] **Step 2: Mount traces routes in server.ts**

Add BEFORE the existing `apiKeyGuard` middleware in `src/server.ts`:

```typescript
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, type TRPCContext } from "@breadcrumb/server";
import { tracesAuthMiddleware } from "./lib/traces-auth";
import { getTraceDb } from "./lib/trace-db";
import { serveStatic } from "hono/bun";
import { join, dirname } from "node:path";

// Resolve path to pre-built static assets
const breadcrumbStaticDir = join(
  dirname(require.resolve("@breadcrumb/web/package.json")),
  "dist",
);

// Traces UI routes — own auth, mounted before apiKeyGuard
server.use("/traces/*", tracesAuthMiddleware);

// tRPC handler
server.all("/traces/api/trpc/*", async (c) => {
  const path = c.req.path.replace("/traces/api/trpc/", "");
  return fetchRequestHandler({
    endpoint: "/traces/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: (): TRPCContext => ({ db: getTraceDb() }),
  });
});

// Serve static assets
server.use(
  "/traces/assets/*",
  serveStatic({ root: breadcrumbStaticDir, rewriteRequestPath: (p) => p.replace("/traces/assets", "") }),
);

// SPA fallback — serve index.html for all /traces/* routes
const indexHtmlPath = join(breadcrumbStaticDir, "index.html");
server.get("/traces", async (c) => {
  return c.html(await Bun.file(indexHtmlPath).text());
});
server.get("/traces/*", async (c) => {
  const path = c.req.path;
  if (path.startsWith("/traces/api/") || path.startsWith("/traces/assets/")) {
    return c.notFound();
  }
  return c.html(await Bun.file(indexHtmlPath).text());
});
```

- [ ] **Step 3: Log traces URL on startup**

In `src/start.ts`, after the server starts, log:

```typescript
consola.info(`Traces UI available at http://${host}:${port}/traces`);
```

- [ ] **Step 4: Verify everything builds**

```bash
bun run build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: mount Breadcrumb tRPC router and trace viewer UI at /traces"
```

---

### Task 16: End-to-end smoke test

- [ ] **Step 1: Start the server**

```bash
bun run dev
```

- [ ] **Step 2: Make a proxied request**

Send a test request to `/v1/messages` or `/v1/chat/completions` and verify it still works normally.

- [ ] **Step 3: Verify trace was recorded**

Open `http://localhost:4141/traces?key=<your-api-key>` in a browser. Verify:
- The trace list loads
- The test request appears as a trace
- Clicking the trace shows the span tree
- Span detail panels show input/output payloads
- Token counts are displayed
- Cost estimates appear (if model is in PricePerToken cache)

- [ ] **Step 4: Verify data retention**

Check that `~/.local/share/copilot-api/traces.db` exists and contains data:

```bash
sqlite3 ~/.local/share/copilot-api/traces.db "SELECT COUNT(*) FROM traces; SELECT COUNT(*) FROM spans;"
```

- [ ] **Step 5: Commit any fixes discovered during testing**

```bash
git add -A && git commit -m "fix: address issues found during smoke testing"
```

---

## Summary

| Chunk | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-4 | Breadcrumb fork — strip features, SQLite server, exportable package |
| 2 | 5-8 | Breadcrumb fork — adapt web app, reconfigure routes, build assets |
| 3 | 9-10 | copilot-api — TraceRecorder module, SQLite storage, retention |
| 4 | 11 | copilot-api — PricePerToken pricing cache |
| 5 | 12-13 | copilot-api — instrument request handlers |
| 6 | 14-16 | copilot-api — mount UI, auth middleware, smoke test |
