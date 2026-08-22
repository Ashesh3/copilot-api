# Task 3 report: Forward exact upstream error bodies

## Outcome

Implemented constructor-owned upstream HTTP failure snapshots. A non-empty,
readable native upstream `Response` now has one cached byte snapshot that is
authoritative for OpenAI-style HTTP clients, Messages HTTP clients, structured
ordinary logs, and Sentry. Status, the existing approved response-header
allowlist, and the exact received `Content-Type` are preserved without parsing,
redaction, reserialization, wrapping, or request-id injection.

Local errors, bodyless/used/locked/unreadable responses, hostile proxies,
transport/runtime failures, and synchronous stream/WebSocket metadata retain
their shaped fallback behavior. Upstream 499 short-circuits before body reading,
returns an empty response, and is not reported.

## RED evidence

Added the initial JSON, text, HTML, whitespace/CRLF, UTF-8 BOM, and binary raw
body matrix, then ran:

`bun test tests/error.test.ts tests/messages-error.test.ts tests/sentry.test.ts`

The run failed for the intended missing behavior: 6 exact upstream-body cases
failed while 99 tests passed. The existing implementation returned JSON error
envelopes and `application/json` rather than the fixture bytes and exact content
types.

The final test expansion also inverted the stale privacy assertions and covered
OpenAI, Messages, structured logging, Sentry, scrubber opacity, empty/bodyless
fallbacks, response replacement/deletion/getters, cached concurrent inspection,
missing content type, unreadable bodies, and 499.

## Implementation

- Added the discriminated `HttpErrorInspection` union and
  `UpstreamFailureSnapshot` byte-owner contract.
- Captured native `Response` status, headers, exact content type, and one clone
  during `HTTPError` construction using captured prototype intrinsics.
- Cached one full inspection promise per error and read the stored clone with
  native `arrayBuffer()` exactly once.
- Derived optional textual telemetry from owned bytes only; binary media stays a
  numeric byte array. Classification parses only a separate decoded copy.
- Rendered upstream bodies with byte-authoritative `c.body(...)` in both normal
  and Messages HTTP paths.
- Added identical `upstreamResponseBody`, `upstreamResponseBodyBytes`, and
  optional `upstreamResponseContentType` fields to structured logs and Sentry.
- Exempted only those exact upstream response body keys from Statsig, Google
  route, and nested-header scrub walkers. Sibling request/header/route fields
  remain scrubbed.
- Preserved deprecated synchronous metadata aliases for staged stream/WebSocket
  callers and updated the affected request-log fixture with the `kind`
  discriminator.

## GREEN evidence

- `bun test tests/error.test.ts tests/messages-error.test.ts tests/sentry.test.ts tests/request-id.test.ts`
  - 152 pass, 0 fail, 604 assertions.
  - Output includes expected error-reporting, retry, endpoint-fallback, and
    request-lifecycle logs from the exercised tests; it is not silent/pristine.
- `bun run typecheck`
  - Exit 0.
- `bun run build`
  - Exit 0; tsdown build completed.
- `bun run lint -- src/lib/error.ts src/lib/sentry.ts src/routes/messages/error.ts tests/error.test.ts tests/messages-error.test.ts tests/request-id.test.ts tests/sentry.test.ts`
  - Exit 0.
  - Printed the existing `baseline-browser-mapping` age advisory.
- `git diff --check`
  - Exit 0.

Per task direction, the full repository suite was not run.

## Files changed

- `src/lib/error.ts`
- `src/lib/sentry.ts`
- `src/routes/messages/error.ts`
- `tests/error.test.ts`
- `tests/messages-error.test.ts`
- `tests/request-id.test.ts`
- `tests/sentry.test.ts`

## Concerns and follow-ups

- Exact upstream bytes can only be recovered when transport call sites construct
  `HTTPError` before draining the final response; Task 4 owns those migrations.
- Stream and WebSocket terminal propagation remains deliberately synchronous and
  metadata-only in Task 3; Tasks 5-10 own async exact-body propagation there.
- Sentry/backend payload limits may truncate very large event context after the
  complete application-owned values are handed to the SDK.
