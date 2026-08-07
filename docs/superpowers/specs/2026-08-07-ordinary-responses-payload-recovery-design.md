# Ordinary Responses Payload Recovery Design

## Problem

GitHub Copilot API accepts at most 32 MiB of serialized JSON on its native Responses endpoint. Model context accounting is token-based and does not represent raw request bytes: inline images and files are base64-encoded, encrypted state is opaque, and JSON structure adds additional wire bytes. A task can therefore remain well below its token context limit while exceeding the transport limit.

The production incident proved this exact mismatch. An ordinary Codex turn (`request_kind: "turn"`) grew from a successful 32,627.0 KiB request to 38,119.6 KiB immediately after a screenshot entered the conversation. GitHub returned `413 failed to parse request`. PR #51 correctly bounded compaction-generation requests, but deliberately left ordinary turns unchanged.

The existing post-413 Responses fallback is insufficient: it runs only after wasting an upstream attempt, removes top-level/message attachments rather than recursively handling tool-result screenshots, and cannot resize visual content before dropping it.

## Reference Behavior

GitHub Copilot Agent Runtime implements CAPI-specific oversized Responses recovery in `src/runtime/src/interop/bridge_backed_seam.rs`:

1. Measure the exact serialized request body against CAPI's 32 MiB limit.
2. Downscale inline images to share the remaining byte budget, preserving visual content.
3. If downscaling cannot fit, remove binary attachments and leave explicit breadcrumbs.
4. Protect the latest user message during the first removal pass, then include it only as the final recoverable fallback.
5. If non-binary content still exceeds the limit, return a clear terminal size error.

Copilot Runtime also caps individually persisted model-facing binary results at 10 MiB decoded, but that per-item safeguard does not prevent multiple smaller images from cumulatively exceeding the request limit. The transport-level recovery is therefore the relevant reference for this gateway.

## Goals

- Keep every outbound native CAPI Responses request below CAPI's 32 MiB serialized JSON hard cap, targeting at most 32 MiB minus a 64 KiB recovery margin after transformation. This preserves the observed 31.862 MiB non-image history while leaving structural slack.
- Apply recovery to ordinary HTTP and Responses WebSocket turns after all local continuation rehydration, attachment normalization, compaction-boundary expansion, and request sanitization.
- Preserve inline image meaning by downscaling images before removing any binary attachment.
- Prefer removing historical binaries before current-turn binaries.
- Preserve all ordinary text, developer/bootstrap context, reasoning/compaction state, tool calls, tool IDs, call IDs, item ordering, and tool-result text.
- Leave already-small ordinary requests byte-for-byte unchanged at the recovery boundary.
- Keep PR #51's compaction-specific tool-output truncation behavior unchanged.
- Return a safe local 413 when binary recovery cannot make the exact final body fit.

## Non-goals

- Changing Codex's token-based context meter or auto-compaction threshold.
- Persistently rewriting Codex Desktop's local session history from the gateway.
- Truncating ordinary conversational text, tool commands, tool-result text, encrypted reasoning, or compaction blobs.
- Adding a general image asset store or uploading inline images to another service.
- Changing ChatCompletions or Anthropic Messages ordinary-turn behavior in this pull request; the observed and reference-limited path is native CAPI Responses.
- Raising Cloudflare, nginx, Bun, or GitHub body limits.

## Architecture

### Final transport boundary

`createResponses` remains the authoritative final native Responses boundary. It already runs after attachment normalization and request sanitization and is shared by HTTP and WebSocket callers. It will prepare the exact outbound object asynchronously:

- compaction requests continue through `fitResponsesCompactionPayload` exactly as in PR #51;
- ordinary requests strictly below the 32 MiB hard cap return the original sanitized object reference; an exact-cap request enters recovery so no body at or above the ambiguous upstream boundary is dispatched;
- oversized ordinary requests enter binary-only recovery before the first upstream dispatch.

No upstream 413 is required to trigger recovery. The legacy post-413 image-removal retry is replaced by the pre-dispatch recovery for CAPI Responses so nested tool-result images are handled and the first upstream request is already safe.

### Recovery utility

A focused utility alongside `compaction-payload.ts` owns ordinary Responses byte recovery. It receives the complete sanitized outbound object and returns:

- the fitted payload;
- original and final serialized byte counts;
- number of images downscaled;
- number of historical and current binary blocks removed; and
- whether recovery changed the payload.

The utility is immutable: it returns the original reference when within budget and uses `structuredClone` before any transformation.

### Stage 1: image downscaling

The utility recursively discovers inline `input_image.image_url` and `computer_screenshot.image_url` data URIs anywhere under `input`, including content arrays nested in function/custom/computer tool outputs.

It calculates the non-image serialized weight from the exact payload size minus the data-URI string lengths. The remaining target budget, minus a 64 KiB recovery margin, is divided across all inline images. Base64's 4/3 expansion and data-URI overhead are accounted for when selecting the decoded target.

Each supported image is decoded and re-encoded with production Bun 1.3.14's built-in `Bun.Image`, which is available in the deployed Alpine container and requires no new native dependency. Images retain aspect ratio and are progressively reduced until the exact full JSON body fits or no further safe reduction is possible. Encoding is deterministic: JPEG remains JPEG at quality 80, PNG remains PNG at compression level 9, and WebP remains WebP at quality 80. Other formats, animated images, and decode/encode failures use the explicit-removal fallback rather than silently changing or partially preserving their semantics. The data URI continues to declare the actual encoded format.

