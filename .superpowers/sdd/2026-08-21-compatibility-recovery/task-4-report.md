# Task 4 report: preserve upstream transport failures

## Outcome

- Native Chat now gives `HTTPError` the original non-OK `Response` without
  clone-reading, reconstruction, or the former 404-to-502 remap.
- Malformed successful Chat JSON now creates a local bodyless 502, so consumed
  successful-response text cannot become an upstream failure snapshot.
- Custom-provider Chat and embeddings now give `HTTPError` the original
  response while logging only the operation and numeric status.
- `getModels` no longer consumes or logs the original failure body or status
  text; it uses a constant safe message and preserves the original response.
- Responses, native Messages, count tokens, native embeddings, and control
  plane required no production non-OK changes. Focused service and route tests
  characterize their original-response ownership and exact wire bytes.
- The intentional model-policy 403 compatibility result remains unchanged.
- Custom-provider SSE comments and unknown fields do not suppress a later
  future-named data frame or `[DONE]`.

## RED evidence

Command:

```powershell
bun test tests/create-chat-completions.test.ts tests/create-responses.test.ts tests/create-anthropic-messages.test.ts tests/count-anthropic-tokens.test.ts tests/create-embeddings.test.ts tests/copilot-control-plane.test.ts tests/custom-providers.test.ts tests/get-models.test.ts
```

Before production edits: **182 pass, 5 fail**. The five expected failures were:

1. Chat 404 response identity was lost by reconstruction/remap.
2. Malformed successful Chat JSON retained its consumed text in a 502 body.
3. Custom-provider Chat response identity was lost by reconstruction.
4. Custom-provider embedding response identity was lost by reconstruction.
5. `getModels` consumed/logged the response body and used status text in its
   error message.

All new characterizations for the already-compliant native transports passed
in RED.

## GREEN and verification evidence

- Focused tests: **187 pass, 0 fail, 771 assertions**.
- `bun run typecheck`: exit 0.
- `bun run build`: exit 0.
- Exact-file `bun run lint -- ...`: exit 0.
- `git diff --check`: exit 0.
- No full suite was run, per Task 4 instructions.

## Expected log noise

The focused route tests deliberately exercise non-OK upstream responses.
Task 3 therefore logs and reports the raw owned upstream body/status/content
type for those fixtures. Existing deterministic-400, retry, request-route,
compaction, custom-provider transport-error, and local-error logs also appear.
The selected-file lint command emits the existing advisory that
`baseline-browser-mapping` data is more than two months old; lint still exits 0.

## Surface coverage

- Chat: service identity/bodyUsed, public 404 status/content type/exact bytes,
  and local bodyless invalid-success JSON.
- Responses: service identity/bodyUsed and public exact bytes.
- Native Messages: service identity/bodyUsed and public exact bytes without an
  injected Anthropic `request_id`.
- Count tokens: service identity/bodyUsed and public exact bytes.
- Native embeddings: new focused service/route test with binary bytes.
- Control plane: public exact body plus approved request ID/content type,
  private header exclusion, and retained policy-403 compatibility test.
- Custom providers: Chat and embedding service identity/bodyUsed, exact route
  bytes including a binary embedding failure, status-text exclusion from the
  provider helper log, and tolerant SSE future-frame coverage.
- `getModels`: focused ownership and body/status-text logging test.

## Review fix round 1

- The control-plane wire test now captures `consola.error` calls before
  restoring its spy. It uses separate raw-body and request-session markers,
  proving the raw upstream body is reported while request header metadata is
  not introduced into logs.
- The new embeddings and models test files snapshot and restore every mutated
  `state` field, including models where applicable, so their results do not
  depend on file execution order.
- `getModels` now reuses the allowlisted safe message `Failed to get models`.
  Its focused test asserts both the thrown message and Task 3's inspected safe
  message. Before the source correction, this strengthened test failed with
  `Failed to get Copilot models` and the captured safe message would have fallen
  back to `Upstream request failed`.
- Review-fix focused check: **22 pass, 0 fail, 155 assertions**.
- Final Task 4 focused suite after review fixes: **187 pass, 0 fail, 773
  assertions**.
- Fresh `bun run typecheck`, `bun run build`, exact-file lint, and
  `git diff --check` all exited 0. The same existing
  `baseline-browser-mapping` advisory remains expected during lint.
