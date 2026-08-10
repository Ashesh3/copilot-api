# LLM Replay and Debug UX Redesign

**Date:** 2026-07-30

**Status:** Approved

## Summary

Redesign LLM Replay as a persistent split workspace with a real JSON editor on
the left and a shared, structured response inspector on the right. Improve LLM
Debug with the same response inspector, meaningful summaries for tool-only and
other non-text responses, symmetric request/response exports, and large-payload
rendering that does not freeze the page.

The existing replay endpoint and its security boundary remain intact: only
captured `POST /chat/completions` and `POST /responses` requests are replayable,
and the server rebuilds authentication from current server-side credentials
rather than captured headers.

## Problem and evidence

### Replay is a raw transport dump

`ui/src/screens/LlmReplay.tsx` currently exposes the complete request body in a
plain textarea. Its result view renders the full response in one code block and
renders every stream event as a single-line list description. Large JSON values
therefore require extensive horizontal and vertical scrolling and are difficult
to edit, compare, or understand.

This also bypasses the more capable parsing and response presentation already
used by LLM Debug.

### Tool-only responses look empty

The supplied Debug example showed `Tool calls: 1` but displayed “The response
did not contain assistant text.” The text statement is narrowly true, but the
overall empty-state treatment is misleading because the response performed a
useful tool call.

The current parser counts Responses API and Chat Completions tool calls, but it
does not return their names, IDs, or reconstructed arguments to the viewer. The
viewer consequently has no meaningful content to show when `assistantText` is
empty.

The supplied log expired from the ten-minute in-memory debug store before this
design was written. The diagnosis is based on the user-provided response
details, the visible `Tool calls: 1` count, and the current parser/viewer code.

### Pretty/raw switching blocks the UI

Fresh production records showed request bodies from hundreds of kilobytes to
more than 2 MB. Raw mode mounts Astryx `CodeBlock` for the entire body, which
eagerly syntax-highlights a large document. Pretty mode can mount a recursive
JSON tree with every child of an expanded high-cardinality container. Switching
formats unmounts one expensive representation and synchronously mounts the
other on the main thread.

The redesign must bound DOM work and use a virtualized editor/viewer for large
text documents.

## Goals

- Make edit, replay, and compare the obvious primary workflow.
- Make request JSON readable and safely editable without hiding any fields.
- Show final assistant text assembled from stream events as the primary result.
- Explain and display useful non-text output, especially tool calls.
- Preserve individual stream-event inspection with formatted payloads.
- Add clear exports for both the request and response sides in Debug and Replay.
- Keep multi-megabyte bodies interactive when loading and switching views.
- Share parsing, output presentation, and export behavior between Debug and
  Replay.

## Non-goals

- A schema-specific form editor for messages or model parameters.
- Persistent replay history, request diffs, or server-side replay storage.
- Replay support for endpoints beyond the existing safe allowlist.
- Displaying or reconstructing private chain-of-thought. Existing reasoning
  summaries remain a distinct output section.
- Changing the LLM Debug list or its retention policy.

## 1. Replay workspace

### Layout

Desktop uses the approved persistent split workspace:

- Left: `Request JSON`, using approximately 55% of the available width.
- Right: `Replay result`, using approximately 45% of the available width.
- Each pane has `min-width: 0` and its own vertical and horizontal scrolling.
- The workspace consumes the useful viewport height so the browser page itself
  does not become a multi-screen transport dump.
- Below approximately 960 px, the panes stack with the request first and result
  second.

The endpoint badge and path remain visible above the workspace. `Run Replay` is
the primary page action and remains visible while working in either pane.

### JSON editor

Use CodeMirror 6 directly through a small React wrapper. It provides viewport
virtualization, JSON syntax highlighting, line numbers, matching brackets,
search, selection, undo/redo, and diagnostics without producing one DOM node
for every token in a multi-megabyte document.

Editor behavior:

- Valid source JSON loads exactly as captured. The later Raw LLM Debug Capture
  design dated 2026-08-10 supersedes automatic initial formatting.
- The editor is the canonical request state; there is no second structured form
  that can drift from it.
- `Format` parses and re-formats the current document without changing key
  order.
- `Reset` restores the originally captured body after confirmation when edits
  exist.
- `Copy` copies the current edited body.
- JSON diagnostics identify the exact line and column when possible.
- A valid JSON scalar or array is still invalid for replay; the root must be an
  object.
- A missing or blank `model` is shown as a validation error.
- `Run Replay` is disabled while JSON is invalid, the root is not an object, the
  model is missing, or a replay is already running.
- Invalid source bodies load as exact text so they can still be repaired.
- Editor contents remain in React memory only and are not written to local
  storage.

### Running and result replacement

