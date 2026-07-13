# Security policy and remediation record

## Reporting a vulnerability

Use a private GitHub security advisory for vulnerabilities or accidental secret
exposure. Do not place credentials, raw authorization headers, cookies, prompt
content, or provider keys in a public issue.

This project is an unofficial compatibility gateway. Reproduce reports against
the current `master` branch when possible. If a published package or image is
affected, include its exact version or digest.

## Current security boundaries

- Traffic-shaping configuration (`replacements` and `model-redirects`) is
  mutable only through `/dashboard/api/*` under an administrator session cookie
  plus CSRF/Origin checks. Inference credentials cannot list or rewrite those
  rules (CS-02).
- The gateway key protects normal inference traffic and bootstraps OAuth and
  administrator login. `COPILOT_API_KEY_AUTH` is the only environment-based
  gateway-key source.
- OAuth codes and tokens are opaque, scoped, stored as digests, bound to S256
  PKCE/client/redirect/state, rotated on refresh, and revocable. OAuth never
  returns the gateway key. Claude's `create_api_key` compatibility route mints a
  separate inference-only credential.
- The dashboard requires the gateway key plus an Argon2id administrator
  password at login. A server-side Secure/HttpOnly session is then sufficient
  for dashboard workflows; there is no second password prompt. Mutations still
  require the SameSite CSRF cookie, matching header, and approved Origin.
- Provider keys and sensitive custom headers are write-only through dashboard
  APIs. Configuration export, debug storage, and request logging redact
  recognized secret fields and headers.
- Remote Control uses short-lived, one-use, administrator/session-bound
  WebSocket tickets. Voice and Responses WebSockets authenticate before upgrade
  and apply connection, frame, lifetime, backpressure, and workload limits.
- Direct Connect is disabled by default. The only public health route is exact
  `GET /health/health`.
- Forwarding headers are honored only when the actual socket peer is in
  `COPILOT_TRUSTED_PROXY_CIDRS`. Successful authentication never permanently
  adds a client IP to the managed allowlist.
- User regular expressions run through RE2-compatible matching with bounded
  rule/input schemas. Usage details retain seven days of minute/model aggregates
  while lifetime totals remain cumulative.

## 2026 public-exposure remediation

| ID | Status | Current resolution |
| --- | --- | --- |
| F-01 | Resolved | OAuth refresh no longer returns the gateway key. Opaque scoped access/refresh tokens, PKCE-bound one-use codes, rotation, replay-family revocation, and digested persistence replaced the simulated bearer exchange. |
| F-02 | Resolved | Dashboard authority moved to gateway-plus-password cookie sessions. Gateway credentials alone cannot access dashboard APIs; provider secrets are write-only and debug/export paths redact recognized secrets. |
| F-03 | Resolved | Remote Control requires short-lived, one-use, administrator/session-bound WebSocket tickets with Origin and resource limits. |
| F-04 | Resolved | Only exact metadata-free `GET /health/health` remains public. Direct Connect is disabled by default and authenticated/resource-limited when explicitly enabled. |
| F-05 | Resolved | Voice WebSockets authenticate before upgrade and enforce Origin (when supplied), frame/audio/duration/idle/concurrency/cost limits, cleanup, and backpressure. |
| F-06 | Resolved in supplied application/edge policy | Forwarded headers are accepted only from configured socket peers; Compose binds the backend to loopback; auth does not auto-promote IPs; source-NAT public templates do not publish IP-only fallbacks. |
| F-07 | Resolved | Nginx templates use hostname-specific route/method allowlists and a final default denial instead of catch-all proxying. |
| F-08 | Resolved | Authentication failures return bounded uniform no-store responses; proxy body, connection, and I/O limits are finite. |
| F-11 | Resolved for the tracked dependency baseline | Hono, Undici, Sentry, Bun, and related runtime dependencies were upgraded; `srvx` was removed; the Bun image is digest-pinned; production audit is a CI gate. |
| F-12 | Resolved | Global wildcard CORS was removed. Optional CORS is restricted to configured exact origins and inference-only paths. |
| F-13 | Resolved | Dashboard login uses server-side Secure/HttpOnly sessions instead of browser bearer storage. Nonce CSP and browser-hardening headers protect application responses; the public Nginx template applies baseline headers to edge denials. |
| F-15 | Partially addressed; host/container scope remains operator-owned | The tracked Compose bind is loopback-only, build context excludes common secret material, and application data files use restrictive modes. Rootless/read-only filesystem, capability drops, and host resource policy are not claimed by this application audit. |
| F-17 | Resolved in application/deployment assets | Usage details retain seven-day minute/model aggregates with separate lifetime totals and coalesced atomic writes. A bounded Nginx logrotate policy is supplied and must be installed by the operator. |
| F-18 | Resolved | Replacements use RE2-compatible matching with bounded schemas; unsafe object names are rejected; the legacy inline-handler feature page was removed. |
| F-20 | Resolved for current repository settings/workflows | Runtime audit, CodeQL, dependency review, image scanning, SBOM, SHA-pinned actions, Dependabot, secret scanning/push protection, and read-only workflow defaults are enabled. Branch review count is zero for the sole maintainer; CI/CodeQL still run on pull requests. |

