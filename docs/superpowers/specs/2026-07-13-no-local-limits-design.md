# No Local Limits Design

## Problem

The gateway currently imposes several limits independently of GitHub Copilot:

- Nginx request pacing returns `429 Too Many Requests`.
- The application exposes an optional token-bucket limiter through
  `--rate-limit` and `--wait`.
- WebSocket routes cap connections and concurrent work.
- Voice routes cap connection count, audio size, duration, idle time, and
  hourly traffic.
- Bun and Nginx configuration adds explicit body, frame, timeout, lifetime,
  and backpressure boundaries.
- Dashboard login and API authentication use different failure thresholds and
  time windows.

Production logs confirm that Nginx rejected Codex Desktop Responses WebSocket
upgrades with locally generated `429` responses. These responses occurred
before requests reached the application or GitHub Copilot.

## Required Policy

The gateway must not enforce local pacing, quotas, budgets, concurrency caps,
request or frame size caps, workload caps, idle or lifetime limits, or
application-generated `429` responses.

The only request-frequency enforcement retained by the gateway is IP banning
for repeated failed authentication:

1. A failed credential check records one failure for the resolved client IP.
2. Failures remain relevant for a rolling 24-hour window.
3. The third failure within that window bans the IP.
4. The ban lasts 24 hours from the third failure.
5. Banned requests receive the existing uniform `401 Unauthorized` response,
   never `429`.

GitHub Copilot or another upstream provider may still return `429`. The gateway
must preserve upstream error handling and account failover behavior; it must
not rewrite an upstream response to make it appear local.

## Authentication Scope

The shared failure tracker applies to:

- Every API route already protected by the gateway credential middleware.
- OAuth authorization attempts that require the gateway key.
- Dashboard first-time setup with an incorrect gateway key.
- Dashboard login with an incorrect administrator password or other invalid
  login credentials.

Missing credentials count as failed credentials on protected routes.
Successful authentication does not erase earlier failures because the policy
counts incorrect attempts within a rolling window.

Public routes do not record authentication failures because they do not require
credentials.

## Unified IP Ban State

The existing API-key tracker and dashboard login tracker will be replaced with
one in-memory IP security service.

Each normalized IP entry stores:

- Failure timestamps still inside the rolling 24-hour window.
- An optional `bannedUntil` timestamp.

On each check, expired failure timestamps are pruned. An expired ban is removed
automatically. Recording the third active failure sets `bannedUntil` to 24
hours after that failure.

The tracker continues to use the trusted socket-peer and proxy resolution
logic already implemented in `ip-blocker.ts`; client-supplied forwarding
headers remain untrusted unless the actual peer is an approved proxy.

Explicit IP leases and managed allowlists continue to bypass bans where the
existing route policy permits them. They are authorization features, not rate
limits.

## Local Limit Removal

### Application

Remove:

- The `--rate-limit` and `--wait` CLI options and associated state.
- The token-bucket implementation and all `checkRateLimit` calls.
- Locally generated HTTP or WebSocket `429` responses.
- Per-principal and global WebSocket connection caps.
- Concurrent WebSocket turn caps.
- Voice hourly byte budgets.
- Application-defined frame, audio, snapshot, payload, idle, duration, and
  lifetime caps.
- Bun WebSocket payload and backpressure limits configured by this project.

Protocol validation that is not a capacity policy remains. Examples include
valid JSON, required message types, credential validation, origin validation,
CSRF validation, OAuth state/PKCE validation, and well-formed identifiers.

Session expiration and one-use security credentials remain because they are
authentication semantics rather than traffic or resource limits.

### Nginx

Remove:

- `limit_req_zone`, `limit_req`, rate-limit placeholders, and configured
  `limit_req_status`.
- Project-defined request-body limits.
- Project-defined client, proxy, send, and streaming timeouts.

Where Nginx requires an explicit setting to avoid its default request-body
limit, use its unlimited configuration. Do not add replacement pacing,
connection, request-count, or bandwidth controls.

Route allowlists, method restrictions, TLS, security headers, trusted-proxy
handling, buffering behavior required for streaming, and default-deny routing
remain.

## Error Behavior

- Invalid or banned credentials: uniform `401` authentication response.
- Unsupported methods or unpublished routes: existing `4xx` behavior.
- Invalid protocol data: existing validation error.
- Upstream `429`: propagated or handled by existing upstream account-routing
  behavior.
- The gateway itself must have no code path whose policy outcome is `429`.

## Testing

Tests must prove:

1. Three failures inside a rolling 24-hour window cause a 24-hour ban.
2. Failures older than 24 hours are pruned.
3. The ban expires 24 hours after the third failure.
4. API, OAuth, dashboard setup, and dashboard login use the same tracker.
5. Every protected API route records failed credentials.
6. Public routes do not record failures.
7. Successful authentication does not clear prior failures.
8. No application route, WebSocket upgrade, or WebSocket message generates a
   local `429`.
9. Nginx templates contain no request-rate directives or placeholders.
10. CLI help and documentation contain no local rate-limit options.
11. Upstream `429` handling and account failover tests continue to pass.

## Deployment Verification

Before production cutover:

- Render and validate Nginx configuration with `nginx -t`.
- Confirm `nginx -T` contains no `limit_req`, `limit_req_zone`,
  `limit_conn`, or locally configured `429` policy.
- Confirm the application starts without rate-limit options or state.
- Send bursts of authenticated HTTP and WebSocket traffic and confirm no local
  `429` occurs.
- Verify three incorrect protected-route credentials ban the source IP and
  that banned requests return `401`.
- Verify upstream-originated error handling still behaves as before.

Production deployment must preserve the existing environment-only
`COPILOT_API_KEY_AUTH` configuration and must not edit deployment `.env`
files.
