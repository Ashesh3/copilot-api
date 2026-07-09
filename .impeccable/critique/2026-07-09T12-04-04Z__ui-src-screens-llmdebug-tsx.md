---
target: llm-debug
total_score: 32
p0_count: 0
p1_count: 0
timestamp: 2026-07-09T12-04-04Z
slug: ui-src-screens-llmdebug-tsx
---
Method: dual-agent (A: a60ec371 design-review · B: a7dcee0f detector+browser)

# Re-critique — LLM Debug screen (`ui/src/screens/LlmDebug.tsx`)

Prior run: 26/40. This run: **32/40** — all six prior issues resolved; three new behavioral trade-offs introduced by the fixes.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Strong (dot/pulse/count/retention/toasts); a *pending* detail polls silently with no live indicator |
| 2 | Match System / Real World | 4 | Expert language, cURL, wire terms, mono throughout — persona-perfect |
| 3 | User Control and Freedom | 3 | Back/Clear-filters/Export/Retry present; Pretty default obscures real bytes, Raw not persisted |
| 4 | Consistency and Standards | 3 | Shared components + spec-compliant table; the floating format toolbar is a novel unanchored pattern |
| 5 | Error Prevention | 3 | Confirm-on-destroy, Replay guarded; but cURL silently embeds auth tokens |
| 6 | Recognition Rather Than Recall | 2 | Format/Wrap controls sit far above the payloads; Raw is buried |
| 7 | Flexibility and Efficiency | 4 | Search + filter + sort + copy-cURL/link + copyable headers/stack + export + replay, all keyboard-reachable |
| 8 | Aesthetic and Minimalist | 3 | Restrained/achromatic, but the detail header is now busy and the toolbar shows even when it controls nothing |
| 9 | Error Recovery | 4 | Friendly 404, banner+retry, bodyReadError warning, error name/message/stack — honest state |
| 10 | Help and Documentation | 3 | Tooltips, empty-state guidance, disabled-Replay explanation — appropriately minimal for the expert |
| **Total** | | **32/40** | **Good — competent and ship-worthy; needs targeted polish** |

## Prior Issues — Verified Resolved (6/6)

| Prior issue | Status |
|---|---|
| [P1] Findability at scale | **Resolved** — search + status filter (errors-only) + sortable table + newest-first + "no matches" empty state |
| [P1] Payload capped at maxHeight=400 | **Resolved** — bodies uncapped, single page scroll, no nested trap |
| [P2] List not Table | **Resolved** — real `Table`, proportional/pixel widths, right-aligned numerics, dividers, hover |
| [P2] Drill affordance + error salience | **Resolved** — labeled `ChevronRight` inspect action + error label tinted red |
| [P3] Expert verbs + Replay hidden | **Resolved** — cURL/link/copyable stack; Replay disabled-with-tooltip (tooltip *verified* to surface via Astryx `aria-disabled`) |
| Minors (spinner, mono, 404, no-response, export) | **Resolved** — silent poll, mono URL, 404→friendly state, placeholder, export button |

## Anti-Patterns Verdict

**Does this look AI-generated? No** — a credible product-register instrument.

- **LLM assessment:** achromatic chassis, edge-to-edge compact table, mono for every machine artifact, single error tint as the only chromatic signal, spec'd page header, no gradients/KPI cards/glass. Expert verbs speak expert-to-expert. The reasons it isn't top-tier are *behavioral, not cosmetic* (see Priority Issues).
- **Deterministic scan:** `detect.mjs` → **exit 0, zero findings** on the screen + all supporting files, validated against a bad fixture (exit 2, 2 findings). **No false positives.** Notably, the intentional `style={{ color: "var(--color-error)" }}` tint was **not** flagged — the detector correctly treats the CSS custom property as a sanctioned design token, confirming the achromatic "Color is Signal" approach is on-system.
- **Visual overlays:** none — verified skip. `AuthGate` still gates every screen behind a backend probe; Vite-alone renders only the login card, and the backend spends real Copilot quota. No screenshot, no quota spent.

## Overall Impression

A clear, earned lift over the 26 baseline — every P1 is genuinely closed and the core loop (list → detail → raw) is now well-supported and calm. It's held back by **three behavioral flaws the fixes themselves introduced**, two of which quietly contradict PRODUCT.md principles: the payload view **defaults to a lossy pretty-print** (fights "see what actually went over the wire"), and **Export-before-Clear saves only summaries, not payloads** (an illusory safety net before an irreversible delete). Neither is cosmetic; both are one small change from right.

