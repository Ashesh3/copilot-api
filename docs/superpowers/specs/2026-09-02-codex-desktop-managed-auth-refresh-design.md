# Codex Desktop Managed Authentication Refresh Design

## Goal

Keep the existing local ChatGPT-shaped Codex Desktop identity usable after
current Desktop builds proactively refresh it, without patching Codex binaries
or running a local proxy/interceptor.

## Boundaries

- Changes stay in `copilot-api`, its tracked Nginx templates, and documented
  client configuration/environment setup.
- Do not patch `codex.exe`, `ChatGPT.exe`, `app.asar`, or any installed binary.
- Do not start mitmproxy, Fiddler, a loopback listener, or another interceptor.
- Do not redirect `auth.openai.com` or broadly proxy `chatgpt.com`.
- Continue storing only SHA-256 digests in the managed trusted-JWT registry.
- Preserve unrelated files in `%USERPROFILE%\.codex` and byte-for-byte backup
  the previous `auth.json` before replacement.

## Refresh Protocol

Current Codex source reads `CODEX_REFRESH_TOKEN_URL_OVERRIDE` and sends JSON:

```json
{
  "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "local_codex_v1.<base64url synthetic JWT>"
}
```

The client environment variable points directly at the public gateway:

```powershell
[Environment]::SetEnvironmentVariable(
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'https://ai.ashesh.dev/v1/codex/auth/refresh',
  'User'
)
```

`POST /v1/codex/auth/refresh` is mounted before the normal inference guard because
the OAuth request carries no Authorization header. The endpoint:

1. accepts JSON only and validates the exact narrow request shape;
2. requires the exact `refresh_token` grant and current Codex OAuth client ID;
3. decodes only the versioned local refresh-token envelope;
4. validates the embedded value as the expected unsigned, synthetic JWT shape;
5. checks the raw JWT against an enabled managed trusted-JWT digest entry;
6. returns the same JWT as `id_token` and `access_token`, and the same refresh
   token, with `Cache-Control: no-store` and `Pragma: no-cache`;
7. returns a generic OAuth `invalid_grant` response for malformed, unknown, or
   disabled credentials without logging token material.

The public and Codex trusted-host Nginx templates publish only the exact POST
route. All surrounding paths remain default-denied.

## Local Identity Discovery

`enable-codex-desktop-chatgpt-auth.ps1` accepts optional `-FullName` and
`-Email` parameters. When either value is missing it tries, in order:

1. `System.DirectoryServices.AccountManagement.UserPrincipal.Current` for
   display name, email, and UPN;
2. `Get-LocalUser` for the local account full name;
3. `Win32_UserAccount` through CIM for the local account full name;
4. Windows username for a friendly display-name fallback;
5. `whoami /upn` for an email-shaped UPN.

Interactive runs prompt when a value is still missing. `-PromptForIdentity`
also permits intentional prompts with redirected standard input. Pressing Enter
accepts the shown fallback. PowerShell non-interactive runs never block: the
fallback name is
`copilot-api`, and the fallback email uses the selected first name as
`<sanitized-first-name>@copilot-api.local`, falling back finally to
`copilot-api@copilot-api.local`.

The script derives both `sub`/`chatgpt_user_id` and `chatgpt_account_id` from a
normalized identifier based on the selected email local part, then full name,
then Windows username. The identifier is lowercase, contains only letters,
digits, dots, underscores, and hyphens, and falls back to `copilot-api` when no
usable value exists. The JWT profile also contains the selected display name.

## Documentation

The root README becomes the canonical client procedure and links to a focused
runbook under `docs/`. The runbook documents gateway deployment, digest
registration, the required environment variable, script behavior, verification,
rollback, and troubleshooting. Existing statements that the script's random
refresh token works without a refresh endpoint are replaced rather than left as
competing instructions. Historical dated specs/plans remain clearly marked as
historical evidence, not current operations.

## Verification

- Route tests cover success, disabled/unknown/malformed tokens, wrong method,
  wrong media type, wrong client/grant, and cache headers.
- Script tests run on every available PowerShell engine and cover explicit
  values, discovered values, prompt fallbacks, non-interactive defaults,
  identifier normalization, self-contained refresh tokens, backup safety, and
  secret-free output.
- Nginx tests prove both intended host templates expose exactly the POST route.
- Focused tests, full tests, typecheck, build, changed-file lint, and
  `git diff --check` must pass before delivery.
