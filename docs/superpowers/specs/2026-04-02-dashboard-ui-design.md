# Copilot API Dashboard — Design Spec

## Overview

A single-page admin dashboard at `/dashboard` for managing all copilot-api features through a web UI. Desktop-first, mobile-friendly. Protected by the same API key auth as the existing feature flags page (`--api-key-auth` / `COPILOT_API_KEY_AUTH`).

## Design Decisions

- **Layout:** Icon sidebar (60px collapsed), expands labels on hover. Active indicator bar on left edge. Settings icon pinned to bottom.
- **Style:** Dark Mode (OLED-safe), Developer Tool palette
- **Color palette:**
  - Background: `#0F172A`
  - Card/panel: `#1B2336`
  - Sidebar: `#1E293B`
  - Text primary: `#F8FAFC`
  - Text secondary: `#94A3B8`
  - Border: `#272F42` (subtle), `#334155` (sidebar border)
  - Accent green: `#22C55E` (active, healthy, success)
  - Info blue: `#3B82F6` (badges, links)
  - Warning orange: `#F97316` (requires_action, warnings)
  - Danger red: `#EF4444` (errors, destructive actions)
  - Purple: `#A78BFA` (direct-connect badge)
- **Typography:** System font stack (`system-ui, -apple-system, sans-serif`). Monospace for IDs, epochs, timestamps (`'Fira Code', monospace` or fallback `monospace`).
- **Icons:** Inline SVG (Lucide-style). No emoji. No icon library dependency — hand-inlined SVGs keep the page self-contained.
- **Auth pattern:** Same as existing feature flags page — API key input at top, stored in `sessionStorage`, sent as `x-api-key` header on all API calls. If no `--api-key-auth` is configured, dashboard loads without auth gate.

## Architecture

### Single inline HTML page

The dashboard is a single self-contained HTML file served from a TypeScript function (same pattern as `src/routes/feature-flags/page.ts`). No build step, no external dependencies, no JS framework. Vanilla JS + inline CSS.

### Route structure

```
GET  /dashboard                → HTML page (the dashboard)
GET  /dashboard/api/overview   → server status, counts
GET  /dashboard/api/sessions   → list code sessions + direct-connect sessions
POST /dashboard/api/sessions/:id/archive  → archive a code session
DELETE /dashboard/api/sessions/:id        → destroy a direct-connect session
GET  /dashboard/api/sessions/:id/events   → get recent events for a session
GET  /dashboard/api/environments          → list registered environments
DELETE /dashboard/api/environments/:id    → deregister an environment
GET  /dashboard/api/flags                 → list feature flags (proxy to existing store)
POST /dashboard/api/flags                 → set flag
DELETE /dashboard/api/flags               → remove flag
GET  /dashboard/api/replacements          → list replacement rules
POST /dashboard/api/replacements          → add rule
DELETE /dashboard/api/replacements/:id    → remove rule
PATCH /dashboard/api/replacements/:id/toggle → toggle rule
GET  /dashboard/api/usage                 → usage data
GET  /dashboard/api/settings              → server config (read-only)
```

All `/dashboard/api/*` routes are protected by the same API key guard as `/feature-flags/api`.

### File structure

```
src/routes/dashboard/
├── route.ts         # Hono router: serves HTML + API endpoints
├── page.ts          # getDashboardPage() → HTML string
├── api.ts           # API handler functions (reads from existing stores)
└── sections/        # HTML generators per section (keeps page.ts manageable)
    ├── overview.ts
    ├── sessions.ts
    ├── environments.ts
    ├── flags.ts
    ├── replacements.ts
    ├── usage.ts
    └── settings.ts
```

## Sidebar Navigation

7 sections, icon-only by default, labels appear on hover via CSS `:hover` + tooltip or expand animation.

| Icon | Label | Section | Description |
|------|-------|---------|-------------|
| Grid (4 squares) | Overview | `#overview` | Server health, active counts, uptime |
| Monitor | Sessions | `#sessions` | Code sessions + direct-connect sessions |
| Activity/pulse | Environments | `#environments` | Bridge environments (v1) |
| Flag | Feature Flags | `#flags` | Toggle/add/remove flags |
| Arrows (swap) | Replacements | `#replacements` | Auto-replacement rules |
| Bar chart | Usage | `#usage` | Copilot usage/quota |
| Gear (bottom-pinned) | Settings | `#settings` | Server config, voice config, version |

**Active state:** Left edge 3px green bar + icon color turns green + subtle background `#22C55E20`.

**Mobile (<768px):** Sidebar becomes a bottom navigation bar with 5 visible icons + overflow menu for the remaining 2. Hamburger button in top-left corner as alternative.

## Page Sections

### 1. Overview

Stat cards in a responsive grid (3 columns desktop, 2 tablet, 1 mobile):

| Card | Data source | Display |
|------|------------|---------|
| Active Sessions | `sessions.size` (code) + `directConnect.size` | Number + green dot |
| Environments | `environments.size` | Number |
| Feature Flags | `flags.length` | Number |
| Server Uptime | `process.uptime()` | "2h 45m" format |
| Request Count | Internal counter | Number (if tracked) |
| Health | `/health` endpoint | "OK" green badge |

