# Codex Desktop Managed Authentication

This is the canonical procedure for using a locally generated ChatGPT-shaped
identity with `copilot-api`. It does not patch Codex binaries and does not run a
client-side proxy or interceptor. The client changes are Codex configuration, a
user environment variable, one hosts-file mapping, trust for the spoof
listener's dedicated CA, and the generated `%USERPROFILE%\.codex\auth.json`.

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
`nginx/sites-available/public-domain.conf.template`. Codex also needs a locally
mapped `*.openai.com` hostname for ChatGPT-hosted service calls. Render
`nginx/sites-available/codex-desktop-spoof.conf.template` for that hostname;
this guide uses `codex-gateway.openai.com` as a replaceable example.

The spoof listener needs a TLS certificate whose Subject Alternative Name
contains the exact hostname, signed by a CA trusted by the Windows client. Keep
the certificate key on the gateway and trust the dedicated CA only on intended
client machines. Do not expose a broad catch-all proxy for the spoof hostname.
For the example host, render at least these template values:

```text
{{CODEX_DESKTOP_SPOOF_PRIMARY_HOST}} = codex-gateway.openai.com
{{CODEX_DESKTOP_SPOOF_SERVER_NAMES}} = codex-gateway.openai.com
{{UPSTREAM_URL}} = http://127.0.0.1:4141
```

The rendered server block must therefore contain
`server_name codex-gateway.openai.com;`, the exact supported locations from the
template, and `location / { return 404; }`. The default denial is intentional:
unsupported ChatGPT-hosted services stay on the local gateway and receive a
fast `404` instead of receiving the synthetic credential at the real service.

The tracked template also contains an optional exact
`/backend-api/aura/site_status` location for Computer Use. It is not required
for managed authentication. When retained, the application responds with
`x-codex-browser-use-security-mode: disabled-for-local-testing` and
intentionally allows every HTTP(S) browser URL for operator-controlled local
testing. For a managed-auth-only deployment, remove the exact
`/backend-api/aura/site_status` location from the rendered candidate before
installing it. Retain that location only when the operator explicitly accepts
the disabled URL policy.

The tracked template publishes an anchored, GET-only `/ps/plugins/...`
compatibility family. Codex's current plugin page treats failure of the hosted
plugin directory as a page-wide failure even when its local marketplaces loaded
successfully. The application therefore validates the managed local bearer,
fetches anonymous public `/home` metadata without forwarding any credential,
cookie, or account header, derives nine-card category previews from that document,
allows strict anonymous public-card detail reads, and returns empty compatible
responses for account-scoped cloud catalog reads. This restores local and Git
marketplace browsing, search, installation, removal, and upgrades. It does not
turn the synthetic JWT into a ChatGPT session: remote cloud installs,
connectors, personal/workspace cloud directories, and sharing remain
unsupported.

The root `update.sh` updates the Compose application only. It does not install or
reload host Nginx. Render every placeholder, inspect the candidate, retain a
rollback copy, then run:

```sh
sudo nginx -t
sudo systemctl reload nginx
sudo nginx -T
```

Confirm `nginx -T` contains the exact spoof `server_name`, an exact POST-only
location for the refresh route, the anchored GET-only plugin compatibility
location, the chosen presence or absence of the optional Computer Use location,
and the default-deny location. Do not add a catch-all proxy.

## 2. Configure Codex Desktop on Windows

Keep credentials in the Codex file store, point inference at the public gateway,
and point ChatGPT-hosted service calls at the locally mapped spoof hostname in
`%USERPROFILE%\.codex\config.toml`:

```toml
openai_base_url = "https://gateway.example.com/v1"
chatgpt_base_url = "https://codex-gateway.openai.com"
cli_auth_credentials_store = "file"
```

Keep all three keys at the TOML document root, before the first `[table]`
heading, and define each key only once. Replace `gateway.example.com` with your
gateway's public hostname. You may replace `codex-gateway` with another unused
label, but the resulting hostname must still end in `.openai.com` and must match
the hosts entry, certificate Subject Alternative Name, and Nginx `server_name`
exactly.

