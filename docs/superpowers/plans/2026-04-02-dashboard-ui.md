# Copilot API Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-page admin dashboard at `/dashboard` for managing all copilot-api features (sessions, environments, flags, replacements, usage, settings) through a web UI with icon sidebar navigation and dark developer theme.

**Architecture:** Single self-contained inline HTML page (same pattern as existing `feature-flags/page.ts`) served by a Hono router. Dashboard API endpoints aggregate data from existing stores (session-store, environment-store, feature-flags/store, auto-replace, usage-tracker, state). No build step, no framework — vanilla JS + inline CSS + inline SVG icons.

**Tech Stack:** Hono, Bun, inline HTML/CSS/JS, SVG icons (Lucide-style)

---

## File Structure

```
src/routes/dashboard/
├── route.ts         # Hono router: serves HTML page + mounts API
├── page.ts          # getDashboardPage() → full HTML string
└── api.ts           # All /dashboard/api/* handler functions
```

Additionally, we need to add `listSessions()` and `listEnvironments()` exports to existing stores so the dashboard API can enumerate all items.

---

### Task 1: Add list exports to existing stores

**Files:**
- Modify: `src/routes/code-sessions/session-store.ts`
- Modify: `src/routes/environments/environment-store.ts`

- [ ] **Step 1: Add `listSessions` to session-store.ts**

Add this function after the existing `getSession` export in `src/routes/code-sessions/session-store.ts`:

```typescript
export function listSessions(): Array<CodeSession> {
  return Array.from(sessions.values())
}
```

- [ ] **Step 2: Add `listEnvironments` to environment-store.ts**

Add this function after the existing `getEnvironment` export in `src/routes/environments/environment-store.ts`:

```typescript
export function listEnvironments(): Array<Environment> {
  return Array.from(environments.values())
}
```

- [ ] **Step 3: Verify types compile**

Run: `bunx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/routes/code-sessions/session-store.ts src/routes/environments/environment-store.ts
git commit -m "feat: add listSessions and listEnvironments exports for dashboard"
```

---

### Task 2: Dashboard API endpoints

**Files:**
- Create: `src/routes/dashboard/api.ts`

- [ ] **Step 1: Create the API handler file**

This file contains all handler functions for `/dashboard/api/*` routes. Each handler reads from existing stores and returns JSON.