Each card: `#1B2336` background, left border accent color, label in `#94A3B8` small text, value in `#F8FAFC` large text.

### 2. Sessions

Combined list of code sessions (`cse_*`) and direct-connect sessions (`dc_*`). Each session is a card row.

**Session card contents:**
- Status dot: green (running), orange pulsing (requires_action), gray (idle)
- Title (or "Untitled Session")
- Status badge: `running` / `idle` / `requires_action`
- Type badge: `code-session` (blue) / `direct-connect` (purple)
- Session ID (monospace, truncated)
- Epoch number (code sessions only)
- Time since creation ("12m ago", "2h ago")
- Pending action description (if requires_action, shown in orange)
- Action buttons:
  - Eye icon → expand to show recent events (inline, below the card)
  - Trash icon → archive (code session) or destroy (direct-connect)

**Event viewer (expanded):**
When the eye icon is clicked, the card expands to show the last 20 events in a scrollable list. Each event shows:
- Sequence number
- Event type (from payload.type)
- Source (worker/client)
- Timestamp
- Truncated payload (expandable on click)

Auto-refreshes via polling every 5 seconds when expanded.

**Empty state:** "No active sessions. Sessions are created when Claude Code connects."

### 3. Environments

List of registered bridge environments. Each row shows:
- Environment ID (monospace)
- Machine name
- Directory
- Branch
- Max sessions
- Work queue count (pending items)
- Created timestamp
- Action: Deregister button (red)

**Empty state:** "No environments registered. Use `claude remote-control` to register one."

### 4. Feature Flags

Same functionality as current `/feature-flags/` page but integrated into the dashboard:
- Sorted table: Flag name (monospace) | Value | Toggle (boolean) | Delete button
- Add form: name input + value input + Add button
- Boolean flags show toggle switches
- Non-boolean flags show the value with an edit button

### 5. Replacements

Table of auto-replacement rules:
- Columns: Name | Pattern | Replacement | Type (string/regex) | Enabled (toggle) | Actions (edit/delete)
- System rules shown but not editable (labeled "system")
- Add form: pattern input + replacement input + regex checkbox + name input + Add button
- Toggle button per rule

### 6. Usage

Display Copilot usage data:
- Progress bars for quota usage (requests this month / limit)
- Numbers for hourly usage
- Reset date
- Styled as cards similar to Overview section

### 7. Settings

Read-only display of server configuration:
- Server version, port, host
- Auth status (API key configured: yes/no)
- Multi-token mode (active/inactive, account count)
- Rate limit setting
- Manual approval (on/off)
- Sentry DSN (configured: yes/no, masked)
- Groq API key (configured: yes/no)
- Data directory path
- Proxy configuration
- Feature flag count

Displayed as a two-column key-value list. No edit capability — these are CLI/env configured.

## Authentication

Same pattern as existing feature flags page:

1. Page loads → check `sessionStorage` for stored API key
2. If found, attempt `GET /dashboard/api/overview` with `x-api-key` header
3. If 401, show login screen. If 200, show dashboard.
4. If no `--api-key-auth` is configured on the server, skip auth entirely (API returns 200 without key)
5. Login screen: centered card with API key input + "Login" button
6. On success, store key in `sessionStorage`, show dashboard

IP banning applies to failed auth attempts (same as feature flags).

## Responsive Behavior

| Breakpoint | Layout |
|-----------|--------|
| >= 1024px | Icon sidebar (60px) + full content area |
| 768-1023px | Icon sidebar (60px) + content area, stat cards 2-col |
| < 768px | No sidebar, bottom nav bar (5 icons + overflow). Hamburger top-left. Stat cards 1-col. Session cards stack vertically. |

## Data Fetching

- **Overview:** Fetch on page load, refresh every 30 seconds
- **Sessions:** Fetch on page load, refresh every 10 seconds (live session monitoring)
- **Environments:** Fetch on page load, refresh every 30 seconds
- **Flags:** Fetch on page load, no auto-refresh (user-triggered)
- **Replacements:** Fetch on page load, no auto-refresh
- **Usage:** Fetch on page load, no auto-refresh (rate limited upstream)
- **Settings:** Fetch on page load, no auto-refresh (static during server lifetime)
- **Section data:** Only fetched when that section is visible (lazy loading per tab)

## Interactions

| Action | Behavior |
|--------|----------|
| Click sidebar icon | Switch to that section (hash-based routing `#sessions`, `#flags`, etc.) |
| Hover sidebar icon | Show tooltip with label |
| Click session eye icon | Toggle event viewer expansion below that card |
| Click session archive/destroy | Confirmation dialog → API call → remove from list |
| Toggle flag | Immediate API call, optimistic update |
| Delete flag | Immediate API call, remove from list |
| Add flag | API call → add to sorted list |
| Toggle replacement | API call → update in list |
| Add replacement | API call → add to list |

## Error Handling

- API errors: Red toast notification at top-right, auto-dismiss 5 seconds
- Success actions: Green toast notification, auto-dismiss 3 seconds
- Network failure: "Connection lost" banner at top, retry button
- Empty states: Helpful message + contextual guidance (how to create sessions, etc.)

## Migration Path

The existing `/feature-flags/` page continues to work unchanged. The dashboard integrates the same functionality via the same underlying store. No breaking changes.
