# Trusted Codex JWT Digests Design

> Historical design for the original digest registry. Current Codex Desktop
> builds also require the managed refresh procedure in
> `docs/codex-desktop-managed-auth.md`; where this document describes a random
> opaque refresh token or no environment setting, the current runbook
> supersedes it.

## Goal

Let a Windows user generate the local ChatGPT-shaped `auth.json` required by
Codex Desktop, then give an administrator a copy-pasteable SHA-256 digest that
can be trusted from the existing dashboard Settings page.

The raw JWT remains on the user's computer. The server stores only its digest,
and a matching JWT receives only the existing `user:inference` entitlement.

## Approved Scope

This change has two parts:

1. A Windows PowerShell script that creates a unique ChatGPT-shaped JWT, backs
   up any existing Codex `auth.json`, writes the new file, and prints and copies
   the JWT's SHA-256 digest.
2. An administrator-only **Trusted JWT Digests** card beside the existing IP
   Allowlist card at `/dashboard#settings`, with add, enable/disable, and delete
   controls.

The script will not modify:

- `config.toml`
- environment variables
- the Windows hosts file
- certificate stores or certificate files
- network, proxy, or DNS settings

Those are deployment prerequisites outside this feature.

## User Flow

1. The user runs `scripts/enable-codex-desktop-chatgpt-auth.ps1`.
2. The script creates a unique JWT locally and writes it to
   `%USERPROFILE%\.codex\auth.json`.
3. If `auth.json` already exists, the script first copies it into a unique,
   timestamped directory under `%USERPROFILE%\.codex\backups`.
4. The script computes the SHA-256 digest of the exact UTF-8 JWT, copies the
   lowercase hexadecimal value to the clipboard when possible, and prints it
   in a clearly delimited block. It never prints the raw JWT.
5. The user opens `/dashboard#settings` or sends the digest to an administrator.
6. The administrator adds a device label and the digest under **Trusted JWT
   Digests**.
7. The newly registered JWT is accepted immediately for inference without a
   service restart.

## PowerShell Script

### Compatibility

The script will support Windows PowerShell 5.1 and PowerShell 7. It will use
only .NET and built-in PowerShell functionality, so users do not need modules
or package managers.

For deterministic automated tests, it will accept an optional `-CodexHome`
path. Its default remains `%USERPROFILE%\.codex`. It may also accept an
optional email value; otherwise it creates a non-routable local identity from
the computer name. Neither option expands the script into system setup.

### JWT Shape

The generated token will preserve the shape verified with the installed Codex
Desktop build:

- JWT header: `alg: "none"`, `typ: "JWT"`
- issuer: `https://auth.openai.com`
- audience: `https://api.openai.com/v1`
- a unique local subject
- an issued-at timestamp
- an email claim
- `https://api.openai.com/profile.email`
- `https://api.openai.com/auth.chatgpt_user_id`
- `https://api.openai.com/auth.chatgpt_plan_type: "plus"`
- `https://api.openai.com/auth.chatgpt_account_id`

The current script derives a stable friendly user/account ID from the selected
email, full name, or Windows username. The third JWT segment remains random. The
refresh token is now a versioned base64url envelope containing the same JWT so
the managed refresh endpoint can validate its registered digest. The access
token and ID token contain the same JWT.

The resulting file will contain:

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<local JWT>",
    "access_token": "<same local JWT>",
    "refresh_token": "local_codex_v1.<base64url local JWT>",
    "account_id": "<matching account claim>"
  },
  "last_refresh": "2099-01-01T00:00:00Z"
}
```

This is a local compatibility identity, not a real OpenAI or ChatGPT login.

### File Safety

- Create `%USERPROFILE%\.codex` and its `backups` directory if needed.
- When `auth.json` exists, copy its exact bytes to a unique timestamped backup
  before replacing it.
- Serialize JSON to a temporary file in the same directory and replace the
  destination only after serialization succeeds.
- Remove an abandoned temporary file on failure.
- Preserve every other file under `.codex`.
- Print the new auth path and backup path, when present.

### Digest Output

The digest is:

```text
lowercase_hex(SHA-256(UTF-8(access_token)))
```

Clipboard failure is non-fatal. The script will still print the full digest
and direct the user to the dashboard Settings page. The raw JWT, refresh token,
and previous `auth.json` contents will never be written to the console.

## Persistent Trusted-Digest Registry

### Data Model

Dashboard-managed records will live in
`DATA_DIR/trusted_jwt_digests.json`:

```ts
interface TrustedJwtDigestEntry {
  id: string
  label: string
  digest: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}