```typescript
// src/routes/dashboard/api.ts

import type { Context } from "hono"
import consola from "consola"

import { state } from "~/lib/state"
import { getUsageResponse } from "~/lib/usage-tracker"
import {
  getAllReplacements,
  addReplacement,
  removeReplacement,
  toggleReplacement,
} from "~/lib/auto-replace"
import {
  getFeatureFlags,
  setFeatureFlag,
  removeFeatureFlag,
} from "~/routes/feature-flags/store"
import {
  listSessions,
  getSession,
  archiveSession,
  getClientEvents,
} from "~/routes/code-sessions/session-store"
import {
  listDirectConnectSessions,
  destroyDirectConnectSession,
} from "~/routes/direct-connect/ws-handler"
import {
  listEnvironments,
  deregisterEnvironment,
} from "~/routes/environments/environment-store"

const startTime = Date.now()

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

// GET /dashboard/api/overview
export function handleOverview(c: Context) {
  const codeSessions = listSessions().filter((s) => !s.archived)
  const dcSessions = listDirectConnectSessions()
  const envs = listEnvironments()
  const flags = getFeatureFlags()

  return c.json({
    activeSessions: codeSessions.length + dcSessions.length,
    codeSessionsCount: codeSessions.length,
    directConnectCount: dcSessions.length,
    environmentsCount: envs.length,
    flagsCount: Object.keys(flags).length,
    uptime: formatUptime(Date.now() - startTime),
    health: "ok",
  })
}

// GET /dashboard/api/sessions
export function handleListSessions(c: Context) {
  const codeSessions = listSessions()
    .filter((s) => !s.archived)
    .map((s) => ({
      id: s.id,
      title: s.title,
      state: s.state,
      workerStatus: s.workerStatus,
      workerEpoch: s.workerEpoch,
      requiresActionDetails: s.requiresActionDetails,
      createdAt: s.createdAt,
      lastHeartbeat: s.lastHeartbeat,
      type: "code-session" as const,
    }))

  const dcSessions = listDirectConnectSessions().map((s) => ({
    id: s.id,
    title: "Direct Connect",
    state: "running" as const,
    workerStatus: "running" as const,
    workerEpoch: 0,
    requiresActionDetails: null,
    createdAt: s.createdAt,
    lastHeartbeat: s.createdAt,
    type: "direct-connect" as const,
  }))

  return c.json([...codeSessions, ...dcSessions])
}

// POST /dashboard/api/sessions/:id/archive
export function handleArchiveSession(c: Context) {
  const id = c.req.param("id")
  const ok = archiveSession(id)
  if (!ok) return c.json({ error: "not_found_or_already_archived" }, 404)
  consola.info(`[dashboard] Archived session ${id}`)
  return c.json({ ok: true })
}

// DELETE /dashboard/api/sessions/:id
export function handleDestroySession(c: Context) {
  const id = c.req.param("id")
  // Try direct-connect first
  if (destroyDirectConnectSession(id)) {
    consola.info(`[dashboard] Destroyed direct-connect session ${id}`)
    return c.json({ ok: true })
  }
  // Try archiving code session
  if (archiveSession(id)) {
    consola.info(`[dashboard] Archived code session ${id}`)
    return c.json({ ok: true })
  }
  return c.json({ error: "not_found" }, 404)
}

// GET /dashboard/api/sessions/:id/events
export function handleGetSessionEvents(c: Context) {
  const id = c.req.param("id")
  const session = getSession(id)
  if (!session) return c.json({ error: "not_found" }, 404)
  const events = getClientEvents(id, 0).slice(-20)
  return c.json(events)
}

// GET /dashboard/api/environments
export function handleListEnvironments(c: Context) {
  const envs = listEnvironments().map((e) => ({
    id: e.id,
    machineName: e.machineName,
    directory: e.directory,
    branch: e.branch,
    maxSessions: e.maxSessions,
    pendingWork: e.workQueue.filter((w) => w.state === "pending").length,
    createdAt: e.createdAt,
  }))
  return c.json(envs)
}

// DELETE /dashboard/api/environments/:id
export function handleDeregisterEnvironment(c: Context) {
  const id = c.req.param("id")
  const ok = deregisterEnvironment(id)
  if (!ok) return c.json({ error: "not_found" }, 404)
  consola.info(`[dashboard] Deregistered environment ${id}`)
  return c.json({ ok: true })
}

// GET /dashboard/api/flags
export function handleListFlags(c: Context) {
  return c.json(getFeatureFlags())
}

// POST /dashboard/api/flags
export async function handleSetFlag(c: Context) {
  const body = await c.req.json<{ name: string; value: unknown }>()
  if (!body.name) return c.json({ error: "name required" }, 400)
  setFeatureFlag(body.name, body.value as Record<string, unknown>)
  return c.json({ ok: true })
}

// DELETE /dashboard/api/flags
export async function handleDeleteFlag(c: Context) {
  const body = await c.req.json<{ name: string }>()
  if (!body.name) return c.json({ error: "name required" }, 400)
  const ok = removeFeatureFlag(body.name)
  if (!ok) return c.json({ error: "not_found" }, 404)
  return c.json({ ok: true })
}

// GET /dashboard/api/replacements
export async function handleListReplacements(c: Context) {
  const rules = await getAllReplacements()
  return c.json(rules)
}

// POST /dashboard/api/replacements
export async function handleAddReplacement(c: Context) {
  const body = await c.req.json<{
    pattern: string
    replacement?: string
    isRegex?: boolean
    name?: string
  }>()
  if (!body.pattern) return c.json({ error: "pattern required" }, 400)
  const rule = await addReplacement(body.pattern, body.replacement ?? "", {
    isRegex: body.isRegex ?? false,
    name: body.name,
  })
  return c.json(rule, 201)
}

// DELETE /dashboard/api/replacements/:id
export async function handleDeleteReplacement(c: Context) {
  const id = c.req.param("id")
  const ok = await removeReplacement(id)
  if (!ok) return c.json({ error: "not_found" }, 404)
  return c.json({ ok: true })
}

// PATCH /dashboard/api/replacements/:id/toggle
export async function handleToggleReplacement(c: Context) {
  const id = c.req.param("id")
  const rule = await toggleReplacement(id)
  if (!rule) return c.json({ error: "not_found" }, 404)
  return c.json(rule)
}

// GET /dashboard/api/usage
export function handleGetUsage(c: Context) {
  return c.json(getUsageResponse())
}

// GET /dashboard/api/settings
export function handleGetSettings(c: Context) {
  return c.json({
    version: "0.13.0",
    port: process.env.COPILOT_PORT ?? "4141",
    host: process.env.COPILOT_HOST ?? "0.0.0.0",
    apiKeyConfigured: !!state.apiKeyAuth,
    multiTokenMode: state.isMultiToken,
    rateLimitSeconds: state.rateLimitSeconds ?? null,
    manualApproval: state.manualApprove,
    sentryConfigured: !!process.env.SENTRY_DSN,
    groqConfigured: !!process.env.GROQ_API_KEY,
    dataDir: process.env.DATA_DIR ?? "~/.local/share/copilot-api",
    debug: state.debug,
    verbose: state.verbose,
  })
}
```

