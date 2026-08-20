# Responses WebSocket Stream Failure Design

## Problem

Commit `1f47fe1ed7c5cc3d64b8711b9f9d9b780d48c7f9` added fail-closed
sanitization for native Responses terminal events. The sanitizer currently
requires every successful `response.completed` payload to contain the
top-level convenience field `response.output_text`.

Live Copilot Responses streams for `gpt-5.3-codex` and the `gpt-5.6` model
family return a valid completed response with:

- `type: "response.completed"`
- `response.status: "completed"`
- text inside `response.output[].content[]`
- no top-level `response.output_text`

The sanitizer therefore rewrites a successful completion to
`response.failed`. The Responses WebSocket lifecycle records the rewritten
terminal as HTTP 502, and reconnecting clients replay the completed turn.
That produces repeated assistant output followed by `Upstream Responses
stream failed.`

The existing live WebSocket integration test does not catch the regression
because it may continue from a failing native Responses model to a
chat-completions fallback model and pass when any candidate succeeds.

## Decision

Keep the fail-closed terminal sanitizer, but treat `response.output_text` as
an optional upstream convenience field.

For a structurally valid completed response:

1. Sanitize `response.output` using the existing output-item allowlist.
2. Preserve `response.output_text` when upstream supplies a string.
3. Otherwise derive `output_text` by concatenating the text from sanitized
   assistant `output_text` content blocks in output order.
4. Use an empty string when a valid completion contains no assistant text,
   such as a tool-only response.

The derived value must come from sanitized output, never from the raw
terminal object. This preserves the current privacy boundary.

## Data Flow

`createResponses()` continues parsing and sanitizing every native SSE event.
`sanitizeResponsesStreamEvent()` validates a completed event and constructs a
safe response. Its completion reader will no longer reject an otherwise valid
response solely because the raw `output_text` property is absent.

Both HTTP Responses streaming and Responses WebSocket streaming already use
this shared sanitizer. No route-specific recovery or retry is required. The
WebSocket path will receive `response.completed`, finalize the logical turn as
`COMPLETE` with status 200, and avoid sending an error frame.

## Error and Privacy Behavior

All existing completion invariants remain required:

- matching `response.completed` event and JSON types
- a non-negative sequence number
- a non-empty response ID
- `object: "response"`
- `status: "completed"`
- an output array
- valid or null usage
- `error: null`
- `incomplete_details: null`

Malformed completed events still become a sanitized `response.failed`.
Native `response.failed`, `response.incomplete`, and `error` events keep their
current behavior. Unknown terminal fields remain excluded, and no raw
upstream error or private field is exposed.

## Verification

Automated coverage will include:

- a direct sanitizer regression fixture matching the observed live Copilot
  terminal shape without `output_text`
- derivation from multiple sanitized assistant text blocks in output order
- an empty derived value for valid tool-only output
- preservation of an upstream string `output_text`
- continued fail-closed handling for malformed completed events
- a Responses WebSocket test proving the live-shaped terminal finalizes once
  as `COMPLETE`/200 without an error frame
- live integration coverage that requires a native `/responses` model to
  complete, independently from chat-only fallback coverage

Focused unit tests, the live Responses WebSocket integration test, lint, type
checking, and the build will validate the change.

## Out of Scope

- changing client reconnect policy
- retrying after a terminal event has already been delivered
- weakening terminal-event privacy sanitization
- changing endpoint selection or model routing
- changing failed or incomplete terminal semantics
