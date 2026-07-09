---
name: Copilot API Dashboard
description: The control room for a GitHub Copilot proxy — an achromatic instrument where color is signal.
colors:
  # Neutral chassis. Every value is the DARK half of an Astryx `light-dark()` pair
  # (the app ships dark-first). Light-mode values live in the Colors prose below.
  bg-body: "#1b1b1b"
  bg-surface: "#262626"
  bg-card: "#1b1b1b"
  bg-popover: "#1b1b1b"
  bg-muted: "#1b1b1b"
  accent: "#ebebeb"
  accent-muted: "#262626"
  on-accent: "#171717"
  text-primary: "#fafafa"
  text-secondary: "#a3a3a3"
  text-disabled: "#525252"
  border: "#ffffff1a"
  border-emphasized: "#525252"
  # Signal. Non-neutral hue only ever carries meaning (status, syntax, category).
  success: "#9fe59b"
  error: "#ffc6c1"
  warning: "#fdcf4f"
  info: "#6d9cfe"
typography:
  display:
    fontFamily: 'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "2.625rem"
    fontWeight: 400
    lineHeight: 1.2381
  headline:
    fontFamily: 'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.3333
  title:
    fontFamily: 'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: 1.4118
  body:
    fontFamily: 'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4286
  label:
    fontFamily: 'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4286
  supporting:
    fontFamily: 'Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.6667
  code:
    fontFamily: 'ui-monospace, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4286
rounded:
  none: "4px"
  inner: "6px"
  element: "10px"
  container: "12px"
  page: "28px"
  full: "9999px"
spacing:
  "0-5": "2px"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.element}"
    padding: "8px 12px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.element}"
    padding: "8px 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.element}"
    padding: "8px 12px"
    height: "32px"
  button-destructive:
    backgroundColor: "#ff9e973d"
    textColor: "{colors.error}"
    rounded: "{rounded.element}"
    padding: "8px 12px"
    height: "32px"
  card:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.container}"
    padding: "12px"
  input:
    backgroundColor: "{colors.bg-body}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.element}"
    padding: "0 12px"
    height: "32px"
  badge-neutral:
    backgroundColor: "{colors.accent-muted}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
---

# Design System: Copilot API Dashboard

## 1. Overview

**Creative North Star: "The Control Room"**

This is the operator's control room for a live GitHub Copilot proxy: a neutral, unlit chassis that stays out of the way until there is a signal to read. The surface is near-monochrome by design. Backgrounds, text, borders, and even the "accent" are all steps on a single grey ramp; the only chromatic light in the room comes from status, syntax, and category. When you see color here, something is telling you something. The system is built on the **Astryx `neutral` theme** (Figtree + a monospaced stack, a 4px spatial grid, `light-dark()` tokens) and runs **dark-first** — dark is the default the app ships (`<html data-theme="dark">`), with a fully specified light mode as the toggle.

The register is a tool, not a page. It rejects everything that performs: no gradient hero metrics, no celebratory KPI cards, no glassmorphism, no decorative hue. It also rejects the opposite failure — enterprise-admin clutter, deep tab nesting, sluggish density-for-its-own-sake. The bar is the calm confidence of a well-built instrument (the Vercel / Planetscale lineage): dense where the operator asked for depth, quiet everywhere else, and honest about state at every moment. Depth is always one interaction away — summary → session → single request → raw wire payload — and the type, spacing, and color must never fight that drill.

**Key Characteristics:**
- **Achromatic chassis, chromatic signal.** Greyscale UI; hue is reserved for meaning.
- **Dark-first**, with a complete `light-dark()` light mode.
- **Dense but composed.** 14px base body, 4px grid, compact tables — legible, not a data dump.
- **Flat surfaces, tonal depth.** Layers and hairline borders, not drop shadows.
- **State shown, not decorated.** Inset rings and semantic tints for hover / selected / success / warning / error.
- **Figtree everywhere, mono for payloads.** One UI family; monospace whenever bytes must line up.

## 2. Colors