- [ ] **Step 2: Verify types compile**

Run: `bunx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/routes/dashboard/api.ts
git commit -m "feat: add dashboard API handlers"
```

---

### Task 3: Dashboard route (Hono router)

**Files:**
- Create: `src/routes/dashboard/route.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Create the route file**

```typescript
// src/routes/dashboard/route.ts

import { Hono } from "hono"

import {
  extractClientIp,
  isIpBlocked,
  recordFailedAttempt,
} from "~/lib/ip-blocker"
import { extractRequestApiKey } from "~/lib/request-auth"
import { state } from "~/lib/state"

import {
  handleOverview,
  handleListSessions,
  handleArchiveSession,
  handleDestroySession,
  handleGetSessionEvents,
  handleListEnvironments,
  handleDeregisterEnvironment,
  handleListFlags,
  handleSetFlag,
  handleDeleteFlag,
  handleListReplacements,
  handleAddReplacement,
  handleDeleteReplacement,
  handleToggleReplacement,
  handleGetUsage,
  handleGetSettings,
} from "./api"
import { getDashboardPage } from "./page"

export const dashboardRoutes = new Hono()

// Serve the dashboard HTML page (no auth — page handles auth via API calls)
dashboardRoutes.get("/", (c) => {
  return c.html(getDashboardPage())
})

// Auth guard for API routes — same pattern as feature-flags
dashboardRoutes.use("/api/*", async (c, next) => {
  const clientIp = extractClientIp(c)

  if (clientIp !== null && isIpBlocked(clientIp)) {
    await new Promise(() => {})
    return
  }

  if (!state.apiKeyAuth) {
    await next()
    return
  }

  const requestApiKey = extractRequestApiKey(c)

  if (requestApiKey === state.apiKeyAuth) {
    await next()
    return
  }

  if (clientIp !== null) {
    recordFailedAttempt(clientIp)
  }

  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
})

