# Codex Desktop Managed Authentication

This is the canonical procedure for using a locally generated ChatGPT-shaped
identity with `copilot-api`. It does not patch Codex binaries and does not run a
proxy or interceptor. The only client-side changes are Codex configuration, a
user environment variable, and the generated `%USERPROFILE%\.codex\auth.json`.

## How it works

The Windows script generates one unsigned, synthetic JWT for the local Codex
identity. The raw JWT stays in `auth.json`; the gateway stores only its SHA-256
digest in **Settings → Trusted JWT Digests**.

Current Codex builds proactively refresh ChatGPT credentials. The script wraps
the JWT in a versioned local refresh token. Codex sends that token directly to
`POST /v1/codex/auth/refresh` because
`CODEX_REFRESH_TOKEN_URL_OVERRIDE` points at this gateway. The endpoint extracts
the JWT, validates its expected local shape, and requires an enabled digest
match before returning it. Disabling or deleting the digest therefore disables
both refresh and inference.

## 1. Deploy the gateway and edge route

Deploy a reviewed `copilot-api` revision containing the managed refresh route.
The public Nginx hostname must publish exact `POST /v1/codex/auth/refresh` from
`nginx/sites-available/public-domain.conf.template`. If clients use the locally
mapped trusted OpenAI hostname, publish the same exact route from
`nginx/sites-available/codex-desktop-spoof.conf.template`.

The root `update.sh` updates the Compose application only. It does not install or
reload host Nginx. Render every placeholder, inspect the candidate, retain a
rollback copy, then run:

```sh
sudo nginx -t
sudo systemctl reload nginx
sudo nginx -T
```

Confirm `nginx -T` contains an exact POST-only location for the route. Do not
add a catch-all proxy.

## 2. Configure Codex Desktop on Windows

Keep credentials in the Codex file store and point inference at the gateway in
`%USERPROFILE%\.codex\config.toml`:

```toml
openai_base_url = "https://ai.ashesh.dev/v1"
cli_auth_credentials_store = "file"
```

Set the supported refresh endpoint override for the current Windows user:

```powershell
[Environment]::SetEnvironmentVariable(
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'https://ai.ashesh.dev/v1/codex/auth/refresh',
  'User'
)
```

This setting is read when Codex starts. Do not point it at
`https://auth.openai.com/oauth/token`; that service cannot refresh the local
synthetic token.

## 3. Generate the local identity

From a `copilot-api` checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-codex-desktop-chatgpt-auth.ps1
```

The script accepts optional `-FullName` and `-Email` values. When they are not
provided it tries the current Windows account display name, email/UPN, local
user record, and Windows username. Normal interactive runs ask for values that
remain unavailable. Press Enter to accept the fallback values:

- full name: `copilot-api`
- email: `codex-<sanitized-computer-name>@local.invalid`
- user/account ID: derived from email, then name or Windows username; the final
  fallback is `copilot-api`

For unattended use, pass both values explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-codex-desktop-chatgpt-auth.ps1 `
  -FullName 'Example User' `
  -Email 'example.user@example.com' `
  -SkipClipboard
```

When standard input is redirected but prompts are still intentional, opt in
explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-codex-desktop-chatgpt-auth.ps1 `
  -PromptForIdentity
```

`CODEX_AUTH_FULL_NAME` and `CODEX_AUTH_EMAIL` are optional script input
overrides. They do not configure Codex or the gateway. Invalid email input fails
before replacing `auth.json`.

If `auth.json` already exists, its exact bytes are saved under:

```text
%USERPROFILE%\.codex\backups\codex-chatgpt-auth-<UTC timestamp>-<suffix>\auth.json
```

The script preserves `config.toml` and every unrelated file. It never prints the
JWT or refresh token.

## 4. Register the digest

Copy the value between:

```text
TRUSTED_JWT_SHA256_BEGIN
...
TRUSTED_JWT_SHA256_END
```

Open [`https://ai.ashesh.dev/dashboard#settings`](https://ai.ashesh.dev/dashboard#settings),
add a useful device label under **Trusted JWT Digests**, and paste only that
64-character SHA-256 digest. Never paste the JWT, refresh token, or complete
`auth.json` into the dashboard.

## 5. Restart and verify

Fully quit Codex Desktop, including background processes, then reopen it so it
reads the user environment variable and replacement `auth.json`.

Verify in this order:

1. `codex login status` reports ChatGPT authentication.
2. The app continues to show the account after an explicit account refresh.
3. Gateway logs show `POST /v1/codex/auth/refresh` returning `200` without
   logging credential material.
4. A normal authenticated `/v1/responses` request succeeds.
5. Disable the digest temporarily and confirm the next refresh returns OAuth
   `invalid_grant`; re-enable it before normal use.

Model discovery may still contact ChatGPT in current builds. A configured local
model catalog can provide fallback model metadata; that request is separate from
the managed refresh endpoint.

## Rollback

Fully quit Codex Desktop. Restore the most recent backup `auth.json`, then remove
the refresh override if returning to normal OpenAI authentication:

```powershell
[Environment]::SetEnvironmentVariable(
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  $null,
  'User'
)
```

Disable or delete the corresponding trusted JWT digest in the dashboard. Reopen
Codex Desktop only after the intended `auth.json` is in place.

## Troubleshooting

- **`401 token_expired` from `auth.openai.com`:** Codex did not inherit
  `CODEX_REFRESH_TOKEN_URL_OVERRIDE`. Confirm the user-scoped value and fully
  quit/reopen the app.
- **Gateway `404`:** the application revision or host Nginx location is stale.
  Inspect `nginx -T`; a successful `update.sh` alone is not proof of edge
  deployment.
- **OAuth `invalid_grant`:** the token is old-format, malformed, unknown,
  disabled, or deleted. Run the current script and register its new digest.
- **The script used fallbacks:** Windows exposed no usable email or full name.
  Rerun interactively, or pass `-FullName` and `-Email`.
- **Restore required:** use the exact backup path printed by the script; do not
  edit a backup in place.
