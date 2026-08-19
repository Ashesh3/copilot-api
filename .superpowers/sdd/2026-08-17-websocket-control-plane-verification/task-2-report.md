# Phase 4 Task 2 Report: No-Storage WebSocket Continuations

## Outcome

Implemented compatible Responses WebSocket continuation resolution in `40249a4` (`fix: align WebSocket continuation errors`) and closed the first review round in `4ae1e17` (`fix: preserve WebSocket continuation history`).

The pure protocol resolver now distinguishes omitted, known, stale, and malformed `previous_response_id` values before dispatch. Omission starts a new local thread. Only snapshots created on the current WebSocket connection can continue. Stale or external IDs return the fixed recoverable code `previous_response_not_found` without echoing the supplied ID. Malformed IDs return `invalid_request_error`.

Known continuations are rehydrated without storage or direct upstream state. The resolver and completed-snapshot path deep-clone their inputs. String input is converted to an explicit Responses user message with `input_text`; snapshot history, completed assistant output, and current unacknowledged input are preserved in order for every string/array combination. The upstream `previous_response_id` and synthetic `generate` fields remain cleared.

## Files

- Updated `src/routes/responses/websocket-protocol.ts` with the pure continuation result type, ID validation, immutable rehydration, canonical mixed-shape input merge, and the no-storage external-ID limitation.
- Updated `src/routes/responses/websocket.ts` so the dispatcher consumes the pure result and completed response snapshots use the shared lossless merge.
- Updated `src/routes/responses/websocket-lifecycle.ts` so `WebSocketRequestError` stores explicit protocol error code/type metadata.
- Updated `tests/responses-websocket-protocol.test.ts` with pure ID, merge, invalid-input, and mutation-isolation coverage.
- Updated `tests/responses-websocket.test.ts` with recoverable error/socket behavior and two-turn wire history coverage.

## Original TDD Evidence

The original tests were added before the Task 2 production changes.

- Focused continuation command:
  - `bun test tests/responses-websocket-protocol.test.ts tests/responses-websocket.test.ts -t "previous_response|continuation|warmup"`
  - Result: 15 pass, 9 fail.
  - The pure resolver export was absent in five cases.
  - A stale ID produced `bad_request` with `Unknown previous_response_id: missing` instead of `previous_response_not_found` with a fixed message.
  - `null` was dispatched upstream instead of rejected.
  - Empty and numeric IDs returned `bad_request` instead of `invalid_request_error`.
- After the original implementation, the same focused command passed 24 tests with 0 failures.
- Complete affected suites passed 136 tests with 0 failures before the original commit.

## Original Verification Evidence

- Commit: `40249a4 fix: align WebSocket continuation errors`.
- Full repository suite: 2,324 pass, 3 expected skips, 0 fail, 8,956 assertions across 120 files.
- Whole-repository lint: 0 errors and 5 existing warnings.
- `bun run typecheck`: exit 0.
- `bun run build`: exit 0.
- `git diff --check`: exit 0.

## Fix Round 1: Lossless Mixed Input and Deep Cloning

### Review findings

1. `mergeContinuationInput()` preserved both sides only when both were arrays. Snapshot string/current array, snapshot array/current string, and string/string combinations dropped history.
2. `createCompletedResponseSnapshot()` uses the same merge. A first turn whose input was a string and whose completed output was an array stored only the output; an empty output stored no first prompt at all.
3. Object spreads and array spreads were shallow. Mutating rehydrated input, tools, metadata, or current overrides could mutate the connection snapshot map or caller-owned payload.
4. Null or malformed input values could be coerced into invalid `input_text` content instead of returning a recoverable protocol error.

### RED evidence

- The focused review command initially produced 19 pass and 8 fail:
  - string/string, string/array, array/string, and empty-string merges lost history;
  - snapshot and new-thread mutation tests changed caller/map nested objects;
  - two-turn wire tests sent only `current delta`, dropping the first prompt and completed assistant output.
- Array/array remained green, isolating the defect to mixed-shape canonicalization.
- An explicit mutation check temporarily removed the malformed-input guard:
  - `bun test tests/responses-websocket-protocol.test.ts -t "rejects null|rejects malformed"`
  - Result: 3 pass, 4 fail.
  - Null/object input was emitted as invalid `input_text.text` content.
  - Restoring the guard produced 7 pass, 0 fail.

### Fix

- Convert every string input, including an empty string, to a canonical Responses user message with one `input_text` content item whenever two continuation segments are combined.
- Preserve snapshot segment first and current unacknowledged segment second.
- Preserve empty arrays as empty segments without inventing content.
- Deep-clone omitted-ID payloads, snapshot payloads, current payloads, completed output, tools, metadata, input items, and other nested values before returning or storing them.
- Reject continuation input that is present but neither a string nor an array with a fixed recoverable `invalid_request_error`.
- Keep existing stale-ID, cleared-ID, socket-open, payload-recovery, compaction, instructions, and tool-retention behavior unchanged.

### GREEN and verification evidence

- Focused review matrix after the fix:
  - 37 pass, 116 filtered, 0 fail, 106 assertions.
- Complete affected protocol/WebSocket suites:
  - 153 pass, 0 fail, 491 assertions.
- Full repository suite before the review-fix commit:
  - 2,341 pass, 3 expected skips, 0 fail, 8,981 assertions across 120 files.
- Whole-repository lint:
  - 0 errors and the same 5 existing warnings.
- `bun run typecheck`: exit 0.
- `bun run build`: exit 0.
- `git diff --check`: exit 0.
- Review-fix commit: `4ae1e17 fix: preserve WebSocket continuation history`.

## Self-Review

- Confirmed omitted `previous_response_id` returns a deep clone and does not touch snapshot state.
- Confirmed known current-connection IDs rehydrate snapshot history, completed output, and current input in order.
- Confirmed string/string, string/array, array/string, array/array, empty string, and empty array combinations are lossless.
- Confirmed string first turns remain in snapshots for both empty and substantive completed output.
- Confirmed two-turn wire payloads retain stable instructions, tools, metadata, first prompt, assistant output, and current delta.
- Confirmed mutations to returned snapshot/current input, tools, metadata, client metadata, or new-thread payloads do not alter the map or caller objects.
- Confirmed stale IDs return `previous_response_not_found` with no supplied ID in the message and leave the socket open for a new valid turn.
- Confirmed malformed IDs and malformed continuation input return recoverable `invalid_request_error` frames without upstream dispatch.
- Confirmed `previous_response_id` and `generate` remain cleared before the stateless HTTP request.
- Confirmed existing ordinary payload recovery, pre-compaction fitting, encrypted-reasoning stripping, warmup rehydration, and no-eviction snapshot tests remain green.

## Limitations

- Arbitrary externally-created response IDs remain intentionally unsupported. Resolving them would require direct upstream persistent state or local gateway storage, both outside the approved no-storage design.
- No push, pull request, deployment, or live credentialed WebSocket probe was requested for Task 2. Later Phase 4 verification tasks own authenticated live coverage.
