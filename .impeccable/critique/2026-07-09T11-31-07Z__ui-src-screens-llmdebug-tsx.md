---
target: llm-debug
total_score: 26
p0_count: 0
p1_count: 2
timestamp: 2026-07-09T11-31-07Z
slug: ui-src-screens-llmdebug-tsx
---
Method: dual-agent (A: a867a966 design-review · B: a50f0151 detector+browser)

# Critique — LLM Debug screen (`ui/src/screens/LlmDebug.tsx`)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Detail view never live-updates a pending entry (no polling); 10s list poll is silent, no "last refreshed" |
| 2 | Match System / Real World | 3 | Expert domain language is right; req/resp bytes shown as "X / Y" with no label |
| 3 | User Control and Freedom | 3 | Clear All is truly irreversible — confirm only, no undo/export-first |
| 4 | Consistency and Standards | 2 | Dense list uses `List`/`ListItem` not the mandated edge-to-edge `Table`; method/path is mono in detail, sans in the list |
| 5 | Error Prevention | 3 | Clear All confirm is solid; Replay's live-system side effects punted to another screen |
| 6 | Recognition Rather Than Recall | 2 | List metrics have no column headers/legend — must recall the "req/resp bytes · ms · time" schema |
| 7 | Flexibility and Efficiency | 1 | At 50+ polled rows: no search/filter/sort, no errors-only, no keyboard shortcuts, no copy-as-cURL |
| 8 | Aesthetic and Minimalist | 4 | Near-exemplary achromatic restraint; only the per-poll refresh spinner adds slight noise |
| 9 | Error Recovery | 3 | Strong error/stack surfacing, but stack `CodeBlock` isn't copyable; real 404 likely hits generic Banner, not the nice "Entry not found" |
| 10 | Help and Documentation | 2 | `retentionMs` is fetched but never shown — operator can't know how long evidence lives before it silently expires |
| **Total** | | **26/40** | **Acceptable → Good-in-parts: a trustworthy instrument held back by find-and-read ergonomics at scale** |

## Anti-Patterns Verdict

**Does this look AI-generated? No.** This is a genuine instrument, not slop.

**LLM assessment:** A fluent Linear / Vercel / DevTools user would trust it on sight. It passes essentially every DESIGN.md "Don't" — no gradient hero metrics, no glassmorphism, no cream/purple, no identical icon-heading-text card grid, no decorative hue, no colored border-stripes, no toy rounding, no jokey copy. Status is shape+text+color (not color alone); the destructive path is gated; the `kicker` is a legitimate one-per-page breadcrumb, not a tracked-uppercase eyebrow. Where a discerning user *would* pause, it's never strangeness-without-purpose — it's **under-built for the task**: a `List` doing a `Table`'s job, the primary payload capped behind a 400px keyhole, and no way to find one request among many.

**Deterministic scan:** `detect.mjs` returned **exit 0 / zero findings** on `LlmDebug.tsx`, `Page.tsx`, and `common.tsx`. Validated as genuine (a bad fixture returned exit 2 with 2 findings), so the clean result is real, not a no-op. No false positives. The scan **corroborates** the "not slop" verdict — the achromatic, token-driven composition leaves no raw hex/gradient/Tailwind tells to flag. Caveat: on `.tsx` the detector runs only regex + design-system checks; rendered-DOM rules (contrast, cramped padding, overflow) don't run and weren't browser-verified, so the source-level findings below are the real signal.

**Visual overlays:** None — live browser render was a verified skip. `AuthGate` wraps every screen behind `GET /dashboard/api/overview`; with the backend off (starting it spends real Copilot quota) the route never mounts, so only the login card would render. No misleading screenshot was produced; no quota spent.

## Overall Impression

This is a well-made, honest, on-brand debug surface — its states, restraint, and high-stakes reassurance are genuinely strong. But the screen exists to do two things — **find a specific request** and **read its raw payload** — and both are throttled: there's no search/filter on a list that polls and grows, and the payload (the entire point of the screen) is trapped in a 400px internally-scrolling box nested inside an already-scrolling page. The single biggest opportunity: make find-and-read frictionless, and the "Depth on demand" principle is fully delivered.

## What's Working

1. **Honest, complete, well-toned states.** Inline error Banner + Retry, shape-matched Skeletons, a calm empty state, and an *anticipatory* "expired/cleared" not-found message. Textbook DESIGN.md "Honest state."
2. **Real achromatic restraint.** Passes essentially every "Don't"; `StatusDot` is text+shape+color, not color-alone; Clear All is routed through `ConfirmButton` with honest, non-cheerful copy. The detector's clean scan confirms it.
3. **Power-user ergonomics already seeded.** Whole-body copy on both `CodeBlock`s, per-header copy, and genuinely deep-linkable detail routes (`#llm-debug:<id>`) — bookmarkable and shareable.