A single neutral ramp carries the entire interface; a tightly-scoped semantic set carries every non-neutral pixel. Values below are written **dark (default) / light (toggle)**, matching the `light-dark()` tokens.

### Primary
The "primary" is not a hue — it is the far end of the neutral ramp, flipped per mode.
- **Signal White / Ink Black** — `accent` (#ebebeb / #262626): primary buttons, current selection, the one high-contrast emphasis. On it sits `on-accent` (#171717 / #ffffff). In dark mode the primary action is a near-white chip with dark text; in light mode a near-black chip with white text. Its scarcity is the point.
- **Accent Muted** (#262626 / #f1f1f1): the quiet fill for neutral badges, hovered ghost surfaces, and low-emphasis chips.

### Neutral (the chassis)
- **Body** (#1b1b1b / #f1f1f1): the app canvas behind everything.
- **Surface** (#262626 / #ffffff): raised regions — the app shell, toolbars, elevated panels. One step off the body.
- **Card / Popover** (#1b1b1b / #ffffff): card and popover fills. Note in dark mode card == body; separation comes from the **border**, not a fill change.
- **Text Primary** (#fafafa / #171717): all default text and data. Hits AA on every chassis surface.
- **Text Secondary** (#a3a3a3 / #737373): labels, metadata, timestamps, table sub-values.
- **Text Disabled** (#525252 / #a3a3a3): disabled controls only.
- **Border** (rgba white 10% / #ebebeb): the primary separator. In dark mode it is a translucent white hairline; it, not shadow, is what makes a card read as a card.
- **Border Emphasized** (#525252 / #d4d4d4): input outlines, dividers that need to assert themselves.

### Signal (semantic — the only chromatic light)
- **Success** (#9fe59b / #007004): healthy state, OK health, active sessions, applied changes.
- **Error** (#ffc6c1 / #a50c25): failures, destructive actions, breached quota.
- **Warning** (#fdcf4f / #745b00): degraded / at-risk state, approaching limits.
- **Info** (#6d9cfe / #0074e2): informational banners and neutral-but-notable notices.
- **Category families** (red · orange · yellow · green · teal · cyan · blue · purple · pink · gray): each ships a coordinated `background` / `border` / `icon` / `text` quartet, used **only** to distinguish enumerated categories in Badges (provider kind, model dialect, environment) — never for decoration.
- **Syntax palette** (14 roles: keyword, string, comment, number, function, type, tag, attribute, property, …): the signature surface. Raw request/response payloads and JSON are the core inspection artifact, so code coloring is first-class, not an afterthought.

### Named Rules
**The Color-is-Signal Rule.** Non-neutral hue is *forbidden as decoration*. Every colored pixel must carry meaning: status (success / warning / error / info), syntax, or an enumerated category. If a color isn't telling the operator something, it is greyscale. There is no chromatic brand accent, and none is to be introduced.

**The Border-Not-Shadow Rule.** In dark mode, `card` and `body` share a fill. A surface is defined by its **hairline border**, not by a drop shadow. Reach for `border`, then `border-emphasized`; reach for shadow only for true overlays.

## 3. Typography

**Display / Heading / Body Font:** Figtree (with `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`)
**Label/Mono Font:** `ui-monospace, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace`

**Character:** One humanist-geometric sans does all UI work — headings, labels, buttons, body, data — tuned tight and small for density. Contrast comes from *weight and size*, never from a second display face. Monospace is the counter-voice, and it earns its place: any value where alignment or byte-accuracy matters (IDs, tokens, payloads, JSON) is set in mono.

### Hierarchy
Fixed rem scale (never fluid `clamp()` — this is product UI viewed at consistent DPI). Base body is **14px**.
- **Display** (400, 2.625rem/42px, lh 1.24): reserved; large empty-state or landing numerals only. Rare in a dense tool.
- **Headline** (600, 1.5rem/24px, lh 1.33): the page title (one per screen, via the `Page` header).
- **Title** (700, 1.0625rem/17px, lh 1.41): card and section titles, dialog titles.
- **Body** (400, 0.875rem/14px, lh 1.43): all default text and table data. Cap prose at 65–75ch; tabular data may run denser.
- **Label** (500, 0.875rem/14px, lh 1.43): form labels, stat labels, button text. Medium weight is the label tell.
- **Supporting** (400, 0.75rem/12px, lh 1.67): metadata, timestamps, helper text — always in `text-secondary`.
- **Code** (400, 0.875rem/14px, mono): inline IDs, tokens, and every raw payload / JSON block.

### Named Rules
**The Mono-for-Machines Rule.** Anything the machine emits or consumes — model IDs, request IDs, tokens, headers, JSON, wire payloads — is monospaced. Prose about the system is Figtree; artifacts of the system are mono.

**The No-Display-in-UI Rule.** The Display role never labels a control, button, or data cell. Fluid/clamped headings are prohibited; the scale is fixed rem.

## 4. Elevation

Flat by default, with depth built from **tonal layering + hairline borders**, not resting shadows. The stack reads body → surface → card by one-step tonal moves and a border, so the UI stays calm and print-flat at rest. Shadows are an *overlay* device only: they appear when an element genuinely floats above the page (popover, dropdown, dialog, toast) or as an **inset ring** that signals interaction state. Every raised shadow token also carries an inset top-hairline highlight (`inset 0 0 0 1px rgba(white, 8–15%)`) so floating surfaces catch a light edge in dark mode.

### Shadow Vocabulary
- **Low** (`--shadow-low`): subtle lift for popovers and hover-raised chips.
- **Medium** (`--shadow-med`): dropdowns, menus, select popouts.
- **High** (`--shadow-high`): modal dialogs and the heaviest overlays.
- **Inset state rings** (`--shadow-inset-hover` / `-selected` / `-success` / `-warning` / `-error`): a 2px inset ring drawn *inside* the element to mark hover, current selection, or a validation state — depth as feedback, not decoration.

### Named Rules
**The Flat-Chassis Rule.** Surfaces are flat at rest. If an element carries a drop shadow while sitting in the normal document flow, it is wrong — it should float (overlay) or lie flat (chassis). Depth at rest is tone + border only.

## 5. Components

Refined and restrained: quiet fills, hairline borders, 10px radii, and state shown through subtle inset rings rather than heavy color. Same vocabulary on every screen — the "save" button, the row action, the status token look identical everywhere.

### Buttons
- **Shape:** gently rounded, 10px (`radius-element`). Heights are fixed size steps: 28px (sm) / 32px (md) / 36px (lg); padding 8px × 12px.
- **Primary:** `accent` fill with `on-accent` text (near-white-on-dark chip in dark mode). The single loudest control on a screen; use one at a time.
- **Secondary:** `surface` fill, `text-primary`, hairline border. The default for most actions.
- **Ghost:** transparent until hover (then `overlay-hover` tint); used for table-row actions and toolbar icons, always with an accessible label + tooltip.
- **Destructive:** muted-error fill (`#ff9e973d`) with `error` text; never a full-saturation red button. Always routed through a confirm dialog (`ConfirmButton`) for irreversible actions.
- **Hover / Focus:** ~125ms (`--duration-fast`) tint/opacity shift; focus shows a visible ring. No transform bounce.

### Cards / Containers
- **Corner Style:** 12px (`radius-container`).
- **Background:** `card`; in dark mode identical to body, so it reads as a card via its **border**.
- **Shadow Strategy:** none at rest (see The Flat-Chassis Rule).
- **Border:** hairline `border`.
- **Internal Padding:** 12px (`spacing-3`).
- **Use:** dashboard widgets (StatCards), settings groups, grouped forms — **not** as a wrapper around list/table rows.

### Inputs / Fields
- **Style:** `body` fill, hairline outline, 10px radius, 32px tall, mono where the value is machine data.
- **Focus:** inset ring (`--shadow-inset-hover` / `-selected`), not an outer glow.
- **Error / Disabled:** error inset ring + `error` helper text; disabled drops to `text-disabled` with reduced contrast.

### Navigation
- **Style:** persistent, collapsible left `SideNav` inside an `AppShell` (elevated variant), grouped into **Monitor · Control · System** sections with a `SideNavHeading` (Copilot API / Admin Dashboard) and a footer light/dark toggle.
- **States:** selected item carries an `accent-muted` fill + `text-primary`; idle items are `text-secondary`; hover lifts to a subtle overlay tint.
- **Page header:** each screen uses the `Page` component with a `kicker` (the nav-group name, e.g. "Monitor") above the `title`. The kicker is **breadcrumb context, one per page** — it is not a decorative eyebrow.

### Tables (signature surface)
The primary way the operator reads the system. `DataTable` defaults: **compact** density, **row dividers**, **truncate + hover-tooltip** on overflow, row hover. Edge-to-edge, never wrapped in a Card. Text columns are sized proportionally; fixed pixel widths stay small so columns never overflow into a scrollbar. Row actions are right-aligned ghost `IconAction`s.

### Status & Badges
- **StatusDot / Token** for live state (health, session active/idle) — a small semantic dot, the lowest-ink status signal.
- **Badge** only for counts and enumerated states (provider kind, model dialect, environment), pulling from the category color quartets. Never a badge for decoration.
- **Banner** for inline, page-level alerts (load failure, degraded state) tinted by `status` (info / success / warning / error) with an inline retry action — not a modal.
- **StatCard** (custom): icon + label + value, tone-mapped (`default` / `accent` / `success` / `warning` / `error`) so the icon color states the reading at a glance. The one "metric card" allowed — small, honest, uncelebrated.

## 6. Do's and Don'ts

### Do:
- **Do** keep the UI greyscale and let color mean something — status, syntax, or enumerated category (The Color-is-Signal Rule).
- **Do** define surfaces with hairline `border` first; in dark mode card and body share a fill (The Border-Not-Shadow Rule).
- **Do** set every machine artifact — IDs, tokens, headers, JSON, payloads — in the monospace stack (The Mono-for-Machines Rule).
- **Do** show state with inset rings and semantic tints (hover / selected / success / warning / error), at 125–300ms.
- **Do** render dense data as edge-to-edge `DataTable` rows (compact, truncate + tooltip, row dividers), never Card-wrapped list items.
- **Do** keep depth flat at rest; use shadow only for true overlays (popover, dropdown, dialog, toast).
- **Do** stay on the 4px spatial grid and the fixed rem type scale; vary spacing for rhythm.
- **Do** honor the light/dark toggle — author with `light-dark()` tokens, never a hard-coded single-mode hex.

### Don't:
- **Don't** introduce a chromatic brand accent or use hue as decoration. No colored pixel without meaning.
- **Don't** build the **consumer-analytics look** — no gradient hero metrics, giant celebratory KPI cards, or cheerful charts. This is an instrument, not a report card.
- **Don't** slide into **enterprise-admin bloat** — no deep tab nesting, endless settings pages, or density for its own sake. Depth is reachable, not buried.
- **Don't** ship the **generic AI-SaaS template** — no cream/purple gradients, glassmorphism, identical icon-heading-text card grids, or tracked-uppercase eyebrows above every section.
- **Don't** go **toy / playful** — no pastel rounding, mascots, decorative illustration, or jokey copy. This is a serious working tool.
- **Don't** use `border-left`/`border-right` > 1px as a colored accent stripe on cards, rows, or banners. Use a full hairline border or a semantic background tint.
- **Don't** apply `background-clip: text` gradient text, or a resting drop shadow on in-flow surfaces.
- **Don't** put a Display-scale or fluid `clamp()` heading on a control, label, or data cell; the UI scale is fixed rem.
- **Don't** wrap a data table in a Card, or reach for a modal when an inline Banner / progressive disclosure will do.