// API routes
dashboardRoutes.get("/api/overview", handleOverview)
dashboardRoutes.get("/api/sessions", handleListSessions)
dashboardRoutes.post("/api/sessions/:id/archive", handleArchiveSession)
dashboardRoutes.delete("/api/sessions/:id", handleDestroySession)
dashboardRoutes.get("/api/sessions/:id/events", handleGetSessionEvents)
dashboardRoutes.get("/api/environments", handleListEnvironments)
dashboardRoutes.delete("/api/environments/:id", handleDeregisterEnvironment)
dashboardRoutes.get("/api/flags", handleListFlags)
dashboardRoutes.post("/api/flags", handleSetFlag)
dashboardRoutes.delete("/api/flags", handleDeleteFlag)
dashboardRoutes.get("/api/replacements", handleListReplacements)
dashboardRoutes.post("/api/replacements", handleAddReplacement)
dashboardRoutes.delete("/api/replacements/:id", handleDeleteReplacement)
dashboardRoutes.patch("/api/replacements/:id/toggle", handleToggleReplacement)
dashboardRoutes.get("/api/usage", handleGetUsage)
dashboardRoutes.get("/api/settings", handleGetSettings)
```

- [ ] **Step 2: Mount in server.ts**

Read `src/server.ts` first. Add the import and mount the dashboard route in the pre-auth section (before `apiKeyGuard`), near the other unauthenticated routes:

```typescript
import { dashboardRoutes } from "./routes/dashboard/route"

// In the pre-auth section, add:
server.route("/dashboard", dashboardRoutes)
```

- [ ] **Step 3: Create a placeholder page.ts**

Create `src/routes/dashboard/page.ts` with a minimal placeholder so the route compiles:

```typescript
// src/routes/dashboard/page.ts

export function getDashboardPage(): string {
  return "<!DOCTYPE html><html><body><h1>Dashboard</h1></body></html>"
}
```

- [ ] **Step 4: Verify types compile**

Run: `bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/routes/dashboard/route.ts src/routes/dashboard/page.ts src/routes/dashboard/api.ts src/server.ts
git commit -m "feat: add dashboard route with API endpoints"
```

---

### Task 4: Dashboard HTML page — Shell (sidebar + auth + routing)

**Files:**
- Modify: `src/routes/dashboard/page.ts`

- [ ] **Step 1: Build the full dashboard page**

Replace the placeholder `page.ts` with the complete dashboard HTML. This is a large file (~800-1000 lines) containing:

1. **CSS:** Full dark theme with all color tokens, sidebar styling, responsive breakpoints, card/table styles, toast notifications, status dots, badges, toggle switches
2. **HTML structure:** Auth screen, sidebar with 7 SVG icons, main content area with 7 section divs (only one visible at a time)
3. **JavaScript:** Auth flow (sessionStorage), hash-based routing, API fetch helpers, section-specific render functions, auto-refresh timers, toast system, time-ago formatting

The page must be entirely self-contained — no external CSS, JS, or font dependencies. Uses `system-ui` font stack with `monospace` fallback for code.

Key specifications from the design spec:
- **Sidebar:** 60px wide, icon-only, tooltips on hover, active indicator (3px green left bar), Settings pinned to bottom
- **Colors:** bg `#0F172A`, card `#1B2336`, sidebar `#1E293B`, text `#F8FAFC`/`#94A3B8`, green `#22C55E`, blue `#3B82F6`, orange `#F97316`, red `#EF4444`, purple `#A78BFA`
- **Mobile:** Bottom nav at <768px, hamburger menu, single-column cards
- **Auth:** Same pattern as feature-flags page — API key input, sessionStorage, x-api-key header
- **Routing:** Hash-based (`#overview`, `#sessions`, `#environments`, `#flags`, `#replacements`, `#usage`, `#settings`)
- **Auto-refresh:** Sessions every 10s, Overview/Environments every 30s, others on-demand
- **Toasts:** Green success (3s), red error (5s), top-right positioned

Since this is a very large file, the implementer should write `getDashboardPage()` that returns the complete HTML string (template literal). Follow the exact same pattern as `src/routes/feature-flags/page.ts` — a single exported function returning a template literal.

The full sections should include:

