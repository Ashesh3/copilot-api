# Pre-compaction Payload Budget Design

## Problem

GitHub Copilot rejects serialized Responses requests above an upstream body ceiling near 32 MiB. The existing compaction-boundary fix only removes history before an already-created compaction marker. A first or manual compaction turn has no marker yet.

For Responses WebSocket clients, the gateway also expands `previous_response_id` against its local response snapshot. In the observed incident, a 5.4 KiB compaction continuation became a 37.9 MiB upstream request and GitHub returned `413 failed to parse request`. The deployed compaction-boundary code was present and working; it had no boundary it could apply to this request.

## Goals

- Keep compaction-generation requests below a 30 MiB serialized payload budget, leaving headroom below the observed upstream ceiling.
- Apply the budget to Codex compaction turns sent through HTTP or Responses WebSocket and to `/responses/compact` requests.
- Preserve conversational text, developer instructions, tool commands, call IDs, item ordering, compaction markers, and the current bootstrap context.
- Reduce only payload material that is disproportionately large and replaceable during summarization: inline binary/image data and tool-result bodies.
- Leave ordinary Responses turns and already-small compaction turns byte-for-byte unchanged at the reduction boundary.
- Emit deterministic local errors if the payload cannot fit without violating the preservation guarantees.

## Non-goals

- Raising Cloudflare, nginx, Bun, or GitHub body limits.
- Dropping arbitrary conversation turns or developer instructions.
- Recursively asking another model to summarize chunks before the actual compaction request.
- Changing post-compaction marker pruning or account-affinity behavior.
- Deploying production as part of this pull request.

## Request Detection

The gateway will treat a request as a compaction-generation turn when either condition is true:

1. It entered through `/responses/compact`.
2. Its Responses `client_metadata` contains Codex turn metadata whose `request_kind` is `compaction`.

Codex turn metadata may be an object or a JSON string stored under `x-codex-turn-metadata`. Malformed or unrelated metadata is not a compaction signal and must not change request handling.

The same detection helper will cover HTTP and WebSocket requests at their shared Responses transport boundary. WebSocket reduction therefore happens after continuation rehydration and existing compaction-marker expansion. Final enforcement happens after attachment normalization and request sanitization, because that is the exact representation serialized upstream.

## Payload Budgeting

The production budget is 30 MiB measured with `Buffer.byteLength(JSON.stringify(payload), "utf8")`. The reducer receives the complete outbound Responses payload so non-input fields are included in the measurement. It returns reduction statistics alongside the fitted payload: original bytes, final bytes, omitted binary blocks, and truncated tool-output bytes.

The reducer does nothing when the serialized payload is already within budget. When reduction is required, it works in two stages.

### Stage 1: Inline binary and image elision

Inline `input_image`, `input_file`, and equivalent image/file blocks nested in tool outputs are replaced with a short text note that records the original block type and that its bytes were omitted for compaction. External textual URLs may remain when they do not embed data. Item order and surrounding text remain unchanged.

### Stage 2: Largest-first tool-output truncation

Only tool-result bodies are candidates: `function_call_output`, `custom_tool_call_output`, and their string or content-array output fields. Tool calls and command input are never truncated.

Candidates are measured in UTF-8 bytes and processed largest first. Each truncated result retains:

- its item type, ID, call ID, status, and metadata;
- a bounded prefix and suffix of the original textual output; and
- a deterministic marker stating how many UTF-8 bytes were omitted during compaction.

The reducer removes only as many bytes as needed to satisfy the full-payload budget. UTF-8 boundaries are respected. Content arrays retain their ordering, non-binary structure, and text blocks; only the largest reducible text portions are shortened.

If binary elision and safe tool-output truncation cannot bring the payload below the budget, the gateway returns a local `413` explaining that preserved conversational content alone exceeds the safe compaction budget. It does not forward a request known to fail and does not silently delete preserved content.

## Integration Points

- A focused Responses utility module owns compaction detection, byte measurement, binary elision, and tool-output fitting.
- `src/services/copilot/create-responses.ts` detects HTTP and WebSocket compaction turns and enforces the final budget after attachment normalization and request sanitization.
- `src/routes/responses/compact-handler.ts` pre-fits the model payload used to generate the compacted summary so both native Responses and ChatCompletions fallback paths are bounded, then explicitly requests final transport enforcement for the native path.
- Existing `expandCompactionItems` behavior remains unchanged.

Reduction logs contain counts and byte sizes only. They never include request content, tool output, credentials, or encoded binary data.

## Error Handling

Invalid Codex metadata is ignored rather than failing an otherwise valid request. A payload that remains over budget after all allowed reductions raises an explicit typed HTTP error with status 413. WebSocket handling converts that error through the existing terminal error-frame path, so the client receives one deterministic failure instead of retries against the upstream ceiling.

## Testing

Testing follows red-green TDD and covers:

- metadata detection for object, string, malformed, and non-compaction forms;
- no mutation for ordinary turns and small compaction turns;
- binary/image elision without loss of neighboring text or item order;
- largest-first tool-result truncation with preserved IDs, call IDs, commands, prefix, suffix, and UTF-8 validity;
- deterministic local 413 when preserved text alone exceeds the budget;
- an actual greater-than-32-MiB WebSocket continuation that rehydrates to an oversized compaction request and reaches the mocked upstream below 30 MiB;
- `/responses/compact` using the same fitted payload behavior; and
- existing post-marker bootstrap and tool-retention regressions.

Focused tests, the full Bun suite, type checking, lint, build, and `git diff --check` must pass before publishing the draft pull request.

## Rollout and Verification

The pull request remains focused on request preparation and tests. After merge, production deployment should use the repository's normal `update.sh` workflow. Live verification should replay a synthetic request above the former ceiling and confirm an upstream success, a final serialized body below 30 MiB, preserved tool/bootstrap semantics, and no reduction on an ordinary control request.
