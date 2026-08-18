# Task 7 Report: Route Responses Without Protocol Loss

## Status

Complete. Responses requests now select native Responses first, then lossless
Messages, then lossless Chat. The direct Responses-to-Messages bridge preserves
the supported subset and buffers Messages results into the existing synthetic
Responses lifecycle for streaming clients.

## Implementation

- Added the pure `selectResponsesUpstreamEndpoint()` route matrix using the
  shared endpoint-support selector. Native `/responses` always wins.
- Added `responsesPayloadToAnthropic()` and
  `anthropicResponseToResponsesResult()` for text/image/PDF messages,
  function calls/results, tools/choice, instructions, max output, sampling,
  string/integer reasoning, structured output, task budgets, usage/cache,
  stop status, and requested model aliases.
- Extracted shared image/document/tool conversion into
  `anthropic-conversion.ts`; Chat and Responses use the same data-URI,
  attachment-fetch, PDF, and tool-schema paths.
- Replaced the old Responses -> Chat -> Messages PDF detour with the direct
  fidelity-gated Messages bridge.
- Preserved Chat fallback-only web-search and `apply_patch` rewrites,
  compaction fitting/waivers, cancellation, account affinity, media
  normalization, synthetic stream events, and native Responses behavior.
- Translated routes use the canonical prepared Responses clone so empty tools,
  parameter schemas, JSON schemas, and minimum output tokens normalize once.

## Parked Findings Resolved

1. Implicit message classification: a typeless record is an implicit message
   only when its role is one of user/assistant/system/developer. Omitted content
   remains lossless as empty content; missing, unknown, or non-string roles fail
   as `input_item`.
2. Chat-to-Messages fail-open conversion: unknown typed content and tools now
   fail locally with canonical blockers. Direct shared converters also fail
   closed instead of returning empty blocks or dereferencing `.function`.
3. The same audit closed malformed Responses function calls, tool
   declarations, tool-result pairing, role-incompatible media, file IDs,
   invalid PDF data, and unmappable item status before either translated route.

## TDD Evidence

- Bridge RED: `bun test tests/responses-messages-bridge.test.ts` failed because
  `~/routes/responses/messages-bridge` did not exist.
- Parked RED: the scan/route suite showed role-only messages as `input_item`,
  unknown content returned HTTP 200, and unknown tools returned HTTP 500.
- Route RED: `bun test tests/responses-endpoint-routing.test.ts` failed because
  `selectResponsesUpstreamEndpoint` did not exist.
- Additional witnessed REDs covered malformed calls/tools, integer reasoning,
  canonical preparation, raw-base64 attachments, direct helper fail-closed
  behavior, `apply_patch` routing, compaction selection, and nested
  Messages-fidelity shapes.

## Verification

- Final focused/live matrix: 427 passed, 0 failed, 1115 assertions across 17
  files, covering bridge/route/handler, Chat Messages regressions, compaction,
  WebSocket, media/WebP, cancellation, live Responses, and live tool calling.
- Non-integration suite before the final added compaction-route regression:
  1315 passed, 3 existing media skips, 0 failed across 101 files; the final
  route matrix then passed 15/15.
- Final full `bun test`: 1469 passed, 3 existing media skips, 0 failed across
  112 files, 6187 assertions.
- Conditional live Responses-to-Messages probe: passed by explicit no-op because
  the authenticated catalog advertised no Messages-only model; deterministic
  route fixtures cover the path.
- `bun run lint:all`: 0 errors, 5 pre-existing warnings.
- `bun run typecheck`: exit 0.
- `bun run build`: exit 0.
- `git diff --check`: exit 0.

## Self-Review

- Route selection is pure and does not mutate the caller/model.
- Only advertised candidates contribute blockers; unsupported failures happen
  before manual approval and upstream dispatch.
- Native Responses requests are not converted or attachment-normalized twice.
- Messages streaming is deliberately buffered, then emitted through the
  existing synthetic Responses event lifecycle.
- Compaction requests with custom/computer history retain the established Chat
  preservation path even when Messages is also advertised.
- Error blockers use fixed protocol concepts and never echo caller types,
  model IDs, tool names, content, or encrypted state.

## Concerns

- No blocking concern.
- The repository retains the five pre-existing lint warnings and three
  optional-real-media skips.

## Fix Round 1

### Findings addressed

- Chat-only hosted `web_search`, dated variants, and preview variants are now rewritten on a clone before endpoint selection; native Responses remains unchanged and preferred.
- Explicit Responses message items now require a supported role. The Messages subset rejects meaningful statuses, wrong text direction, malformed/non-image media, invalid or non-object function arguments, undeclared named choices, and orphan/mismatched/duplicate results. Shared media converters fail closed instead of inserting omission notes.
- Messages routing now blocks incompatible sampling/thinking combinations and model-unsupported string effort. Accepted temperature, `top_p`, string/integer reasoning, tools/choice, parallelism, output limits, structured output, and request context survive native wire and converted result round trips.
- Anthropic output conversion preserves original thinking/text/tool order and each thinking signature one-to-one. Synthetic streams emit reasoning summary lifecycle events and use completed/incomplete/failed terminal events.
- Buffered Messages streaming now preflushes SSE, propagates downstream cancellation through a composed abort signal, and emits no protocol events after detach.

### RED/GREEN evidence

Witnessed RED failures covered all six review groups: Chat web-search routing returned 400; explicit roles and Messages subset cases were accepted/coerced; request context and wire controls were stripped; thinking blocks were aggregated; reasoning/terminal events were missing; and the buffered stream waited for upstream headers. Focused GREEN verification passed 269/269 across route, bridge, fidelity, lifecycle, media, compaction, and Messages regression files.

### Verification

- `bun test`: 1527 passed, 3 existing media skips, 0 failed across 113 files; 6298 assertions.
- `bun run typecheck`: exit 0.
- `bun run lint:all`: 0 errors, 5 existing warnings.
- `bun run build`: exit 0.
- `git diff --check`: exit 0.

### Concerns

No blocking concern. The repository retains the same five lint warnings and three optional real-media skips.