## Regression fixes after hardening

- Gateway authentication remains environment-only. The temporary key-file
  source and Docker key-file mount were removed; `COPILOT_API_KEY_AUTH` is the
  only supported environment source.
- CSP nonce injection now modifies only real HTML `script` and `style` opening
  tags. Embedded strings inside the single-file React bundle remain byte-for-byte
  intact, while OAuth pages retain exact validated callback `form-action`
  origins.
- The public Nginx policy treats Responses HTTP and WebSocket transports
  separately. `POST` remains the normal API method; authenticated `GET` upgrades
  on `/responses` and `/v1/responses` are forwarded, while plain GET is denied.
- Authenticated Chat Completions and Messages generation streams use a finite
  one-hour idle timeout. This fixes Claude Code disconnections caused by the
  initial hardening's two-minute shared timeout without weakening the shorter
  OAuth, admin, token-count, and other ordinary API limits. Live Nginx logs
  showed repeated `upstream timed out` entries on `POST /v1/messages` at the old
  timeout boundary; after the route-specific reload, that signature stopped.
- Administrator step-up reauthentication was removed. One valid dashboard
  session covers LLM Debug, sanitized export, provider changes, and IP policy;
  CSRF, Origin, expiry, logout, and password-change revocation remain enforced.
- The inherited unauthenticated GitHub Pages usage viewer and its workflow were
  removed from this fork. Startup output and the Windows launcher now open the
  authenticated same-origin operator dashboard.
- OAuth callback CSP remains self-only by default and adds only the validated
  localhost origin/port or `https://platform.claude.com` when that callback is
  selected. Claude Code's manual login value is the full displayed
  `code#state`, not only the query-string code.

## Deployment responsibilities

Application controls do not compensate for an exposed origin or stale edge
configuration. This record covers application and supplied edge controls, not a
complete host/container isolation audit. Operators must:

1. Bind the backend to loopback or a private container network.
2. Render the current files under `nginx/`; do not restore a catch-all
   `proxy_pass` or a POST-only Responses location.
3. Set `COPILOT_ADMIN_ORIGIN` to the exact external dashboard origin and
   `COPILOT_TRUSTED_PROXY_CIDRS` to the exact Nginx-to-application socket peers.
4. Keep Cloudflare/proxy allowlists, certificates, dependencies, and the
   deployed image current.
5. Install log rotation and monitor disk, connection, request, and upstream-cost
   usage.
6. Rotate any credential that has appeared in logs, shell history, screenshots,
   issue content, chat history, or a prior vulnerable response. Rotation is an
   operator action and is never performed automatically by updates.
7. Treat the data volume as sensitive. It can contain GitHub/provider
   credentials, configuration, digested sessions/tokens, prompts, and response
   metadata.

See `README.md` for application setup and `nginx/README.md` for edge rendering
and black-box validation.
