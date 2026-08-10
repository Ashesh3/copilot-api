# Raw LLM Debug Capture Design

**Date:** 2026-08-10
**Status:** Approved

## Summary

LLM Debug will retain and expose the exact request and response data available
at its capture boundary. It will not redact, mask, scrub, sanitize, rewrite, or
JSON-reserialize request or response URLs, headers, or bodies. The existing
administrator-session boundary and ten-minute in-memory expiry remain intact.

This is an intentional operator-diagnostics boundary: LLM Debug may contain
complete bearer tokens, cookies, API keys, session identifiers, prompts, tool
data, and model output during its retention window.

## Goals

- Preserve the final outbound request URL, header values, and body string for
  every captured Copilot transport attempt.
- Preserve the received response header values and body string for complete,
  failed-body-read, and aborted captures.
- Make the exact captured values available consistently through the detail API,
  list previews, dashboard views, bulk export, request export, and replay editor.
- Keep body-byte counts based on the preserved body string.
- Preserve the existing ten-minute retention, automatic pruning, explicit
  clearing, administrator authentication, and defensive cloning behavior.
- Document the raw-data security boundary accurately.

## Non-goals

- Removing redaction from ordinary request logs, Sentry, configuration exports,
  error reporting outside LLM Debug, or any other dashboard page.
- Persisting LLM Debug data to disk or extending its retention window.
- Replaying the originally captured authorization credential. Replay continues
  to acquire fresh server-side authorization for execution.
- Capturing transport bytes that the current JavaScript request/response APIs do
  not expose, such as HTTP framing, compressed wire bytes, duplicate response
  header lines coalesced by `Headers`, or unsupported streaming request bodies.
- Changing which Copilot endpoint paths are eligible for capture or replay.

## Capture Boundary and Exactness

`copilot-client.ts` starts one LLM Debug entry immediately before each Copilot
transport attempt. At that point it has the final attempt URL, normalized
header record, method, path, and request body representation. Each retry remains
a separate entry, so a token-refresh retry records the refreshed authorization
header for that attempt rather than modifying the earlier attempt.

The request body must be stored as the exact string supplied to
`startLlmDebugLog`. Valid JSON must not be parsed and reserialized, because that
would change whitespace and could change the diagnostic evidence. Invalid JSON
and non-JSON text are also stored unchanged. The URL and headers are copied
without value transformation.

The response capture reads `response.clone().text()` and passes the resulting
string and normalized response headers to the log. Complete and aborted
response records store those values unchanged. If the clone body cannot be
read, the record still retains the response status and raw captured headers,
plus the existing body-read error information.

Within these existing runtime representations, “raw” means:

- no `[REDACTED]` substitution;
- no removal of URL credentials or query values;
- no secret-field detection;
- no JSON parsing or reserialization; and
- no truncation introduced by LLM Debug.

## Data Flow

1. `copilot-client.ts` passes the per-attempt request data to
   `startLlmDebugLog`.
2. `llm-debug-log.ts` copies the exact request values into the ten-minute
   in-memory entry and derives model, stream status, previews, and byte counts
   without changing the stored body.
3. Response completion or abort copies the exact response body and header
   values into the same entry.
4. `getLlmDebugLog` returns a structured clone, preventing dashboard or replay
   callers from mutating the stored record.
5. The authenticated dashboard detail API returns that clone unchanged. The
   existing UI and export helpers render or format copies for presentation but
   retain access to the original captured strings.
6. Replay initializes its editor from the exact captured request body, but a
   replay execution still builds fresh server-side authorization as it does
   today.

## Error Diagnostics

Request and response payloads are the primary scope. To honor the requirement
that nothing on the LLM Debug page be redacted, transport-error diagnostic
fields shown in the same record must also stop intentionally removing URL query
strings or credentials. When a runtime error exposes a string `path`, LLM Debug
stores that string unchanged. Existing error name, message, stack, code, and
errno behavior remains unchanged.

## Security Boundary

Access remains limited to an authenticated administrator dashboard session.
Records remain process-local, are automatically pruned ten minutes after their
start time, and can be cleared immediately through the existing dashboard
action. No raw value is added to durable files, Sentry, ordinary logs, routing
telemetry, or configuration exports by this change.

Documentation must explicitly warn that LLM Debug contains raw credentials and
payloads, rather than claiming that debug storage is sanitized. Existing
statements about sanitized configuration exports and ordinary request logging
remain unchanged.

## Implementation

- Remove the sensitive-header and sensitive-field patterns and the request/
  response redaction helpers from `src/lib/llm-debug-log.ts`.
- Store request bodies, request headers, request URLs, response bodies, and
  response headers directly from the capture input.
- Compute model, stream status, previews, and body byte counts from the exact
  stored strings.
- Replace error-path sanitization with type validation only.
- Update LLM Debug tests that currently require redaction so they instead prove
  exact preservation across the in-memory layer and authenticated dashboard
  API.
- Update README and security-boundary statements that currently describe LLM
  Debug as redacted.

No dashboard source or generated bundle change is needed: the current detail,
preview, structured viewer, raw viewer, bulk export, and request-export paths
consume the data returned by the LLM Debug API without applying another
redaction layer.

## Testing

Regression tests must first fail against the current redacting implementation
and then pass after the change. They will prove:

1. Authorization, cookie, API-key, session, and interaction headers retain
   their exact values.
2. Query credentials and URL user information retain their exact captured
   value.
3. Secret-like fields at every JSON nesting level remain present.
4. Request JSON whitespace and non-JSON request text are unchanged.
5. Complete and aborted response headers and bodies remain unchanged.
6. Body-byte counts match the exact preserved strings.
7. Runtime error paths retain their complete string.
8. The authenticated dashboard detail endpoint returns the same raw values.
9. Ten-minute pruning, list previews, cloning, terminal-state handling, replay
   reauthentication, and per-attempt capture continue to work.

Focused verification covers the LLM Debug store, dashboard API, exports, replay,
and Copilot capture. Final verification includes typecheck, lint, the complete
Bun test suite, build, documentation search for stale redaction claims, and
`git diff --check`.

## Acceptance Criteria

- No LLM Debug request or response URL, header value, body field, or displayed
  transport-error path is replaced with `[REDACTED]` or otherwise sanitized.
- Exact captured request and response strings reach the authenticated detail
  API and all existing dashboard consumers.
- The ten-minute in-memory retention and administrator-only access remain
  unchanged.
- Replay displays and edits the original body but continues executing with
  fresh server-side authorization.
- Redaction outside LLM Debug remains intact and covered by its existing tests.
- Tests, typecheck, lint, build, stale-claim search, and diff validation pass.
