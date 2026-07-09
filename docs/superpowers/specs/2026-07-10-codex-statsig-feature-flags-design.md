# Codex Statsig Feature Flags Design

## Summary

Add ChatGPT/Codex Desktop feature-flag controls to the existing dashboard while preserving the current Claude Code GrowthBook controls. Codex Desktop traffic redirected from `ab.chatgpt.com` will be proxied to the real Statsig service, and configured local overrides will be merged into full initialization responses.

The real Statsig initialization endpoint accepts the public client SDK key bundled with Codex Desktop. It does not require a ChatGPT login token, OpenAI API key, or other account credential. The gateway will forward the inbound client key rather than hard-code one.

## Goals

- Add an application selector to the dashboard Feature Flags screen:
  - Claude Code
  - ChatGPT / Codex
- Keep existing Claude Code flags and GrowthBook behavior unchanged.
- Support arbitrary Codex Statsig feature-gate and dynamic-config overrides.
- Preserve every upstream Statsig value that is not explicitly overridden.
- Provide dismissible setup instructions for DNS/hosts and TLS configuration.
- Restrict redirected Statsig traffic to clients allowed by the existing IP allowlist.

## Non-goals

- Patching or repacking Codex Desktop.
- Emulating ChatGPT authentication.
- Replacing the complete Statsig service with a synthetic local catalog.
- Changing the legacy `/feature-flags` page, which remains a Claude Code-only compatibility surface.
- Supporting Statsig response formats not currently used by the tested Codex Desktop release.

## Network Architecture

The Codex client machine maps:

```text
<server-ip> ab.chatgpt.com
```

Nginx terminates TLS using a certificate whose SAN includes `ab.chatgpt.com` and whose issuing CA is trusted by Windows/Codex Desktop. Nginx preserves the original `Host` header when proxying to `copilot-api`.

The hosts override must exist only on the Codex client. The `copilot-api` server must resolve `ab.chatgpt.com` normally so its upstream request reaches the real Statsig service instead of looping back to itself.

A host-aware middleware runs before normal API-key authentication:

1. Normalize the request host and continue normally unless it is `ab.chatgpt.com`.
2. Require the existing managed or session IP allowlist. Return 404 otherwise.
3. Proxy non-initialization Statsig requests upstream without changing their request or response semantics.
4. Handle `/v1/initialize` through the overlay flow described below.

## Statsig Initialization Flow

Codex Desktop sends `POST /v1/initialize` with its public client SDK key in the `k` query parameter. The request may use Statsig's reversed-base64 body encoding (`se=1`) and gzip compression (`gz=1`).

The gateway will:

1. Decode and decompress the request when those markers are present.
2. Parse the JSON body and preserve its user and client metadata.
3. Force a full upstream evaluation by setting:
   - `sinceTime` to `0`
   - `partialUserMatchSinceTime` to `0`
   - `deltasResponseRequested` to `false`
   - `full_checksum` to `null`
   - `previousDerivedFields` to an empty object
4. Remove `se` and `gz` from the upstream query and send normalized JSON to the real `https://ab.chatgpt.com/v1/initialize`.
5. Require a successful, parseable full Statsig response using the currently verified V1 maps.
6. Merge local feature gates into `feature_gates`.
7. Merge local dynamic configs into `dynamic_configs`.
8. Return the modified JSON response to Codex Desktop.

Existing entries are merged so metadata such as `id_type` and `version` is retained. Missing entries are created with the configured name, a `copilot-api-override` rule ID, and empty secondary exposures. Direct names are used as map keys because the bundled Statsig client checks direct names before hashed names.

Forcing a full response on every initialization avoids invalid delta/checksum interactions after modifying the upstream payload.

## Storage

The existing `feature_flags.json` remains the Claude Code store.

Add `statsig_overrides.json`:

