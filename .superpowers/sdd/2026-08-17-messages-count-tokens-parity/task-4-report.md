# Task 4 Report: Native-First Messages Routing

## Outcome

- Added pure Messages-to-Responses and Messages-to-Chat fidelity scans.
- Selected upstream endpoints in native Messages, Responses, then Chat order.
- Preserved valid native thinking blocks and signatures on the first dispatch.
- Added one non-streaming deterministic invalid-signature recovery that strips
  historical thinking on a clone and retains the current thinking controls.
- Shared the three-send retry budget across transport retry, reinitialization,
  failover, and signature recovery.
- Pinned recovery to the account used by the failed native dispatch and
  prevented the recovery dispatch from buying further retries.
- Preserved explicit native beta, version, provider, and initiator options on
  every send.
- Kept custom-provider Messages routing and the native web-search compatibility
  loop intact.

## Verification

- Focused Messages/router/transport suite: 200 passed, 0 failed.
- Full suite: 1,827 passed, 3 expected media skips, 0 failed across 117 files.
- `bun run typecheck`: passed.
- Changed-file lint: passed (with the repository's existing stale
  `baseline-browser-mapping` notice only).
- `bun run build`: passed.
- `git diff --check`: passed.