```

- `id` is an opaque random UUID used by dashboard routes.
- `label` is required, trimmed, bounded, and rejects control characters.
- `digest` is exactly 64 hexadecimal SHA-256 characters and is normalized to
  lowercase.
- Duplicate digests are rejected, regardless of letter case.
- A disabled record remains visible but no longer authenticates its JWT.

### Persistence

The store will:

- strictly validate the complete persisted file and fail closed on malformed
  records;
- keep an immutable in-memory snapshot for fast synchronous credential checks;
- write a complete replacement to a same-directory temporary file and rename
  it into place;
- use owner-only file permissions where the platform supports them;
- update the cached snapshot only after persistence succeeds;
- return cloned records so callers cannot mutate store state.

No raw JWT is accepted by or persisted through the dashboard API.

The existing `COPILOT_INFERENCE_CREDENTIAL_SHA256S` environment variable
remains supported for backward compatibility. Environment-managed digests are
not listed or editable in the dashboard. Production migration will first add
the currently active digest to the managed registry, verify it, and only then
remove the duplicate environment entry.

## Credential Resolution

For every supplied credential, the resolver will preserve the existing trust
boundary:

1. Trim only surrounding whitespace, matching current behavior.
2. Reject a value that is itself any configured or dashboard-managed digest.
   A digest is an identifier, never a usable bearer credential.
3. SHA-256 the raw credential and compare it in constant time against enabled
   environment and dashboard entries.
4. On a dashboard match, return an `inference-client` principal tied to the
   opaque registry ID.
5. Grant only `user:inference`; the existing effective transcription scope may
   be derived from that entitlement as it is today.

A managed JWT must not become:

- a gateway credential;
- an administrator credential or session;
- an OAuth authorization code, access token, or refresh token;
- an `org:create_api_key` credential;
- a worker or environment credential.

Disable and delete operations take effect for the next request without a
restart.

## Dashboard API

All routes remain behind the existing administrator session and CSRF middleware:

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/dashboard/api/trusted-jwt-digests` | List managed records |
| `POST` | `/dashboard/api/trusted-jwt-digests` | Add `{ label, digest }` |
| `PATCH` | `/dashboard/api/trusted-jwt-digests/:id` | Set `{ enabled }` |
| `DELETE` | `/dashboard/api/trusted-jwt-digests/:id` | Delete one record |

Invalid JSON or fields return `400`, a duplicate digest returns `409`, and an
unknown ID returns `404`. Successful mutating responses return the resulting
record or a simple success object. Responses use the same dashboard error and
toast conventions as IP Allowlist operations.

The trusted-digest registry will not be added to the downloadable sanitized
configuration archive in this change. Export/import semantics are separate
work and omitting it avoids unintentionally distributing the device registry.

## Dashboard UI

The Settings bundle will load trusted JWT digests alongside settings and the
IP allowlist. A fourth card will be inserted immediately after **IP Allowlist**;
the existing responsive two-column layout therefore places both cards beside
one another on wide screens.

The new card will include:

- heading: **Trusted JWT Digests**;
- badge: **Inference only**;
- a concise explanation that users generate the digest with the repository's
  PowerShell script and paste only the digest here;
- **Device label** and **SHA-256 digest** inputs;
- an Add button;
- a table showing label, digest, enabled state, creation time, and actions;
- enable/disable toggle;
- confirmed delete action;
- an empty state explaining that no local Codex JWTs are trusted yet.

The UI will never accept or request the raw JWT.

`ui/src` remains the source of truth. The generated
`src/routes/dashboard/page-generated.ts` file will be rebuilt with
`bun run build:ui`, never edited manually.

## Documentation

The README will document:

- how to run the script;
- where the backup is created;
- that the printed digest must be registered by an administrator;
- that the script intentionally does not configure certificates, hostnames,
  environment variables, networking, or `config.toml`;
- that current clients require `CODEX_REFRESH_TOKEN_URL_OVERRIDE` to point at
  the gateway's exact managed refresh route;
- that users should fully quit and reopen Codex Desktop after changing
  `auth.json`.

## Testing

### Store tests

- Missing registry starts empty.
- Valid records persist and reload.
- Digest case is normalized.
- Invalid digests, labels, duplicate digests, duplicate IDs, and malformed
  persisted files are rejected.
- Failed persistence does not change the active snapshot.
- Enable, disable, and delete take effect immediately.

### Authentication-boundary tests

- A raw JWT whose digest is enabled resolves as `inference-client`.
- It receives `user:inference` and no broader scope.
- The hexadecimal digest itself is rejected as a bearer credential.
- Disabled and deleted entries stop authenticating.
- Dashboard-managed JWTs cannot authenticate gateway, administrator, OAuth,
  worker, or environment paths.
- Existing environment-managed digest behavior remains unchanged.

### Dashboard tests

- Every endpoint requires an administrator session; mutations require CSRF.
- Add, list, toggle, and delete work through the API.
- Validation and duplicate/not-found status codes are deterministic.
- The Settings loader fetches the new collection.
- UI helpers trim labels and normalize digests before submission.
- Generated dashboard HTML contains the card and API route.

### PowerShell tests

Run the script against a temporary `-CodexHome` and verify:

- the expected JSON shape and claim values;
- friendly stable IDs plus unique JWTs, refresh tokens, and digests across runs;
- the reported digest equals SHA-256 of the written access token;
- access and ID tokens match;
- `account_id` matches the JWT account claim;
- an existing file is preserved byte-for-byte in a timestamped backup;
- a clipboard failure does not prevent file creation or digest output;
- console output contains no raw JWT or refresh token;
- no `config.toml`, hosts, certificate, or environment-setting behavior exists.

### Final verification

Run focused tests first, then:

- `bun run lint:all`
- `bun run typecheck`
- `bun run build:ui`
- every `tests/*.test.ts` file in an isolated Bun process, matching CI
- `bun run build`
- `git diff --check`

After deployment, verify a temporary digest through the dashboard: enabled raw
JWT succeeds, its literal digest fails, disabling it denies the next request,
and deleting it removes the record. Migrate the currently active production
JWT digest without interrupting the existing Codex Desktop session.

## Out of Scope

- One-time enrollment codes or public enrollment APIs
- Giving users the gateway key
- Automatic submission to the dashboard
- Certificate or HTTPS interception setup
- hosts-file, DNS, proxy, or firewall changes
- environment-variable changes performed by the script (the documented user
  refresh override remains a separate operator action)
- `config.toml` changes
- Real OpenAI authentication or token signing
- macOS or Linux setup scripts
- Dashboard editing of environment-managed digest values
- Bulk clear, export, or import of the trusted-digest registry
