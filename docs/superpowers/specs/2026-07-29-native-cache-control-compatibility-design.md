# Native Messages Cache-Control Compatibility Design

## Problem

Claude Code 2.1.220 sends scoped prompt-cache markers such as
`{"type":"ephemeral","scope":"global"}` under the
`prompt-caching-scope-2026-01-05` beta. GitHub Copilot's native Messages API
accepts ephemeral cache markers but rejects the additional `scope` field.

This became visible when ToolSearch turns began using Copilot's native
`/v1/messages` endpoint. The routing is correct and must remain unchanged; the
provider boundary needs to emit the narrower Copilot wire contract.

## Reference Contract

The current GitHub Copilot client emits native Anthropic cache markers as
`{"type":"ephemeral"}`. The current Copilot API schema supports `type` and an
optional `ttl`; no `scope` field exists. Cache markers may occur throughout a
Messages request, including system blocks, message content, tools, and nested
tool-result content.

## Design

Normalize cache markers only while serializing a native Messages request.
Use a JSON serializer replacer that recognizes a property named
`cache_control` whose value is an object with `type: "ephemeral"`. Replace that
value with a new object containing:

- `type: "ephemeral"`;
- `ttl` only when it is `"5m"` or `"1h"`.

Discard all other keys on that cache marker, including Claude Code's `scope`.
Do not mutate the caller's payload. Do not alter objects merely because they
contain a `type` field, and do not add message-position, ToolSearch, client, or
model-specific branches.

The existing top-level native Messages allowlist remains responsible for
dropping unsupported request fields. This normalization is the corresponding
nested wire-contract boundary.

## Stream Resets

This change does not modify `COPILOT-API-17` behavior. GitHub's official
clients recover incomplete streams only before meaningful output. The observed
failures occurred after HTTP 200 and substantial streamed output, so replaying
the request could duplicate model actions. The proxy will continue reporting
one terminal Sentry event and one sanitized in-band Anthropic error.

## Tests

Add a native Messages serialization regression that places scoped cache
markers at multiple legitimate nesting locations and verifies every forwarded
marker contains only supported keys. Include controls proving:

- supported `ttl` is preserved;
- unsupported TTL values are omitted rather than forwarded;
- an unrelated nested object with `type: "ephemeral"` is untouched;
- the input payload remains unchanged after serialization.

Run the focused native Messages tests followed by typecheck, lint, build, the
full Bun test suite, and `git diff --check` before publication.

## Scope

The implementation should change only the native Messages serialization
boundary and its tests. It must not change routing, retry budgets, streaming
replay, Sentry suppression, nginx, or production configuration.