## Priority Issues

- **[P1] Findability doesn't scale.** *Why:* the operator's #1 job is finding a request in seconds, but the list polls every 10s and grows with no search, filter, sort, or — critically — an errors-only view (the most common debug case). *Fix:* add a filter/search toolbar (method/path/model + the unused `requestPreview`), a status filter (all/error/pending/complete), and newest-first sort. *Command:* `layout`
- **[P1] The primary artifact is capped at `maxHeight={400}`.** *Why:* raw payloads are THE inspection object, yet both bodies live in a 400px internally-scrolling region nested inside an already-scrollable page — a scroll trap that directly fights "Depth on demand." *Fix:* drop or greatly raise the cap with an explicit Expand/Collapse, and add prettify + word-wrap for minified wire JSON. *Command:* `polish`
- **[P2] Dense data rendered as unaligned `List` flex, not the mandated `Table`.** *Why:* DESIGN.md says dense data = edge-to-edge `DataTable` with proportional columns; the endContent's bytes/bytes · ms · time never line up across rows, so scanning latency/size down 50 rows is slow. `DataTable` already exists in `common.tsx`. *Fix:* convert to columns Status · Method+Path · Model · Req/Resp · Duration · Time with right-aligned numerics (and free sortability). *Command:* `layout`
- **[P2] Drill affordance and error salience are too quiet.** *Why:* rows are clickable with no visual cue, and a failed row's status *word* is grey `secondary` — only a small dot carries the error color, so failures don't pop in a scan (bad for a debug tool). *Fix:* add a trailing chevron on rows and tint the status label by variant so error rows read red (Color-is-Signal). *Command:* `colorize`
- **[P3] Missing expert verbs + silent Replay.** *Why:* the operator lives on copy-to-clipboard; the stack `CodeBlock` has no copy, there's no copy-as-cURL or copy-link-to-entry, and Replay simply vanishes when ineligible with no reason. *Fix:* add copy to the stack; add Copy-as-cURL and Copy-link; render Replay disabled-with-tooltip ("Only POST /chat/completions and /responses can be replayed") instead of hiding it; surface `retentionMs`. *Command:* `polish`

## Persona Red Flags

**Alex (power user):** no search/filter/sort on a growing polled list; no errors-only view; 400px payload keyhole with no prettify/wrap; no copy-as-cURL / copy-link, stack not copyable; no keyboard shortcuts (j/k, `/`, r, x); drilling into a **pending** request freezes it — the detail view has no polling.

**Sam (accessibility):** `ListItem` drill is `onClick`-only — keyboard focus/activation is unverified and a real risk if it renders a non-button element; no visible drill affordance beyond hover; the pulsing pending dot and per-poll refresh spinner depend on Astryx honoring `prefers-reduced-motion`; the 400px nested-scroll `CodeBlock` is a potential keyboard scroll trap; the error state's only *colored* element is a small dot (the label is grey).

**The Operator (project persona):** the core loop is frictionful exactly where it matters — *finding* (no filter) and *reading* (400px cap); `retentionMs` is on the wire but hidden, so the operator can't know how long captured evidence survives — a direct hit to "trust every number / honest state"; `requestPreview`/`responsePreview` are fetched but discarded, denying a scan aid; Replay eligibility is opaque.

## Minor Observations

- Every 10s poll drives `isRefreshing`, so the header refresh icon spins briefly every ~10s — small motion/noise in a "calm instrument." Consider a silent background refresh.
- Mono-for-Machines applied inconsistently: method/path is mono in the detail view but plain sans in the list label; the request URL is also non-mono.
- The friendly "Entry not found / expired" state is likely bypassed for real 404s — `api()` throws `ApiError` on non-ok, so the generic error Banner shows instead. Verify the server returns a resolvable empty for expired IDs if that copy is meant to be reached.
- A failed/pending entry with no response gets no "no response received" placeholder — the whole Response section is simply absent.
- `durationMs` is shown on the *request* line, not the response — slightly odd placement.
- Clear All offers no "export before clear" — irreversible loss of debug history.

## Questions to Consider

- If the operator must find a request in seconds, why is there no filter/search — and specifically no one-click "show only errors"?
- Is this a `List` wearing a `Table`'s clothes? What does `List`/`ListItem` buy here that the existing `DataTable` wouldn't?
- What large-payload session was `maxHeight={400}` ever tested against — why cap the one artifact this screen exists to display?
- `retentionMs` is right there on the envelope — why hide from the operator how long their evidence lives?
- Should Replay ever be *invisible*, or always visible-but-disabled with a reason, given "Honest state"?
- If a pending request is the most interesting thing to watch, why does drilling into it freeze it at "pending"?
