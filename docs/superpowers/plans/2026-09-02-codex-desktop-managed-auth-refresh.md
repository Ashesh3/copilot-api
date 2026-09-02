# Codex Desktop Managed Authentication Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a managed Codex Desktop refresh flow and user-friendly Windows identity generation without binary patching or interception.

**Architecture:** A pre-auth Hono route validates a versioned refresh token that carries the existing synthetic JWT and authorizes it through the enabled managed digest registry. The PowerShell generator discovers or prompts for friendly Windows identity fields, emits that refresh token, and the tracked Nginx templates expose only the exact refresh path.

**Tech Stack:** TypeScript, Hono, Bun tests, PowerShell 5.1/7, Nginx templates, Markdown.

**Spec:** `docs/superpowers/specs/2026-09-02-codex-desktop-managed-auth-refresh-design.md`

## Global Constraints

- No Codex binary or `app.asar` patching.
- No proxy, interceptor, loopback service, or broad hostname redirection.
- Store only SHA-256 JWT digests server-side.
- Preserve unrelated Codex configuration and existing auth backups.
- Use strict TypeScript and `~/*` source imports.

---

### Task 1: Refresh Token Contract and Endpoint

**Files:**
- Create: `src/lib/codex-desktop-refresh.ts`
- Create: `src/routes/codex-auth/route.ts`
- Create: `tests/codex-desktop-refresh-route.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `trustedJwtDigestStore.findEnabledCredential(rawCredential)`.
- Produces: `parseCodexDesktopRefreshToken(value)` and `codexAuthRoutes` mounted at `/v1/codex/auth`.

- [ ] **Step 1: Write failing route and token-contract tests** for a valid enabled JWT, disabled/unknown JWT, malformed envelope/JWT, wrong grant/client/media type/method, and no-store response headers.
- [ ] **Step 2: Run `bun test tests/codex-desktop-refresh-route.test.ts`** and confirm failures are caused by the missing route/implementation.
- [ ] **Step 3: Implement the minimum parser, validation, OAuth response, and pre-auth route registration.**
- [ ] **Step 4: Re-run the focused test file** and keep the complete output.

### Task 2: Windows Identity and Refresh-Aware Auth Script

**Files:**
- Modify: `scripts/enable-codex-desktop-chatgpt-auth.ps1`
- Modify: `tests/codex-desktop-auth-script.test.ts`

**Interfaces:**
- Consumes: optional `-FullName`, optional `-Email`, Windows account providers, and interactive `Read-Host` only when input is available.
- Produces: friendly JWT identity claims and `local_codex_v1.<base64url JWT>` refresh tokens.

- [ ] **Step 1: Add failing behavioral tests** for explicit identity, Windows-discovered identity, missing-value prompt input, empty prompt fallback, non-interactive fallback, identifier normalization, and refresh-token decoding.
- [ ] **Step 2: Run `bun test tests/codex-desktop-auth-script.test.ts`** and verify the new cases fail for the intended missing behavior.
- [ ] **Step 3: Implement identity discovery, prompt/default handling, normalized identifiers, profile name, and refresh envelope generation without printing secrets.**
- [ ] **Step 4: Run the script tests under all detected PowerShell engines** through the existing Bun suite.

### Task 3: Exact Nginx Publication

**Files:**
- Modify: `nginx/sites-available/public-domain.conf.template`
- Modify: `nginx/sites-available/codex-desktop-spoof.conf.template`
- Modify: `tests/nginx-security-config.test.ts`

**Interfaces:**
- Consumes: application `POST /v1/codex/auth/refresh`.
- Produces: exact POST-only publication on public and trusted Codex host templates.

- [ ] **Step 1: Add failing Nginx policy tests** asserting both templates publish the exact path, deny other methods, and retain default denial.
- [ ] **Step 2: Run `bun test tests/nginx-security-config.test.ts`** and confirm the expected missing-location failures.
- [ ] **Step 3: Add the two exact Nginx locations** with request buffering disabled and no catch-all expansion.
- [ ] **Step 4: Re-run the Nginx test file.**

### Task 4: Canonical Procedure and Stale Documentation Cleanup

**Files:**
- Create: `docs/codex-desktop-managed-auth.md`
- Modify: `README.md`
- Modify: `nginx/README.md`

**Interfaces:**
- Consumes: the implemented endpoint, environment setting, script parameters, and Nginx locations.
- Produces: one canonical future runbook linked from the root README.

- [ ] **Step 1: Replace obsolete random-refresh/no-environment wording** in the current operational docs.
- [ ] **Step 2: Document prerequisites, gateway rollout, environment setup, identity discovery/prompts, digest registration, restart, validation, rollback, and troubleshooting.**
- [ ] **Step 3: Search current operational documentation** for conflicting `auth.json`, refresh-token, and environment-variable instructions and remove or redirect them.

### Task 5: Verification and Review

**Files:**
- Verify all changed files.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: reviewable, tested branch.

- [ ] **Step 1: Run focused test files in fresh Bun processes.**
- [ ] **Step 2: Run `bun test`, `bun run typecheck`, `bun run build`, changed-file lint, and `git diff --check`.**
- [ ] **Step 3: Review the diff against the spec and correct every Critical or Important finding.**
- [ ] **Step 4: Repeat the complete verification after review fixes.**