Open an elevated editor and add the spoof hostname to
`C:\Windows\System32\drivers\etc\hosts` on each Codex Desktop client:

```text
<GATEWAY_IP> codex-gateway.openai.com
```

Replace `<GATEWAY_IP>` with the gateway address reachable from that client. Do
not map the public inference hostname unless that deployment separately requires
it. Flush cached DNS after changing the file:

```powershell
ipconfig /flushdns
```

Set the supported refresh endpoint override for the current Windows user:

```powershell
[Environment]::SetEnvironmentVariable(
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'https://gateway.example.com/v1/codex/auth/refresh',
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
- email: `<sanitized-first-name>@copilot-api.local`; if no usable first name is
  available, `copilot-api@copilot-api.local`
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

Open your gateway's `/dashboard#settings` page, add a useful device label under
**Trusted JWT Digests**, and paste only that 64-character SHA-256 digest. Never
paste the JWT, refresh token, or complete `auth.json` into the dashboard.

## 5. Restart and verify

Fully quit Codex Desktop, including background processes, then reopen it so it
reads `config.toml`, the user environment variable, the hosts mapping, and the
replacement `auth.json`.

Verify in this order:

1. `[Net.Dns]::GetHostAddresses('codex-gateway.openai.com')` includes the
   configured gateway address.
2. `curl.exe -sS -o NUL -w "%{http_code}" https://codex-gateway.openai.com/`
   completes TLS validation and returns `404` from the default-deny location.
3. `codex login status` reports ChatGPT authentication.
4. The app continues to show the account after an explicit account refresh.
5. Gateway logs show `POST /v1/codex/auth/refresh` returning `200` without
   logging credential material or repeating continuously while the app is idle.
6. A normal authenticated `/v1/responses` request succeeds.
7. The Plugins page loads without an Nginx HTML error, public category previews
   and card details render, configured local and Git marketplaces are visible,
   local search works, and a reversible local plugin install/remove succeeds.
   Public cloud cards are browse-only in this synthetic-auth mode.
8. Disable the digest temporarily and confirm the next refresh returns OAuth
   `invalid_grant`; re-enable it before normal use.

Model discovery may still contact ChatGPT in current builds. A configured local
model catalog can provide fallback model metadata; that request is separate from
the managed refresh endpoint.

## Rollback

Fully quit Codex Desktop. Restore the most recent backup `auth.json`. If
returning to normal OpenAI authentication, also restore the previous
`chatgpt_base_url` configuration (or remove the locally added key), remove only
the hosts-file line added for the spoof hostname, and remove the refresh
override:

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
- **Plugins page shows an Nginx HTML `404`:** the active spoof vhost does not
  contain the anchored `/ps/plugins/...` compatibility location. Update both
  the application and the host Nginx configuration, then fully restart Codex.
- **Public plugin card will not install:** expected with a synthetic identity.
  Use the corresponding local/curated marketplace entry when available, or a
  genuine ChatGPT session for hosted remote plugins and connectors.
- **OAuth `invalid_grant`:** the token is old-format, malformed, unknown,
  disabled, or deleted. Run the current script and register its new digest.
- **Rapid, repeated successful refresh requests:** a stream of `200` responses
  from `/v1/codex/auth/refresh` can mean `chatgpt_base_url` is absent, duplicated,
  nested under the wrong TOML table, or still targets a real ChatGPT service.
  Confirm the root-level value uses the locally mapped `*.openai.com` hostname,
  then verify the hosts entry, certificate trust, rendered Nginx `server_name`,
  and default `404` before restarting Codex Desktop.
- **The script used fallbacks:** Windows exposed no usable email or full name.
  Rerun interactively, or pass `-FullName` and `-Email`.
- **Restore required:** use the exact backup path printed by the script; do not
  edit a backup in place.