**Overview section:** 6 stat cards (active sessions, environments, flags, uptime, health, direct-connect count) in a CSS grid (3 col → 2 col → 1 col responsive). Each card has left accent border, label in small muted text, value in large white text.

**Sessions section:** List of session cards fetched from `/dashboard/api/sessions`. Each card row shows: status dot (green/orange/gray with glow), title, status badge, type badge (code-session blue / direct-connect purple), session ID (mono), epoch, time-ago. Action buttons: eye (view events), trash (archive/destroy). Expandable event viewer below each card. Auto-refresh every 10s.

**Environments section:** Table of environments from `/dashboard/api/environments`. Columns: ID (mono), Machine, Directory, Branch, Max Sessions, Pending Work, Created. Deregister button per row. Auto-refresh every 30s.

**Flags section:** Same UI as existing feature-flags page: sorted flag table with toggle/delete, add form with name + value inputs. Fetched from `/dashboard/api/flags`.

**Replacements section:** Table of rules from `/dashboard/api/replacements`. Columns: Name, Pattern (mono), Replacement, Type (string/regex badge), Enabled (toggle), Actions (delete). System rules are visually distinct and non-editable. Add form below.

**Usage section:** Usage data from `/dashboard/api/usage` displayed as cards with progress bars.

**Settings section:** Two-column key-value list from `/dashboard/api/settings`. Read-only. Shows server version, port, host, auth status, multi-token mode, rate limit, Sentry status, Groq status, data dir.

- [ ] **Step 2: Verify the page loads**

Run: `bun run dev` and open `http://localhost:4141/dashboard` in a browser. Verify:
- Auth screen appears (if `--api-key-auth` is set)
- Sidebar renders with all 7 icons
- Clicking icons switches sections
- Overview section loads with stat cards
- Sessions section shows empty state or active sessions

- [ ] **Step 3: Commit**

```bash
git add src/routes/dashboard/page.ts
git commit -m "feat: add complete dashboard HTML page with all sections"
```

---

### Task 5: Polish and test

**Files:**
- No new files — testing and fixes only

- [ ] **Step 1: Test all dashboard API endpoints**

```bash
# Overview
curl -s http://localhost:4141/dashboard/api/overview | jq .

# Sessions (should return empty array or active sessions)
curl -s http://localhost:4141/dashboard/api/sessions | jq .

# Environments
curl -s http://localhost:4141/dashboard/api/environments | jq .

# Flags
curl -s http://localhost:4141/dashboard/api/flags | jq .

# Replacements
curl -s http://localhost:4141/dashboard/api/replacements | jq .

# Usage
curl -s http://localhost:4141/dashboard/api/usage | jq .

# Settings
curl -s http://localhost:4141/dashboard/api/settings | jq .
```

- [ ] **Step 2: Test session management flow**

```bash
# Create a code session
curl -s -X POST http://localhost:4141/v1/code/sessions \
  -H "Content-Type: application/json" \
  -d '{"title":"Test from CLI","bridge":{}}' | jq .

# Verify it appears in dashboard API
curl -s http://localhost:4141/dashboard/api/sessions | jq .

# Archive it via dashboard API
curl -s -X POST http://localhost:4141/dashboard/api/sessions/SESSION_ID/archive | jq .
```

- [ ] **Step 3: Test flags management via dashboard API**

```bash
# Set a flag
curl -s -X POST http://localhost:4141/dashboard/api/flags \
  -H "Content-Type: application/json" \
  -d '{"name":"test_flag","value":true}' | jq .

# Verify
curl -s http://localhost:4141/dashboard/api/flags | jq .

# Delete it
curl -s -X DELETE http://localhost:4141/dashboard/api/flags \
  -H "Content-Type: application/json" \
  -d '{"name":"test_flag"}' | jq .
```

- [ ] **Step 4: Verify type check passes**

Run: `bunx tsc --noEmit`

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: dashboard polish and fixes"
```