```json
{
  "featureGates": {
    "824038554": true
  },
  "dynamicConfigs": {
    "107580212": {
      "default_model": "gpt-5.6-sol",
      "available_models": [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4"
      ],
      "use_hidden_models": true
    }
  }
}
```

The store exposes focused get, set, and remove operations. Feature-gate values must be booleans. Dynamic-config values must be non-array JSON objects. Empty names and unsafe object-property names are rejected.

## Dashboard API

Keep the existing `/dashboard/api/flags` handlers unchanged for Claude Code.

Add `/dashboard/api/statsig-overrides`:

- `GET` returns both override maps.
- `POST` accepts `{ kind, name, value }`.
- `DELETE` accepts `{ kind, name }`.

`kind` is either `featureGate` or `dynamicConfig`. The existing dashboard authentication protects these routes.

The overview flag count becomes the sum of Claude Code flags, Statsig feature gates, and Statsig dynamic configs.

## Dashboard UI

The existing Feature Flags screen gains an application selector in its page actions.

### Claude Code

- Uses the current table, forms, and `/dashboard/api/flags`.
- Shows a dismissible setup banner with:

```text
<server-ip> api.anthropic.com
<server-ip> claude.ai
<server-ip> platform.claude.com
```

### ChatGPT / Codex

- Uses `/dashboard/api/statsig-overrides`.
- Displays feature gates and dynamic configs as separate groups.
- The add dialog selects either `Feature gate` or `Dynamic config`.
- Feature gates use boolean switches.
- Dynamic configs use validated JSON-object input and remain editable.
- Shows a dismissible setup banner with:

```text
<server-ip> ab.chatgpt.com
```

The banner also states that the TLS certificate must include the spoofed hostname and be issued by a CA trusted by the client. Dismissal is stored locally in the browser and does not alter server configuration.

## Security

- Only requests with normalized host `ab.chatgpt.com` enter the Statsig proxy.
- Every redirected Statsig request requires the existing IP allowlist.
- The gateway does not accept or store ChatGPT credentials.
- The public Statsig client key is forwarded from the inbound request.
- Nginx must overwrite trusted forwarding headers using the existing deployment pattern.
- Other hosts and existing API routes keep their current authentication behavior.

## Error Handling

- Non-allowlisted redirected requests return 404.
- Missing or invalid Statsig client keys are passed upstream and retain the upstream status.
- Invalid encoded, compressed, or JSON initialization bodies return 400.
- Upstream network failures return 502.
- Non-successful upstream initialization statuses pass through unchanged.
- A successful initialization response that is malformed, delta-only, or uses an unsupported response format returns 502 rather than claiming overrides were applied.
- Store validation failures return 400 with a specific message.
- Failures are logged using existing project conventions without logging request credentials or full user payloads.

## Testing

Server tests will cover:

- Host normalization and IP-allowlist enforcement.
- Passthrough of non-Statsig hosts.
- Proxying non-initialization Statsig requests.
- Plain, reversed-base64, and gzip initialization request normalization.
- Full-evaluation request fields sent upstream.
- Gate and dynamic-config overlays while preserving unrelated upstream values.
- Creation and replacement of missing and existing entries.
- No-override passthrough behavior.
- Invalid payload, upstream failure, non-success status, malformed response, and unsupported-format behavior.
- Statsig override store validation and persistence.
- Dashboard list, set, and delete handlers for both override kinds.
- Backward compatibility of existing Claude Code flag routes.

UI validation will include the existing dashboard typecheck and production build. Targeted server tests, project typecheck, lint, and build will run before completion.

## Initial GPT-5.6 Configuration

After deployment, the required known entries are:

- Feature gate `824038554`: `true`
- Dynamic config `107580212`:
  - `use_hidden_models`: `true`
  - `available_models`: include `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`
  - `default_model`: any model in the configured allowlist

The feature gate enables the curated power-slider picker. The dynamic config allows the GPT-5.6 model families through the renderer's remote model filter. Effort choices continue to come from Codex Desktop's bundled model metadata.