Recovery never silently classifies a dropped/undecodable image as a successful downscale. Image processing returns an explicit outcome: resized, invalid, or valid-but-unshrinkable. Invalid/malformed/unsupported media always becomes an explicit breadcrumb. Valid-but-unshrinkable media participates in the historical-first/current-last removal order, so current visual content survives when historical removal alone is sufficient.

### Stage 2: binary removal

If the exact body remains above the 32 MiB hard cap after downscaling, the utility removes inline binary blocks in two passes:

1. historical binary blocks outside the latest active turn;
2. binary blocks in the latest active turn, only if historical removal is insufficient.

The latest active turn is identified from `client_metadata["x-codex-turn-metadata"].turn_id`, falling back to the latest non-empty `internal_chat_message_metadata_passthrough.turn_id` found in input. The protected current-turn tail begins at the first item tagged with that active turn ID and includes every later item, because function/custom tool calls and results created within the same turn may be untagged. If no turn ID is available, the latest user-message group and every later item are protected during the first pass.

Removed blocks become shape-valid text breadcrumbs rather than disappearing:

- `[inline image omitted to fit the CAPI Responses request-size limit]`
- `[inline file omitted to fit the CAPI Responses request-size limit]`

The recursive traversal covers `input_image`, `input_file`, and `computer_screenshot`, including binary blocks nested in tool-result arrays. External textual URLs and file IDs remain untouched because they do not contain inline binary bytes.

After each pass the complete JSON body is remeasured. A transformed body must fit within 32 MiB minus the 64 KiB margin. The utility stops immediately when it reaches that target, so current-turn media is retained whenever historical recovery is sufficient.

### Unrecoverable requests

If the body remains above the transformed target after all inline binaries are recovered or removed, the gateway returns a local 413 with safe code `responses_payload_too_large`. The envelope reports the 32 MiB hard `max_bytes`, the 64 KiB `recovery_margin_bytes`, and `payload_bytes` but contains no request content. This is distinct from `compaction_payload_too_large`, because ordinary-turn recovery is binary-only and does not truncate textual tool results.

## Data Flow

1. HTTP or WebSocket handler expands compaction markers and, for WebSocket continuations, rehydrates the local response snapshot.
2. Endpoint routing selects native Responses.
3. `createResponses` normalizes attachment representations and sanitizes known fields.
4. Compaction request: existing PR #51 fitting runs.
5. Ordinary request: exact serialized bytes are measured against the 32 MiB hard cap.
6. If oversized, inline images are downscaled and the full body is remeasured.
7. If still oversized, historical binaries are replaced with breadcrumbs and remeasured.
8. If still oversized, current-turn binaries are replaced and remeasured.
9. The Copilot vision header is derived from the recovered final body, including recursively nested tool-result screenshots/files; it is removed if recovery removed every attachment.
10. An unchanged body strictly below 32 MiB is dispatched once. A transformed body at or below 32 MiB minus 64 KiB is dispatched once. Otherwise a safe local 413 is returned without contacting GitHub.

## Observability

Recovery logs contain only counts and byte sizes:

- original/final bytes;
- downscaled image count;
- historical/current removed binary counts; and
- recovery stage reached.

Logs never include base64 data, filenames, prompt text, tool output, credentials, or encrypted content. Existing request-kind/account/provider telemetry remains unchanged.

## Error Handling

- Unsupported or malformed image data falls through to explicit removal; it is never forwarded merely because resizing failed.
- A failed current-turn image downscale does not fail the request while removable binary content exists.
- Abort signals are checked between asynchronous image transformations so disconnected clients do not continue expensive recovery work.
- A local unrecoverable 413 uses `LocalHTTPError`, retaining upstream-error redaction and preventing a known-invalid request from reaching GitHub.
- The existing upstream 413 error path remains as defensive handling for a changed upstream ceiling, but no longer performs a second, structurally incomplete image-removal implementation.

## Testing

Testing follows red-green TDD and covers:

- an ordinary small Responses payload returning the original reference unchanged;
- the observed shape: a roughly 31.862 MiB non-image history plus a nested tool-result PNG producing a roughly 38 MiB request, fitted below the 32 MiB-minus-64 KiB transformed target while the image remains present and decodable;
- exact-body accounting including JSON structure and base64 expansion;
- multiple images sharing the available budget;
- historical binaries being removed before current-turn binaries;
- current-turn binary removal only when it is the final recoverable path;
- nested `computer_screenshot`, `input_image`, and `input_file` handling;
- external URLs/file IDs remaining unchanged;
- malformed/unsupported image data taking the explicit removal path;
- ordinary text/tool-result bodies never being truncated;
- a deterministic safe local 413 when non-binary content alone cannot fit below 32 MiB minus the recovery margin;
- native HTTP and WebSocket continuation paths dispatching no body at or above 32 MiB;
- no double upstream dispatch for a body known to be oversized; and
- all existing compaction, attachment, retry, marker/bootstrap, and ordinary-small-request regressions.

Focused tests, the full Bun suite, lint, type checking, build, production dependency audit, and `git diff --check` must pass before publishing a draft pull request. An independent code review must report no Critical or Important findings.

## Rollout

The pull request changes request preparation and tests only. After merge, deploy through the normal `update.sh` workflow. Live validation should send an ordinary-turn synthetic payload shaped like the incident (roughly 31.862 MiB of non-image history plus a tool-result screenshot), verify a single successful upstream request below 32 MiB with the 64 KiB margin, and confirm the screenshot is downscaled rather than removed when resizing is sufficient. A text-only oversized control should return the safe local error without an upstream call.
