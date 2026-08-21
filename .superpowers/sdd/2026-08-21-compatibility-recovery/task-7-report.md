# Task 7 report: Chat stream lifecycle

## Outcome

- Added a Chat-specific adapter around `createStreamTerminalLifecycle`.
- Native, custom-provider, Responses fallback, Messages bridge, and buffered
  Chat synthesis now emit exactly one terminal outcome after response commit.
- Successful streams require a real final Chat chunk and end with one `[DONE]`.
- Non-abort EOF, malformed data, and transport failures before a final chunk
  emit one Chat error event and one `[DONE]`.
- Winning inspected `HTTPError` failures preserve exact text or byte-array body,
  content type, and status, and report exactly once.
- Received Responses and Anthropic failures are preserved without duplicate
  reporting.
- Anthropic split tool arguments and refusal terminals are preserved;
  `pause_turn` maps to `finish_reason: "length"` with
  `copilot_stop_reason: "pause_turn"`.
- Native/custom streams preserve trailing choices-empty usage metadata after a
  final chunk, while suppressing other post-terminal frames and failures.

## TDD evidence

- RED: `.superpowers/sdd/2026-08-21-compatibility-recovery/task-7-red.log`
  captured 34 expected failures across missing `[DONE]`, bare-sentinel false
  success, partial/throw, EOF, malformed data, duplicate terminals, received
  failures, and `pause_turn` mapping.
- GREEN: focused and adjacent lifecycle suites pass after implementation.

## Verification

- `bun test tests/chat-stream-lifecycle.test.ts tests/chat-completions-responses-fallback.test.ts tests/anthropic-response.test.ts tests/custom-providers.test.ts tests/vision-attachments.test.ts`
  - 161 pass, 0 fail.
- `bun test tests/chat-stream-lifecycle.test.ts tests/integration/chat-completions.test.ts`
  - 31 pass, 0 fail, including live `stream_options.include_usage`.
- `bun run typecheck`
  - pass.
- `bun run build`
  - pass.
- Selected-file lint for changed source and tests
  - pass; only the existing baseline-browser-mapping advisory was printed.
- `git diff --check`
  - pass.

No full test suite was run, per the task instruction.