## What's Working

1. **Disabled-Replay done right** — `tooltip` is set only when ineligible, so Astryx routes to `aria-disabled` (stays focusable/hoverable) and the reason actually surfaces. Avoids the usual "disabled swallows hover" trap.
2. **Honest-state coverage** — 404→friendly EmptyState, load error→Banner+Retry, bodyReadError→warning, error entry→name/message/stack, pending/no-response placeholders.
3. **Correct achromatic tinting** — confirmed `Text.color` has no semantic option, so the token-based inline style is the *right* way to tint the error label, not a smell. The clean detector scan corroborates.

## Priority Issues (new trade-offs from the fixes)

- **[P2] Payload defaults to lossy Pretty; Raw is buried.** `viewMode` defaults to `"pretty"`; `prettyJson` does `JSON.stringify(JSON.parse(raw))`, which normalizes whitespace/escapes/number formatting — *not* the bytes on the wire. For a tool whose #1 job is byte-accurate wire inspection, the default hides the evidence. *Fix:* default to **Raw** (Pretty as opt-in), or badge Pretty as "reformatted" and make Raw prominent per-payload. → `clarify`
- **[P2] Export-before-Clear backs up only summaries, not payloads.** `handleExport` serializes the list `entries` (previews + byte counts, no bodies/headers); the real payloads live only in per-id detail. So Export→Clear All destroys the actual inspectable artifacts while the "backup" keeps only previews — a trust violation before an irreversible action. *Fix:* fetch details for export (or a server bulk-export), or relabel "Export summaries" and warn in the Clear-All confirm. → `harden`
- **[P2] Format/Wrap toolbar is detached from what it controls.** The `Pretty|Raw` + `Wrap` row sits at the top of the detail but governs `CodeBlock`s far below; it also renders even when the entry has no body to format. *Fix:* move the toggles into each `CodeBlock` header (per-payload, always in view), and render only when ≥1 body exists. → `layout`
- **[P3] Copy-as-cURL embeds all auth headers.** `buildCurl` includes Authorization/x-api-key/cookie with no indication secrets are included — a paste-into-a-bug-report leak. Defensible under "Trust the operator," but silent. *Fix:* a "Copy as cURL (redacted)" variant, or mask known auth headers with a reveal toggle. → `harden`
- **[P3] Detail header crowding + dead loud control.** Four buttons (cURL · link · Replay · Back) plus Refresh + format toggle + Wrap; and a disabled **primary** Replay is the loudest control in the common non-chat case. *Fix:* icon-only ghosts for cURL/link; demote Replay to secondary when ineligible. → `distill`

## Persona Red Flags

- **Alex (power user):** opens a request expecting wire bytes → gets reformatted JSON and may not notice; Raw isn't remembered across entries; format/wrap controls scroll off above the response; cURL leaks tokens; sorting Duration ↓ floats pending (null-duration) rows to the top (Astryx null-ordering); Export ignores the active filter and omits bodies.
- **Sam (accessibility):** mostly strong — sort headers are real buttons with `aria-sort`, the chevron and disabled-Replay are keyboard-reachable and tooltip-surfacing, error state is dot+tint+text (not color-only). Watch: confirm the "Copied" toast has an `aria-live` announcement; the detached toolbar increases target-hunting for magnifier users.
- **Solo-operator (PRODUCT):** core loop is calm and well-supported, but the Pretty default contradicts "see what actually went over the wire," and Export-before-Clear contradicts "Honest state" by quietly not backing up payloads. Live reassurance on a *pending* entry is thin.

## Minor Observations

- Skeleton rows `height={56}` vs ~40px compact rows → slight load-in jump.
- `language="json"` is hardcoded even for streaming SSE responses (harmless; Pretty falls back to raw).
- Duration cell lacks tabular figures; a tabular-numbers treatment would align the right-aligned column.
- Search input is sans while it queries machine data — mono would match Mono-for-Machines (trivial).

## Questions to Consider

- If the #1 job is byte-accurate wire inspection, why does the payload **default to a lossy reformat**? Should Raw be default and Pretty opt-in?
- Should format/wrap live in **each CodeBlock header** (per-payload, always in view) rather than one detached toolbar?
- "Export before Clear" that saves only previews — safety net or **trap**? Should Clear-All's confirm say payloads aren't included?
- Is a disabled **primary** Replay the right hierarchy when ineligibility is the common case?
