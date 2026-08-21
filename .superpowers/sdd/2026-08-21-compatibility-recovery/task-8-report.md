# Task 8 report: Messages stream lifecycle

## Outcome

- Added a Messages-specific terminal adapter over the Task 5 lifecycle guard.
- Native, Chat, custom Chat, buffered web-search, and Responses-backed Messages
  streams now have one exactly-once terminal owner.
- Normal success closes open blocks before one `message_delta` and one
  `message_stop`.
- EOF, malformed input, and post-commit failures close all open blocks before
  one Anthropic `error`; no success terminal follows failure.
- Received native, Chat, and Responses errors win once and suppress later
  iterator failures without duplicate reporting.
- Abort/detach produces no late stop, error, or success frames.
- Exact inspected upstream text or binary bytes are preserved with content type
  and status and reported once.

## Translator and forwarding changes

- Chat state exposes terminal status and an idempotent open-block finalizer.
- Chat `[DONE]`/EOF no longer implies success without a non-null finish reason.
- Interleaved thinking signatures and split Chat tool IDs/names/arguments are
  preserved.
- Responses translation returns tagged events, success, or failure results;
  terminal block stops are deterministic by ascending index.
- Split Responses tool identity/name and early argument fragments are buffered
  until a valid `tool_use` block can start, then flushed in order.
- Native forwarding tracks open block indices and defers normal terminal frames
  so synthetic block stops precede `message_delta`/`message_stop`.
- Unknown native payload fields remain byte-preserved except the existing
  `message_start.model` rewrite.

## TDD evidence

Initial focused tests failed because the Messages adapter and exposed terminal
builders did not exist. Additional mounted RED cases reproduced Chat/native EOF,
received-error-plus-throw, native success with an open block, split Responses
tool identity, direct/buffered Responses failure, exact textual/binary HTTP
failures, and custom-provider Chat EOF.

## Verification

- Focused lifecycle suite: 139 pass, 0 fail, 577 expectations.
- `bun run typecheck`: pass.
- `bun run build`: pass.
- Targeted lint for all changed lifecycle source/tests: pass; only the existing
  baseline-browser-mapping age advisory was printed.
- `git diff --check`: pass.

Per task direction, the full repository suite was not run.

## Review fix round 1

- Native success now defers both `message_delta` and `message_stop` until every
  tracked open block has emitted `content_block_stop`.
- Direct and explicit web-search-buffered Chat streams commit the first valid
  non-null finish reason. Later iterator faults, received-error frames, and
  malformed frames cannot replace it; trailing usage-only chunks are still
  captured before the normal terminal is written.
- Responses function calls now start when complete call id/name are present even
  when the initial arguments string is empty, so incomplete, failure, and EOF
  finalizers close a real `tool_use` block instead of losing the call.
- Chat argument fragments that arrive before split id/name completion are
  buffered per normalized tool index and flushed in order as soon as the
  `tool_use` block starts. This is binding because the Chat chunk schema makes
  id, name, and arguments independently optional.

### Review-fix TDD evidence

- RED focused run: 31 pass, 9 fail. The failures reproduced invalid native
  terminal order, finish-then-throw/received-error replacement in direct and
  buffered Chat paths, lost arguments-before-identity, and empty-argument
  Responses tools disappearing before incomplete/failure/EOF.
- A subsequent RED addition for trailing usage after finish failed in both
  direct and buffered paths with `output_tokens: 0` instead of 7.
- GREEN focused/adjacent suite: 142 pass, 0 fail, 562 expectations across nine
  files.
- `bun run typecheck`: pass.
- Exact lint for all changed Task 8 source/tests: pass; only the existing
  baseline-browser-mapping age advisory was printed.
- `bun run build`: pass.
- `git diff --check`: pass.
