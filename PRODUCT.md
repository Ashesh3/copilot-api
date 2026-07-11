# Product

## Register

product

## Users

A single expert operator who runs and maintains this proxy. They know the internals cold — model IDs, wire formats, the Copilot ⇄ OpenAI/Anthropic translation. They arrive at the dashboard already in a task, hands on keyboard: something looks off in a request, a routing rule needs changing, a new provider needs wiring up. This is not a passive dashboard-glancer — it's a hands-on power user who drills into individual requests and expects the tool to keep up.

The job to be done, in order of how often it happens:

1. **Debug & inspect requests** — see what actually went over the wire (LLM Debug, Replay, Sessions), diagnose a bad translation or failed call, understand a request's full lifecycle.
2. **Control routing & behavior** — model redirects, custom providers, feature flags, replacements, routing rules; change how a live system handles traffic, then get back to work.
3. **Monitor usage & quota** — secondary; a health/quota check, not the main reason to open the app.

## Product Purpose

`copilot-api` is a reverse-engineered proxy that exposes GitHub Copilot as OpenAI- and Anthropic-compatible APIs (it can back Claude Code and any OpenAI/Anthropic-compatible client). The dashboard is the operator's **control room** for that proxy.

It exists so one person can (a) understand any request's full lifecycle fast — from client payload through translation to the upstream Copilot/provider call and back — and (b) change routing, redirect, provider, and flag behavior of the live system with confidence and no friction.

Success looks like: the operator finds and comprehends any request in seconds, trusts every number on screen without re-checking, and reconfigures behavior without fear of breaking things. The tool disappears into the task.

## Brand Personality

**Precise, confident, restrained.** The reference is Vercel / Planetscale dashboards: clean data display, real visual craft, and the discipline to leave things out.

- **Voice & tone:** expert-to-expert. Direct labels, real numbers, honest states. No marketing cheer, no hand-holding copy, no explaining what a "model" is. It trusts the reader.
- **Emotional goal:** the calm confidence of a well-built instrument. The operator feels in control and never second-guesses what they're seeing.
- **Density with craft:** information-rich is welcome — the user asked for depth — but density is composed and legible, never a data dump.

## Anti-references

This should explicitly NOT look or feel like:

- **Consumer analytics dashboards** — big gradient hero metrics, giant celebratory KPI cards, cheerful charts. This is an instrument, not a report card.
- **Enterprise admin bloat** — clutter, deeply nested tabs, endless settings pages, sluggish feel. Depth should be reachable, not buried.
- **Generic AI-SaaS template** — cream/purple gradients, glassmorphism, identical icon-heading-text card grids, tracked-uppercase eyebrows above every section. None of the 2025-era slop scaffolding.
- **Toy / playful UI** — rounded pastel everything, mascots, decorative illustration, jokey copy. This is a serious working tool.

## Design Principles

1. **Depth on demand.** The surface stays calm; full detail is always one interaction away, never forced up front. The core loop is drilling summary → session → single request → raw wire payload, and every step of that path must be frictionless.
2. **Trust the operator.** One expert user, so no confirm-everything dialogs, no dumbed-down copy, no hidden internals. Show real model IDs, raw payloads, exact numbers. Density is a feature when the user asked for depth.
3. **Instrument, not advertisement.** The tool serves the task and disappears; it does not perform. No celebratory metrics, no decoration for its own sake. Every element earns its place by serving inspection or control.
4. **Honest state.** Errors, empty, loading, and edge cases are first-class, not afterthoughts. When something is wrong — quota hit, provider down, request failed — the UI says so plainly and precisely, because the operator relies on these signals being real.
5. **Fast, reversible control.** Routing, redirects, providers, and flags change the behavior of a live system. Make each change quick to perform, obvious in what it does, and easy to understand or undo.

## Accessibility & Inclusion

No formal conformance target and no special user needs (a single known operator). As a baseline of good practice for a text- and data-dense tool used in long sessions, maintain: WCAG AA contrast on body text and data, full keyboard navigability, visible focus states, and honoring `prefers-reduced-motion`. These are a floor to keep, not a mandate to certify against.