Submitting posts the current editor text to the existing replay endpoint.
Success replaces the right-side result and selects its `Output` tab. The editor
and its scroll/selection state remain intact, so the operator can immediately
edit and run again.

This version intentionally shows the current attempt rather than adding replay
history. A failed replay displays an error banner in the result pane while
preserving both the edited request and the most recent successful result, which
is then labeled `Last successful result`.

## 2. Shared response inspector

LLM Debug and LLM Replay use one response-inspection component and one
normalization model. The component accepts the raw body plus HTTP status,
status text, headers, and timing metadata. It parses the body once and renders
only the selected tab.

### Tabs

The inspector has four tabs:

1. `Output` — final assistant-facing output and reasoning summary.
2. `Details` — response metadata, token usage, service data, and HTTP headers.
3. `Events (N)` — individual stream-event inspection.
4. `Raw` — the exact captured response body in a virtualized read-only viewer.

`Output` is the default after loading a response or completing a replay. Tab
state is local to the response pane. Switching tabs does not rebuild hidden
representations.

### Normalized output model

Extend `ParsedResponsesBody` with ordered, meaningful output items instead of
only `assistantText` and `toolCallCount`:

```ts
interface ParsedToolCall {
  arguments: string
  argumentsJson: JsonValue | null
  callId: string | null
  id: string | null
  name: string | null
  outputIndex: number
}

interface ParsedResponsesBody {
  assistantText: string
  copilotUsage: JsonRecord | null
  errorMessage: string | null
  events: Array<ResponsesStreamEvent>
  isPartial: boolean
  reasoningText: string
  response: JsonRecord | null
  status: string | null
  toolCalls: Array<ParsedToolCall>
  usage: JsonRecord | null
}
```

`toolCallCount` becomes derived from `toolCalls.length` at presentation sites.
If compatibility makes a temporary count field useful during implementation,
it must always equal the array length and is removed before completion.

`errorMessage` normalizes Responses API error events, terminal response errors,
and Chat Completions error objects so an error remains visible even when there
is no terminal response object.

### Stream reconstruction

Responses API tool calls are assembled from all available authoritative and
incremental forms:

- `response.output_item.added`
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.output_item.done`
- terminal response `output` items

Calls are keyed by `item_id`, `call_id`, or `output_index`, in that order. A
`done` value or terminal output item replaces accumulated deltas rather than
duplicating them. Calls retain response output order.

Chat Completions tool calls are assembled from
`choices[].delta.tool_calls[]` or non-streaming `message.tool_calls[]`, keyed by
choice and tool-call index. IDs, names, and argument fragments may arrive in
different chunks and must merge into the same call.

Existing assistant text behavior remains, including terminal response output,
`response.output_text.delta`/`done`, refusals, copied zero-width separators,
truncated captures, and Chat Completions content deltas. Terminal or done
values remain authoritative so deltas are not duplicated.

### Output presentation

The `Output` tab follows this order:

1. Assistant output rendered as Markdown, with `Copy output`.
2. Tool calls, each showing function name, call ID, and formatted arguments.
3. Reasoning summary in a separate collapsible section.
4. A precise fallback message only when the preceding sections are empty.

Fallback language reflects what actually occurred:

- Tool-only: `The model returned 1 tool call and no assistant message.`
- Refusal-only: show the refusal as output.
- Error: show the normalized error message and status.
- Partial capture: explain that the capture ended before a final output event.
- Truly empty completed response: `The completed response contained no
  assistant message, tool call, refusal, or error.`

Tool arguments that parse as JSON use the formatted JSON viewer. Invalid or
partial arguments remain visible as wrapped text; the UI never hides them just
because parsing failed.

LLM Debug removes the current page-wide `Body format` control. Its request card
owns a local `Pretty | Raw` control, while the response card uses the four
response-inspector tabs. Changing the request representation therefore cannot
force the response representation to rebuild, and selecting `Raw` for a
response cannot rebuild the request tree.

### Event inspection

Keep the existing event selector because it provides concise access to each
event. The event type and sequence number form each label. Selecting an event
renders only that event's payload, formatted as JSON where possible, with copy
support and wrapping. Previous/next controls may be added beside the selector
if they can use the same selected-index state without duplicating navigation
logic.

The terminal event can contain a large full response, so its payload uses the
same bounded JSON/read-only rendering rules as other bodies.

## 3. Request and response exports

Debug and Replay place an explicitly labeled export menu in each corresponding
pane or card header: `Export request` on the request side and `Export response`
on the response side. A generic page-level `Export` action is avoided because
it is ambiguous once both directions are supported.

### Request formats

Keep the existing formats:

- `cURL command` (`llm-request-<id>.curl`)
- `Request JSON` (`llm-request-<id>.json`)
- `Raw HTTP request` (`llm-request-<id>.http`)

In Debug these use the captured request. As of the approved Raw LLM Debug
Capture design dated 2026-08-10, that request contains exact raw values rather
than the redacted values assumed by this earlier design. In Replay they use the
current edited body plus the captured method, URL/path, and raw headers. JSON
export is disabled for invalid JSON; cURL and raw HTTP can still preserve the
exact edited text.

### Response formats

Add the approved response equivalents:

- `Assistant output` (`llm-response-<id>.md`)
- `Response JSON` (`llm-response-<id>.json`)
- `Raw HTTP response` (`llm-response-<id>.http`)

Assistant output contains the final assistant Markdown. When tool calls are
present, it appends a `Tool calls` section with function names, IDs, and fenced
formatted arguments. A tool-only response therefore produces a useful file
rather than an empty export. Reasoning summaries are excluded because they are
not assistant output.

For an ordinary JSON response, `Response JSON` is the original parsed document
with two-space indentation. For SSE or Chat Completions streams, it is a
normalized JSON document containing:

```json
{
  "status": "completed",
  "assistantText": "...",
  "toolCalls": [],
  "reasoningText": "...",
  "errorMessage": null,
  "usage": {},
  "copilotUsage": {},
  "response": {},
  "events": []
}
```

Null or unavailable fields remain `null`; they are not invented. Including the
events makes the normalized export lossless at the parsed-event level, while
the raw HTTP export preserves exact transport bytes/text.

`Raw HTTP response` starts with
`HTTP/1.1 <status> <statusText>`, followed by captured headers, a CRLF separator,
and the exact response body. `HTTP/1.1` is an export framing convention because
the debug log does not retain the negotiated HTTP protocol version.

The Markdown and JSON options are disabled when their required normalized
content is unavailable. Raw HTTP is available whenever a response exists.

Export builders and download logic move into testable shared helpers rather
than remaining embedded in a request-only React component.

## 4. Large-payload performance

### Virtualized text documents

Use CodeMirror for the editable request and for read-only raw/formatted text
documents. CodeMirror renders only the visible viewport, so syntax highlighting
does not create token spans for the entire multi-megabyte body.

The read-only viewer supports copy, search, wrapping, and JSON highlighting
when the document is JSON. SSE and other bodies use plain-text mode.

### Bounded JSON trees

Interactive JSON trees remain useful for small and medium documents. Container
children are rendered in pages of 100. A `Show 100 more` control advances the
visible window without mounting the remaining children. For a document above
250 KiB or a parsed tree above 5,000 nodes:

- Initial disclosure expands only the root.
- High-cardinality containers still render only their first child page.
- Recursive `Expand all` is unavailable and explains that it is disabled for a
  large document.
- Operators can expand individual paths normally.

Node counting stops as soon as the 5,000-node threshold is exceeded; it does
not fully traverse a large tree merely to classify it.

### Parse and mount discipline

- A body is parsed once per body identity in the owning response/request view.
- Pretty/raw tab changes reuse the normalized parse result.
- Only the selected response tab mounts.
- Only the selected event payload is formatted and mounted.
- Large source formatting happens only through explicit `Format`, not on
  initial load or every keystroke.
- Live diagnostics debounce expensive whole-document validation while keeping
  CodeMirror editing responsive.
- No CI test relies on a fragile millisecond threshold; deterministic tests
  assert bounded child rendering and selected-tab mounting, while browser QA
  measures interaction on production-sized fixtures.

## 5. Component boundaries

The implementation should use focused shared units:

- `JsonCodeEditor` — CodeMirror lifecycle, editing, validation display, format,
  and reset integration.
- `VirtualizedCodeViewer` — read-only CodeMirror configuration for raw and
  formatted text.
- `JsonTreeViewer` — structured JSON inspection with bounded child pages and
  large-document disclosure rules.
- `ResponseInspector` — tabs and presentation of one normalized response.
- `responses-body.ts` — transport recognition and normalization only; it does
  not render UI.
- `http-export.ts` — pure request/response export builders and download helper.
- `RequestExportMenu` and `ResponseExportMenu` — small UI wrappers over shared
  export builders.
- `LlmDebug` — debug record loading, polling, and request/response composition.
- `LlmReplay` — editor state, validation, replay submission, and current result
  state.

The generated `src/routes/dashboard/page-generated.ts` remains build output and
must be regenerated through `bun run build:ui`, never hand-edited.

## 6. Data flow

### Debug

1. Load the captured detail from `/dashboard/api/llm-debug/:id`.
2. Initialize the request viewer from the exact captured body.
3. Normalize the response body once if a response exists.
4. Render request and response cards; each owns its clearly labeled export
   menu.
5. Format or mount only the active response tab and selected event.

### Replay

1. Load the exact captured request body into the editor without formatting it.
2. Validate the current editor document client-side.
3. Submit exact editor text to `/dashboard/api/llm-debug/:id/replay`.
4. Keep server-side validation and safe reauthentication as the authority.
5. Normalize the returned raw body with the same parser used by Debug.
6. Select `Output` and expose the same details, events, raw view, and response
   exports.

## 7. Error and edge-case behavior

- Source entry missing or expired: retain the existing not-found state and a
  path back to the Debug list.
- Invalid JSON: show line/column diagnostics; do not alter the document or send
  a replay.
- Valid non-object JSON: show `Replay body must be a JSON object.`
- Missing model: show `model is required.`
- Replay API failure: show status/message in the result pane and preserve the
  last successful result.
- Unrecognized response body: `Output` explains that no supported structured
  response was recognized; `Raw` and raw HTTP export remain available.
- Truncated SSE: show assembled content collected so far, mark it partial, and
  retain the readable event list.
- Malformed tool arguments: show exact accumulated text and do not discard the
  call.
- Empty response body: show an explicit empty-body state rather than a parsing
  error.
- Clipboard or download failure: surface an error toast instead of reporting
  success unconditionally.

## 8. Accessibility and responsive behavior

- Tabs, editor actions, event selector, and export menus are keyboard reachable
  and have explicit accessible names.
- Validation is associated with the editor and announced without moving focus
  on each keystroke.
- Focus remains in the request editor after `Format` and after replay
  completion.
- Status is never communicated only by color.
- Wrapped output prevents page-level horizontal scrolling.
- At the responsive breakpoint, stacked panes keep their local scroll areas and
  all actions remain visible.

## 9. Testing and verification

### Parser tests

Extend `tests/responses-body.test.ts` with:

- terminal Responses API function calls;
- added/delta/done argument assembly;
- authoritative done values replacing deltas;
- multiple ordered tool calls;
- Chat Completions tool-call fragments;
- tool-only, text-plus-tool, refusal, error, partial, and truly empty outcomes;
- malformed arguments that remain inspectable;
- existing text and reasoning reconstruction regressions.

### Editor, tree, and export tests

Add focused pure-helper tests for:

- formatting without key reordering;
- line/column diagnostics;
- object and model validation;
- 100-child JSON batches and threshold classification;
- request cURL/JSON/raw HTTP output;
- direct and streamed response JSON output;
- Markdown output with tool-only responses;
- raw HTTP response status, headers, CRLF boundary, and exact body.

### Dashboard integration tests

Update `tests/llm-debug-dashboard.test.ts` to verify the generated dashboard
contains the editor, both explicit export menus, response formats, and replay
workspace. Existing replay endpoint tests continue to prove fresh
authentication and safe path validation.

### Build and browser verification

Run:

```text
bun test tests/responses-body.test.ts tests/json-tree.test.ts tests/llm-debug-dashboard.test.ts
cd ui && npm run typecheck
bun run lint -- ui/src tests/responses-body.test.ts tests/json-tree.test.ts tests/llm-debug-dashboard.test.ts
bun run build:ui
bun run build
```

After the UI build, verify the generated inline script parses successfully.
Browser QA uses fresh records with approximately 2 MB request bodies, hundreds
of kilobytes of SSE response data, tool-only output, ordinary text output, and
at least 100 events. It verifies:

- editing and formatting remain responsive;
- invalid JSON blocks replay with a useful location;
- output appears without mentally joining events;
- tool-only output explains and shows the tool call;
- event selection formats one event without widening the page;
- Pretty/Raw and response-tab switching do not freeze the page;
- request and response exports contain the expected data;
- desktop split and narrow stacked layouts are usable.

Wall-clock checks are recorded during browser QA, but CI relies on deterministic
render bounds rather than machine-dependent timing assertions.

## 10. Acceptance criteria

- Replay opens with the exact captured request text; operators can explicitly
  format valid JSON when desired.
- Operators can edit, format, validate, reset, copy, and replay from one screen.
- Request and result remain simultaneously visible on desktop and stack on
  narrow screens.
- The response defaults to an assembled final output, not raw transport data.
- A tool-only response clearly shows the tool call and never looks useless or
  empty.
- Reasoning stays separate from assistant output.
- Individual stream events remain selectable and readable.
- Both request and response sides have their approved export formats in Debug
  and Replay.
- Raw HTTP response export preserves the exact body.
- Multi-megabyte bodies do not create unbounded syntax-highlight or JSON-tree
  DOM output.
- Switching Pretty/Raw or result tabs remains interactive on production-sized
  fixtures.
- Existing replay safety, fresh authentication, Debug polling, and request
  export behavior remain covered by tests.
