# Trusted Codex JWT Digests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows script that writes a unique ChatGPT-shaped Codex `auth.json` and outputs its SHA-256 digest, plus administrator dashboard controls that persistently trust, disable, and delete those inference-only digests.

**Architecture:** A new synchronous, atomic `trusted_jwt_digests.json` store supplies an immutable snapshot to the existing credential resolver and CRUD operations to authenticated dashboard routes. The Windows PowerShell script never contacts the server: it writes only `auth.json`, backs up the previous file, and outputs the digest that an administrator pastes into the Settings page.

**Tech Stack:** Bun 1.3.14, strict TypeScript, Hono, React dashboard, Bun test runner, Windows PowerShell 5.1/PowerShell 7, Node cryptography primitives, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-29-trusted-jwt-digests-design.md`

## Global Constraints

- The PowerShell script changes only the selected Codex home directory's `auth.json` and its timestamped backup directory.
- The script must not change `config.toml`, environment variables, hosts/DNS/proxy state, certificates, firewall rules, or networking.
- The raw JWT and refresh token remain client-side and never appear in console output, server requests, dashboard state, or persisted server files.
- A matching raw JWT receives only `user:inference`; the digest literal itself is never a bearer credential.
- Existing `COPILOT_INFERENCE_CREDENTIAL_SHA256S` behavior remains compatible until production migration is verified.
- Dashboard mutations remain protected by the existing administrator session and CSRF middleware.
- `ui/src` is dashboard source; rebuild `src/routes/dashboard/page-generated.ts` with `bun run build:ui` and never edit it directly.
- Use no new runtime or PowerShell module dependencies.
- Preserve unrelated files in `F:\Projects\copilot-api`.

## File Map

### New files

- `src/lib/trusted-jwt-digests.ts` — strict registry validation, atomic persistence, matching, and test isolation.
- `tests/trusted-jwt-digests-store.test.ts` — persistence and validation contract.
- `tests/dashboard-trusted-jwt-digests.test.ts` — administrator CRUD and authorization boundary.
- `tests/dashboard-settings-trusted-jwt-ui.test.ts` — Settings bundle/input helper behavior.
- `scripts/enable-codex-desktop-chatgpt-auth.ps1` — local JWT/auth generator.
- `tests/codex-desktop-auth-script.test.ts` — cross-process script verification.

### Modified files

- `src/lib/paths.ts` — add `TRUSTED_JWT_DIGESTS_PATH`.
- `src/lib/credential-resolver.ts` — combine environment and managed digest resolution without widening scope.
- `src/routes/dashboard/api.ts` — CRUD handlers.
- `src/routes/dashboard/route.ts` — protected CRUD route registration.
- `ui/src/lib/types.ts` — record types, form normalization, and Settings bundle loading.
- `ui/src/screens/Settings.tsx` — Trusted JWT Digests card.
- `tests/credential-resolver.test.ts` — resolver and gateway fallback regressions.
- `tests/admin-inference-credential-boundary.test.ts` — administrator boundary regression.
- `tests/dashboard-settings-ip-allowlist-ui.test.ts` — include the new Settings bundle request.
- `src/routes/dashboard/page-generated.ts` — generated dashboard bundle.
- `README.md` — user/admin flow and persistent-data documentation.
- `SECURITY.md` — inference-only, digest-only security boundary.

---

### Task 1: Persistent Trusted JWT Digest Store

**Files:**
- Create: `src/lib/trusted-jwt-digests.ts`
- Create: `tests/trusted-jwt-digests-store.test.ts`
- Modify: `src/lib/paths.ts`

**Interfaces:**
- Produces:

```ts
export interface TrustedJwtDigestEntry {
  id: string
  label: string
  digest: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export class TrustedJwtDigestValidationError extends Error {}
export class TrustedJwtDigestConflictError extends Error {}

export interface TrustedJwtDigestStore {
  readonly filePath: string
  list(): Array<TrustedJwtDigestEntry>
  add(input: { label: string; digest: string }): TrustedJwtDigestEntry
  setEnabled(id: string, enabled: boolean): TrustedJwtDigestEntry | null
  remove(id: string): boolean
  findEnabledCredential(rawCredential: string): TrustedJwtDigestEntry | null
  containsDigestLiteral(value: string): boolean
  replaceForTest(entries: ReadonlyArray<TrustedJwtDigestEntry>): void
  resetAfterTest(): void
}

export function createTrustedJwtDigestStore(
  filePath?: string,
): TrustedJwtDigestStore

export const trustedJwtDigestStore: TrustedJwtDigestStore
```

- Produces path: `PATHS.TRUSTED_JWT_DIGESTS_PATH` equal to `path.join(APP_DIR, "trusted_jwt_digests.json")`.
- Consumes: `PATHS.APP_DIR`, `node:crypto`, `node:fs`, and `node:path` only.

- [ ] **Step 1: Write the failing store tests**

Create `tests/trusted-jwt-digests-store.test.ts`. Use a unique directory under `tests/.test-artifacts`, remove it in `finally`, and cover the following concrete behavior:

```ts
import { expect, mock, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import nodeFs from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import {
  createTrustedJwtDigestStore,
  trustedJwtDigestStore,
  TrustedJwtDigestConflictError,
  TrustedJwtDigestValidationError,
} from "~/lib/trusted-jwt-digests"

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

test("production singleton uses the managed trusted JWT path", () => {
  expect(trustedJwtDigestStore.filePath).toBe(
    PATHS.TRUSTED_JWT_DIGESTS_PATH,
  )
})

test("adds normalized records and persists a versioned registry", async () => {
  await withTestDir(async (directory) => {
    const filePath = path.join(directory, "trusted_jwt_digests.json")
    const store = createTrustedJwtDigestStore(filePath)
    const digest = sha256("device-token")

    const added = store.add({
      label: "  Living-room PC  ",
      digest: digest.toUpperCase(),
    })

    expect(added).toMatchObject({
      label: "Living-room PC",
      digest,
      enabled: true,
    })
    expect(createTrustedJwtDigestStore(filePath).list()).toEqual([added])
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      version: 1,
      entries: [added],
    })
  })
})

test("matches only enabled raw credentials and rejects digest literals", async () => {
  await withTestDir((directory) => {
    const rawCredential = "header.payload.signature"
    const digest = sha256(rawCredential)
    const store = createTrustedJwtDigestStore(
      path.join(directory, "trusted_jwt_digests.json"),
    )
    const added = store.add({ label: "Laptop", digest })

    expect(store.findEnabledCredential(rawCredential)?.id).toBe(added.id)
    expect(store.containsDigestLiteral(digest)).toBe(true)
    expect(store.findEnabledCredential(digest)).toBeNull()
    expect(store.setEnabled(added.id, false)?.enabled).toBe(false)
    expect(store.findEnabledCredential(rawCredential)).toBeNull()
    expect(store.remove(added.id)).toBe(true)
    expect(store.containsDigestLiteral(digest)).toBe(false)
  })
})
```

Add table-driven assertions for:

- missing file returns `[]`;
- returned records are clones;
- labels `""`, whitespace-only values, labels longer than 80 characters, and labels containing `\u0000`, `\n`, or `\u007f` throw `TrustedJwtDigestValidationError`;
- non-64-hex digests throw `TrustedJwtDigestValidationError`;
- a duplicate digest in different case throws `TrustedJwtDigestConflictError`;
- duplicate persisted IDs and duplicate persisted digests are rejected;
- non-UUID IDs, non-ISO timestamps, wrong field types, wrong version, and invalid JSON fail closed;
- `setEnabled` requires a boolean and returns `null` for an unknown UUID;
- `remove` returns `false` for an unknown UUID;
- failed `renameSync` preserves the prior file/cache and removes the temporary file;
- a blocked parent path leaves the initial empty cache unchanged.

- [ ] **Step 2: Run the store test and verify the expected red state**

Run:

```powershell
bun test tests/trusted-jwt-digests-store.test.ts
```

Expected: FAIL because `~/lib/trusted-jwt-digests` and `PATHS.TRUSTED_JWT_DIGESTS_PATH` do not exist.

- [ ] **Step 3: Add the path and minimal atomic store**

In `src/lib/paths.ts`, add:

```ts
const TRUSTED_JWT_DIGESTS_PATH = path.join(
  APP_DIR,
  "trusted_jwt_digests.json",
)
```

and expose it on `PATHS`.

Implement `src/lib/trusted-jwt-digests.ts` with these exact constraints:

```ts
const DIGEST_PATTERN = /^[a-f\d]{64}$/i
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const MAX_LABEL_LENGTH = 80

interface TrustedJwtDigestFile {
  version: 1
  entries: Array<TrustedJwtDigestEntry>
}
```

Normalize labels by trimming, normalize digests to lowercase, require ISO timestamps that round-trip through `new Date(value).toISOString()`, and reject duplicate IDs/digests during complete-file validation. Use `randomUUID()` for IDs and one `new Date().toISOString()` value for both timestamps on creation.

Persist this exact shape:

```json
{
  "version": 1,
  "entries": []
}
```

Use a same-directory dot-prefixed temporary filename containing a UUID, `mkdirSync` with recursive creation and mode `0o700`, `writeFileSync` with UTF-8 encoding and mode `0o600`, `renameSync`, and best-effort `chmodSync` after replacement. Remove the temporary file in the error path. Assign the next cached snapshot only after persistence succeeds.

Implement constant-time credential matching by hashing the trimmed raw value once and comparing 32-byte buffers with `timingSafeEqual` against every enabled entry. `containsDigestLiteral` checks all enabled and disabled entries after trim/lowercase normalization. `findEnabledCredential` must immediately return `null` when the supplied value is itself a managed digest literal.

- [ ] **Step 4: Run and refine the focused store tests**

Run:

```powershell
bun test tests/trusted-jwt-digests-store.test.ts
bun run lint -- src/lib/trusted-jwt-digests.ts src/lib/paths.ts tests/trusted-jwt-digests-store.test.ts
```

Expected: all store tests pass and changed-file lint exits 0.

- [ ] **Step 5: Commit the store**

```powershell
git add src/lib/paths.ts src/lib/trusted-jwt-digests.ts tests/trusted-jwt-digests-store.test.ts
git commit -m "Add persistent trusted JWT digest store"
```

---

### Task 2: Inference-Only Credential Resolver Integration

**Files:**
- Modify: `src/lib/credential-resolver.ts`
- Modify: `tests/credential-resolver.test.ts`
- Modify: `tests/admin-inference-credential-boundary.test.ts`

**Interfaces:**
- Consumes: `trustedJwtDigestStore.findEnabledCredential(rawCredential)` and `trustedJwtDigestStore.containsDigestLiteral(value)` from Task 1.
- Preserves: `resolveCredential`, `resolveGatewayCredential`, `isConfiguredInferenceCredential`, and existing environment digest semantics.
- Produces managed principals using the `inference-managed:` prefix followed by the registry UUID, with only `new Set(["user:inference"])`.

- [ ] **Step 1: Add failing resolver tests for managed digests**

In both test files, isolate the singleton with:

```ts
import { trustedJwtDigestStore } from "../src/lib/trusted-jwt-digests"

beforeEach(() => {
  trustedJwtDigestStore.replaceForTest([])
})

afterEach(() => {
  trustedJwtDigestStore.resetAfterTest()
})
```

Add this resolver test:

```ts
test("limits dashboard-managed JWT digests to inference scope", async () => {
  const rawCredential = "managed.jwt.signature"
  const digest = sha256Hex(rawCredential)
  const entry = trustedJwtDigestStore.add({ label: "Laptop", digest })

  expect(
    await resolveCredential(rawCredential, ["user:inference"]),
  ).toMatchObject({
    principalId: `inference-managed:${entry.id}`,
    kind: "inference-client",
    scopes: new Set(["user:inference"]),
  })
  expect(await resolveCredential(rawCredential, ["user:profile"])).toBeNull()
  expect(await resolveCredential(rawCredential, ["org:create_api_key"])).toBeNull()
  expect(await resolveCredential(digest)).toBeNull()

  trustedJwtDigestStore.setEnabled(entry.id, false)
  expect(await resolveCredential(rawCredential)).toBeNull()
})
```

Add a collision regression in which `rawCredential === state.apiKeyAuth`, its digest is managed, and `resolveGatewayCredential(rawCredential)` must be `null`. Add an OAuth collision regression by managing the digest of an issued OAuth access token and asserting `user:profile` resolution is denied.

In `tests/admin-inference-credential-boundary.test.ts`, manage the SHA-256 digest of `GATEWAY_KEY` instead of using the environment variable for one new test, then assert administrator setup and login both return `401`.

- [ ] **Step 2: Run the resolver tests and verify the expected red state**

Run:

```powershell
bun test tests/credential-resolver.test.ts tests/admin-inference-credential-boundary.test.ts
```

Expected: FAIL because managed records are not consulted by the resolver and a managed gateway collision still resolves as gateway.

- [ ] **Step 3: Integrate the store before every privilege fallback**

In `src/lib/credential-resolver.ts`:

1. Import `trustedJwtDigestStore`.
2. Replace the environment-only digest-literal guard with a helper that checks both configured environment digests and `trustedJwtDigestStore.containsDigestLiteral(value)`.
3. Replace the environment-only raw matcher with a helper that first checks the environment list, then `trustedJwtDigestStore.findEnabledCredential(rawCredential)`.
4. Preserve environment principals exactly as the `inference-env:` prefix followed by the first 16 hexadecimal digest characters.
5. Return managed matches as:

```ts
const credential: ResolvedCredential = {
  principalId: `inference-managed:${managedEntry.id}`,
  kind: "inference-client",
  scopes: new Set(["user:inference"]),
}
```

6. Keep this order in `resolveCredential`: digest-literal rejection, raw inference-digest resolution, gateway, OAuth access token, generated inference key.
7. Make `resolveGatewayCredential` reject both a matching managed raw credential and any managed digest literal before comparing configured gateway keys.
8. Keep `isConfiguredInferenceCredential` exported because OAuth grant handlers use it as their anti-elevation guard; broaden its implementation to include managed entries without changing call sites.

- [ ] **Step 4: Run focused security tests**

```powershell
bun test tests/trusted-jwt-digests-store.test.ts tests/credential-resolver.test.ts tests/admin-inference-credential-boundary.test.ts tests/oauth-api-route.test.ts
bun run lint -- src/lib/credential-resolver.ts tests/credential-resolver.test.ts tests/admin-inference-credential-boundary.test.ts
```

Expected: all focused security tests pass.

- [ ] **Step 5: Commit resolver integration**

```powershell
git add src/lib/credential-resolver.ts tests/credential-resolver.test.ts tests/admin-inference-credential-boundary.test.ts
git commit -m "Resolve dashboard-managed inference digests"
```

---

### Task 3: Administrator Dashboard CRUD API

**Files:**
- Create: `tests/dashboard-trusted-jwt-digests.test.ts`
- Modify: `src/routes/dashboard/api.ts`
- Modify: `src/routes/dashboard/route.ts`

**Interfaces:**
- Consumes: Task 1 singleton store and its two error classes.
- Produces:

```text
GET    /dashboard/api/trusted-jwt-digests
POST   /dashboard/api/trusted-jwt-digests
PATCH  /dashboard/api/trusted-jwt-digests/:id
DELETE /dashboard/api/trusted-jwt-digests/:id
```

- [ ] **Step 1: Write failing route tests**

Use `tests/helpers/admin-session.ts` and isolate `trustedJwtDigestStore` in `beforeEach`/`afterEach`. Test the complete route contract:

```ts
test("dashboard adds, lists, disables, enables, and deletes a digest", async () => {
  const digest = sha256Hex("device.jwt.signature")
  const add = await server.request("/dashboard/api/trusted-jwt-digests", {
    method: "POST",
    headers: adminHeaders(admin),
    body: JSON.stringify({
      label: "  Office PC  ",
      digest: digest.toUpperCase(),
    }),
  })
  expect(add.status).toBe(200)
  const entry = (await add.json()) as TrustedJwtDigestEntry
  expect(entry).toMatchObject({
    label: "Office PC",
    digest,
    enabled: true,
  })

  const list = await server.request(
    "/dashboard/api/trusted-jwt-digests",
    { headers: adminHeaders(admin, false) },
  )
  expect(await list.json()).toEqual([entry])

  const disable = await server.request(
    `/dashboard/api/trusted-jwt-digests/${entry.id}`,
    {
      method: "PATCH",
      headers: adminHeaders(admin),
      body: JSON.stringify({ enabled: false }),
    },
  )
  expect(await disable.json()).toMatchObject({ enabled: false })

  const remove = await server.request(
    `/dashboard/api/trusted-jwt-digests/${entry.id}`,
    { method: "DELETE", headers: adminHeaders(admin) },
  )
  expect(remove.status).toBe(200)
  expect(await remove.json()).toEqual({ success: true })
})
```

Add separate tests asserting:

- unauthenticated GET/POST/PATCH/DELETE return `401`;
- authenticated POST/PATCH/DELETE without CSRF return `401`;
- malformed JSON, extra fields, blank/oversized/control-character labels, and invalid digests return `400`;
- duplicate digest returns `409`;
- PATCH requires exactly `{ enabled: boolean }`;
- unknown valid UUID returns `404` for PATCH and DELETE;
- an inference JWT in `Authorization` cannot access any dashboard route.

- [ ] **Step 2: Run the new API test and verify red**

```powershell
bun test tests/dashboard-trusted-jwt-digests.test.ts
```

Expected: FAIL with route `404` responses because the handlers/routes do not exist.

- [ ] **Step 3: Add strict handlers and route registration**

In `src/routes/dashboard/api.ts`, add:

```ts
export function handleListTrustedJwtDigests(c: Context) {
  return c.json(trustedJwtDigestStore.list())
}

export async function handleAddTrustedJwtDigest(c: Context) {
  const body = await c.req.json<unknown>().catch(() => null)
  if (!isExactRecord(body, ["label", "digest"])) {
    return c.json({ error: "label and digest are required" }, 400)
  }
  try {
    return c.json(
      trustedJwtDigestStore.add({
        label: body.label as string,
        digest: body.digest as string,
      }),
    )
  } catch (error) {
    if (error instanceof TrustedJwtDigestConflictError) {
      return c.json({ error: error.message }, 409)
    }
    if (error instanceof TrustedJwtDigestValidationError) {
      return c.json({ error: error.message }, 400)
    }
    throw error
  }
}
```

Add an `isExactRecord(value, allowedKeys)` helper that requires a plain JSON object, requires exactly the expected keys, and rejects arrays/additional keys. Implement PATCH and DELETE with the same error mapping; PATCH requires exactly one boolean `enabled` property. Validate the `:id` through the store and return `404` when it is absent.

Register the four routes in `src/routes/dashboard/route.ts` after the IP Allowlist block. Import every new handler explicitly. Do not add any route outside `/dashboard/api/*`.

- [ ] **Step 4: Run dashboard and auth regressions**

```powershell
bun test tests/dashboard-trusted-jwt-digests.test.ts tests/dashboard-ip-allowlist.test.ts tests/admin-auth.test.ts tests/admin-inference-credential-boundary.test.ts
bun run lint -- src/routes/dashboard/api.ts src/routes/dashboard/route.ts tests/dashboard-trusted-jwt-digests.test.ts
```

Expected: all route and administrator-boundary tests pass.

- [ ] **Step 5: Commit the protected dashboard API**

```powershell
git add src/routes/dashboard/api.ts src/routes/dashboard/route.ts tests/dashboard-trusted-jwt-digests.test.ts
git commit -m "Add trusted JWT digest dashboard API"
```

---

### Task 4: Settings Dashboard UI

**Files:**
- Create: `tests/dashboard-settings-trusted-jwt-ui.test.ts`
- Modify: `tests/dashboard-settings-ip-allowlist-ui.test.ts`
- Modify: `ui/src/lib/types.ts`
- Modify: `ui/src/screens/Settings.tsx`
- Modify generated: `src/routes/dashboard/page-generated.ts`

**Interfaces:**
- Consumes: Task 3 dashboard routes.
- Produces UI types/helper:

```ts
export interface TrustedJwtDigestEntry {
  id: string
  label: string
  digest: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export class TrustedJwtDigestInputError extends Error {}

export function trustedJwtDigestForSubmission(
  label: string,
  digest: string,
): { label: string; digest: string }

export async function addTrustedJwtDigest(
  label: string,
  digest: string,
  requestPost: BodyRequest,
): Promise<void>
```

- Extends `SettingsBundle` with `trustedJwtDigests: Array<TrustedJwtDigestEntry>`.

- [ ] **Step 1: Write failing Settings loader/helper tests**

Create `tests/dashboard-settings-trusted-jwt-ui.test.ts`:

```ts
import { expect, test } from "bun:test"

import {
  addTrustedJwtDigest,
  loadSettingsBundle,
  TrustedJwtDigestInputError,
  trustedJwtDigestForSubmission,
} from "../ui/src/lib/types"

test("settings loader requests trusted JWT digests", async () => {
  const paths: Array<string> = []
  const result = await loadSettingsBundle(async <T>(path: string) => {
    paths.push(path)
    if (path === "/dashboard/api/settings") return settings as T
    if (path === "/dashboard/api/ip-allowlist") return [] as T
    if (path === "/dashboard/api/ip-allowlist/current") {
      return { ip: null } as T
    }
    if (path === "/dashboard/api/trusted-jwt-digests") {
      return trustedEntries as T
    }
    throw new Error(`Unexpected path: ${path}`)
  })

  expect(paths).toContain("/dashboard/api/trusted-jwt-digests")
  expect(result.trustedJwtDigests).toEqual(trustedEntries)
})

test("trusted JWT input trims labels and lowercases digests", () => {
  expect(
    trustedJwtDigestForSubmission("  Gaming PC  ", "A".repeat(64)),
  ).toEqual({ label: "Gaming PC", digest: "a".repeat(64) })
})

test("trusted JWT input rejects incomplete values before posting", async () => {
  expect(() => trustedJwtDigestForSubmission("", "a".repeat(64))).toThrow(
    TrustedJwtDigestInputError,
  )
  expect(() => trustedJwtDigestForSubmission("PC", "not-a-digest")).toThrow(
    TrustedJwtDigestInputError,
  )
})
```

Add a test for `addTrustedJwtDigest` that records one POST to `/dashboard/api/trusted-jwt-digests` with normalized values. Update every mock in `tests/dashboard-settings-ip-allowlist-ui.test.ts` to return `[]` for the new GET so existing IP tests continue testing only IP behavior.

- [ ] **Step 2: Run the UI helper tests and verify red**

```powershell
bun test tests/dashboard-settings-trusted-jwt-ui.test.ts tests/dashboard-settings-ip-allowlist-ui.test.ts
```

Expected: FAIL because the new types/helpers/bundle field do not exist.

- [ ] **Step 3: Implement types, helpers, and bundle loading**

In `ui/src/lib/types.ts`:

- add the record and error types shown above;
- require a trimmed non-empty label and `/^[a-f\d]{64}$/i` digest in `trustedJwtDigestForSubmission`;
- normalize digest to lowercase;
- POST `{ label, digest }` through `addTrustedJwtDigest`;
- request `/dashboard/api/trusted-jwt-digests` in the same `Promise.all` as settings/IP data;
- return `{ settings, allowlist, currentIp, trustedJwtDigests }`.

- [ ] **Step 4: Add the Trusted JWT Digests card**

In `ui/src/screens/Settings.tsx`:

1. Import the new helper/types.
2. Add state for `newJwtLabel`, `newJwtDigest`, and `isAddingJwtDigest`.
3. Add handlers:

```ts
const handleAddJwtDigest = async () => {
  setIsAddingJwtDigest(true)
  try {
    await addTrustedJwtDigest(newJwtLabel, newJwtDigest, post)
    toast.success("Trusted JWT digest added")
    setNewJwtLabel("")
    setNewJwtDigest("")
    reload()
  } catch (caught) {
    toast.error(errorMessage(caught, "Failed to add trusted JWT digest"))
  } finally {
    setIsAddingJwtDigest(false)
  }
}
```

Add PATCH and DELETE handlers using the entry UUID. Render table columns for label, full lowercase digest in `MonoText`, enabled `TogglePill`, `createdAt` via `RelTime`, and confirmed deletion.

Insert a new `<Card>` immediately after the existing IP Allowlist card, inside the same `ResponsivePair`. Use exact visible copy:

- Heading: `Trusted JWT Digests`
- Badge: `Inference only`
- Description: `Generate a local Codex ChatGPT auth file with the repository PowerShell script, then paste only its SHA-256 digest here.`
- Inputs: `Device label` and `SHA-256 digest`
- Empty title: `No trusted JWT digests`
- Empty description: `Generate a digest on the Codex PC, then register it here.`

Do not add a raw-token input or bulk-clear control.

- [ ] **Step 5: Build the dashboard and verify source/bundle tests**

```powershell
bun run build:ui
bun test tests/dashboard-settings-trusted-jwt-ui.test.ts tests/dashboard-settings-ip-allowlist-ui.test.ts tests/dashboard-trusted-jwt-digests.test.ts
bun run lint -- ui/src/lib/types.ts ui/src/screens/Settings.tsx tests/dashboard-settings-trusted-jwt-ui.test.ts tests/dashboard-settings-ip-allowlist-ui.test.ts
```

Add bundle assertions to `tests/dashboard-trusted-jwt-digests.test.ts` before the final run:

```ts
expect(DASHBOARD_HTML).toContain("Trusted JWT Digests")
expect(DASHBOARD_HTML).toContain("/dashboard/api/trusted-jwt-digests")
expect(DASHBOARD_HTML).not.toContain("Paste raw JWT")
```

Expected: UI/helper/API tests pass and the generated dashboard contains the new card.

- [ ] **Step 6: Commit the dashboard UI and generated bundle**

```powershell
git add ui/src/lib/types.ts ui/src/screens/Settings.tsx tests/dashboard-settings-trusted-jwt-ui.test.ts tests/dashboard-settings-ip-allowlist-ui.test.ts tests/dashboard-trusted-jwt-digests.test.ts src/routes/dashboard/page-generated.ts
git commit -m "Add trusted JWT digest settings controls"
```

---

### Task 5: Windows Codex ChatGPT Auth Generator

**Files:**
- Create: `scripts/enable-codex-desktop-chatgpt-auth.ps1`
- Create: `tests/codex-desktop-auth-script.test.ts`

**Interfaces:**
- Script parameters:

```powershell
param(
  [string]$CodexHome,
  [string]$Email,
  [switch]$SkipClipboard
)
```

- Default `CodexHome`: the current user's `.codex` directory.
- Default email: the `codex-` prefix, a lowercase sanitized machine name, and the `@local.invalid` suffix.
- Stable output markers:

```text
TRUSTED_JWT_SHA256_BEGIN
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
TRUSTED_JWT_SHA256_END
```

- [ ] **Step 1: Write the failing cross-process script tests**

Create `tests/codex-desktop-auth-script.test.ts`. Resolve PowerShell with `Bun.which("pwsh") ?? Bun.which("powershell")`, skip only when neither executable exists, and run with `-NoLogo -NoProfile -NonInteractive -File`.

Use this helper contract:

```ts
async function runScript(codexHome: string): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  digest: string
}> {
  const process = Bun.spawn([
    powershell!,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    scriptPath,
    "-CodexHome",
    codexHome,
    "-Email",
    "device@example.invalid",
    "-SkipClipboard",
  ], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  const match = /TRUSTED_JWT_SHA256_BEGIN\s+([a-f\d]{64})\s+TRUSTED_JWT_SHA256_END/.exec(
    stdout,
  )
  return { exitCode, stdout, stderr, digest: match?.[1] ?? "" }
}
```

Write tests that verify:

1. `auth.json` contains `auth_mode: "chatgpt"`, `OPENAI_API_KEY: null`, equal access/ID JWTs, a `local_` refresh token, matching account IDs, and `last_refresh: "2099-01-01T00:00:00Z"`.
2. JWT header/payload contain the exact issuer, audience, email/profile, distinct user/account IDs matching `^local-dictation-[a-f0-9]{32}$`, `plus` plan, and subject equal to the user ID.
3. The third segment is non-empty and every JWT segment is base64url text.
4. The printed digest equals Node SHA-256 of the access token.
5. Stdout/stderr contain neither the raw JWT nor refresh token.
6. Two runs create different JWTs, refresh tokens, IDs, and digests.
7. The second run preserves the first `auth.json` byte-for-byte at the printed backup path.
8. A sentinel `config.toml` remains unchanged and no file outside `auth.json`/`backups` is created beneath the temporary Codex home.
9. `-SkipClipboard` completes successfully and prints instructions for manual copying.

- [ ] **Step 2: Run the script test and verify red**

```powershell
bun test tests/codex-desktop-auth-script.test.ts
```

Expected: FAIL because `scripts/enable-codex-desktop-chatgpt-auth.ps1` does not exist.

- [ ] **Step 3: Implement the dependency-free PowerShell script**

Implement these helpers using .NET APIs available in Windows PowerShell 5.1:

```powershell
function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertTo-JsonBase64Url($Value) {
  $json = $Value | ConvertTo-Json -Depth 10 -Compress
  return ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($json))
}

function New-RandomBase64Url([int]$Length = 32) {
  $bytes = New-Object byte[] $Length
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return ConvertTo-Base64Url $bytes
}

function Get-Sha256Hex([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}
```

Build ordered header/payload objects with:

```powershell
$userId = "local-dictation-$([Guid]::NewGuid().ToString('N'))"
$accountId = "local-dictation-$([Guid]::NewGuid().ToString('N'))"
$issuedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
```

Generate the JWT by joining the header, payload, and a 32-random-byte base64url signature segment with periods. Generate the refresh token with the `local_` prefix followed by 32 random bytes encoded as base64url.

Serialize the exact auth shape with `ConvertTo-Json -Depth 10`, append one newline, and write it with `New-Object Text.UTF8Encoding($false)` to a same-directory temporary file. If an existing `auth.json` exists:

1. create a unique `backups/codex-chatgpt-auth-YYYYMMDDTHHMMSSZ-xxxxxxxx/` directory, where the suffix is eight random hexadecimal characters;
2. copy the exact original file to `auth.json` in that directory;
3. replace the destination with `[IO.File]::Replace($temporaryPath, $authPath, $null)`.

For a new destination use `[IO.File]::Move`. Always remove an abandoned temporary path in `finally`.

Attempt `Set-Clipboard -Value $digest -ErrorAction Stop` unless `-SkipClipboard` is set. Catch clipboard errors and continue. Print only paths, whether the clipboard succeeded/skipped, the stable digest marker block, the dashboard instruction, and the Codex restart instruction.

- [ ] **Step 4: Verify with PowerShell 7 and Windows PowerShell 5.1**

Run the automated test, then two isolated manual invocations:

```powershell
bun test tests/codex-desktop-auth-script.test.ts

$pwshHome = Join-Path $env:TEMP "codex-auth-pwsh-$([guid]::NewGuid())"
pwsh -NoLogo -NoProfile -File scripts/enable-codex-desktop-chatgpt-auth.ps1 -CodexHome $pwshHome -SkipClipboard

$winPsHome = Join-Path $env:TEMP "codex-auth-winps-$([guid]::NewGuid())"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/enable-codex-desktop-chatgpt-auth.ps1 -CodexHome $winPsHome -SkipClipboard
```

Parse both produced files with `ConvertFrom-Json`, independently recompute each digest, then remove only those two temporary directories. Expected: both engines exit 0 and produce matching digests without exposing tokens.

- [ ] **Step 5: Lint/check and commit the script**

```powershell
bun run lint -- tests/codex-desktop-auth-script.test.ts
git diff --check
git add scripts/enable-codex-desktop-chatgpt-auth.ps1 tests/codex-desktop-auth-script.test.ts
git commit -m "Add Codex ChatGPT auth generator script"
```

---

### Task 6: Documentation, Generated UI, and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Verify generated: `src/routes/dashboard/page-generated.ts`

**Interfaces:**
- Documents script: `scripts/enable-codex-desktop-chatgpt-auth.ps1`.
- Documents portal: `https://ai.ashesh.dev/dashboard#settings` and generic `/dashboard#settings`.
- Documents persisted file: `trusted_jwt_digests.json`.

- [ ] **Step 1: Document the complete two-party flow**

In README's Operator dashboard bullets, add `managed inference-only Codex JWT digests` next to managed IP allowlists.

In `### Codex Desktop`, add this command and flow:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-codex-desktop-chatgpt-auth.ps1
```

State explicitly:

- the script backs up an existing `%USERPROFILE%\.codex\auth.json`;
- it writes a local compatibility identity, not a real OpenAI login;
- it prints and attempts to copy a 64-character SHA-256 digest;
- the user/admin pastes only that digest plus a device label into **Settings → Trusted JWT Digests**;
- `https://ai.ashesh.dev/dashboard#settings` is the production portal for this deployment;
- the user must fully quit/reopen Codex Desktop after the file changes;
- the script deliberately does not configure `config.toml`, certificates, hosts/DNS, environment variables, or networking.

Add `trusted_jwt_digests.json` to the persistent-data table with the description `Dashboard-managed SHA-256 digests for inference-only local Codex JWTs`.

In `SECURITY.md`, document that the server stores digests only, literal digests are rejected as credentials, enabled raw matches receive only `user:inference`, and dashboard changes require administrator session plus CSRF.

- [ ] **Step 2: Rebuild the dashboard from source**

```powershell
bun run build:ui
git status --short
```

Expected: `src/routes/dashboard/page-generated.ts` reflects `ui/src`; no hand edit is present.

- [ ] **Step 3: Run focused feature verification**

```powershell
bun test tests/trusted-jwt-digests-store.test.ts tests/credential-resolver.test.ts tests/admin-inference-credential-boundary.test.ts tests/oauth-api-route.test.ts tests/dashboard-trusted-jwt-digests.test.ts tests/dashboard-settings-trusted-jwt-ui.test.ts tests/dashboard-settings-ip-allowlist-ui.test.ts tests/codex-desktop-auth-script.test.ts
bun run lint -- src/lib/trusted-jwt-digests.ts src/lib/paths.ts src/lib/credential-resolver.ts src/routes/dashboard/api.ts src/routes/dashboard/route.ts ui/src/lib/types.ts ui/src/screens/Settings.tsx tests/trusted-jwt-digests-store.test.ts tests/credential-resolver.test.ts tests/admin-inference-credential-boundary.test.ts tests/dashboard-trusted-jwt-digests.test.ts tests/dashboard-settings-trusted-jwt-ui.test.ts tests/dashboard-settings-ip-allowlist-ui.test.ts tests/codex-desktop-auth-script.test.ts
bun run typecheck
```

Expected: all focused tests pass, changed-file lint exits 0, and typecheck exits 0.

- [ ] **Step 4: Run the complete CI-equivalent verification**

Use the pinned Bun 1.3.14 runtime. Run:

```powershell
bun run lint:all
bun run typecheck
bun run build:ui

$failed = @()
$passed = 0
Get-ChildItem tests -File -Filter *.test.ts | Sort-Object Name | ForEach-Object {
  bun test $_.FullName
  if ($LASTEXITCODE -eq 0) { $passed += 1 } else { $failed += $_.Name }
}
if ($failed.Count -gt 0) { throw "Failed test files: $($failed -join ', ')" }
Write-Output "Passed test files: $passed"

bun run build
git diff --check
git status --short
```

Expected: lint, typecheck, UI build, every isolated test file, production build, and whitespace check all succeed. The status contains only intended feature files.

- [ ] **Step 5: Commit documentation or hook-generated changes**

```powershell
git add README.md SECURITY.md src/routes/dashboard/page-generated.ts
git commit -m "Document trusted Codex JWT enrollment"
```

If the generated page was already committed unchanged in Task 4, stage only README and SECURITY. Re-run `git status --short` after the hook and commit any legitimate formatting change in a separate, named commit rather than amending unrelated history.

---

### Task 7: Review, PR, Merge, and Production Deployment

**Files:**
- No new source files expected.
- Production data migration: `/root/copilot-api` `.env` and `DATA_DIR/trusted_jwt_digests.json` only after backups.

**Interfaces:**
- Deploy target: repository default branch, verified before merge (currently `master`).
- Production checkout: `/root/copilot-api`.
- Public dashboard: `https://ai.ashesh.dev/dashboard#settings`.

- [ ] **Step 1: Review the branch against the approved spec**

Read the complete diff from merge base:

```powershell
git diff --stat origin/master...HEAD
git diff origin/master...HEAD -- src ui/src scripts tests README.md SECURITY.md
```

Check each spec requirement explicitly: client-only raw JWT, digest-only server input, inference-only resolver result, literal-digest rejection, immediate disable/delete, admin/CSRF protection, script backup/atomic replacement, excluded system setup, dashboard placement, documentation, and no config-export inclusion.

- [ ] **Step 2: Run fresh pre-PR verification**

Repeat Task 6 Step 4 without relying on earlier output. Do not create the PR if any command exits nonzero.

- [ ] **Step 3: Push and create the pull request**

```powershell
git push -u origin codex/trusted-jwt-digests
$prBody = Join-Path $env:TEMP "trusted-jwt-digests-pr.md"
@'
## Summary
- add a Windows script that backs up and writes a local ChatGPT-shaped Codex auth file
- add administrator-managed, persistent SHA-256 digest registration in Settings
- keep every registered JWT inference-only and reject digest literals as credentials

## Verification
- focused trusted-digest, resolver, dashboard, and PowerShell tests
- full isolated test-file suite
- lint, typecheck, dashboard build, and production build

## Explicit exclusions
- no certificate, hosts, environment-variable, networking, or config.toml changes
'@ | Set-Content -LiteralPath $prBody -Encoding utf8
gh pr create --base master --head codex/trusted-jwt-digests --title "Add trusted Codex JWT setup" --body-file $prBody
```

The PR body must summarize the script, dashboard registry, inference boundary, tests, and explicit exclusions. Do not use AI/bot/automation wording in the title.

- [ ] **Step 4: Wait for required checks and merge using repository policy**

```powershell
$prNumber = gh pr view --json number --jq .number
gh pr checks $prNumber --watch
gh pr merge $prNumber --squash --delete-branch
git fetch origin --prune
```

Verify the repository default branch with `gh repo view --json defaultBranchRef` rather than assuming. Capture the verified PR head commit before merge and the merged default-branch commit after fetch, then compare their trees with `git show -s --format=%T $prHeadCommit` and `git show -s --format=%T $mergeCommit`. Confirm the remote feature branch is deleted.

- [ ] **Step 5: Fast-forward the canonical checkout without touching unrelated files**

In `F:\Projects\copilot-api`, verify the pre-existing untracked feedback/dev files are unchanged, then:

```powershell
git fetch origin --prune
git merge --ff-only origin/master
```

Do not clean, stash, add, or delete the unrelated untracked files.

- [ ] **Step 6: Back up and deploy the clean production checkout**

Connect with the existing Infinity VPS route. On the server:

```sh
cd /root/copilot-api
git status --short --branch
git fetch origin --prune
git merge --ff-only origin/master
backup_dir="/root/copilot-api-backups/trusted-jwt-digests-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
cp -a .env "$backup_dir/.env"
volume_name="$(docker volume inspect copilot-api_copilot-data --format '{{.Name}}')"
[ "$volume_name" = "copilot-api_copilot-data" ]
docker run --rm -v "$volume_name:/data:ro" -v "$backup_dir:/backup" alpine:3.22 sh -c '[ ! -e /data/trusted_jwt_digests.json ] || cp -a /data/trusted_jwt_digests.json /backup/'
./update.sh
```

Confirm application health and that the server checkout equals the merged commit. Keep all registry migration writes inside a temporary helper container mounted to the named data volume; do not guess a host path for Docker-managed volume contents.

- [ ] **Step 7: Migrate active environment digests without printing them**

Use a local-on-server Python helper to read the current `.env`, validate every comma-separated value as 64 lowercase/uppercase hex characters, and write a temporary version-1 registry file containing any missing values with random UUIDs and labels such as `Migrated production JWT 1`. The helper must print counts only, never digest values. Copy that prepared file into the named data volume with a short-lived helper container, enforce mode `0600`, and atomically rename it to `/data/trusted_jwt_digests.json` inside the volume.

Restart through `./update.sh`, then use the current PC's raw JWT directly from its local `auth.json` in a request without echoing it. Verify inference returns a successful authenticated response and a request using the digest literal returns `401`.

Only after the raw JWT succeeds from the managed registry:

1. remove `COPILOT_INFERENCE_CREDENTIAL_SHA256S` from production `.env` without printing its value;
2. run `./update.sh` again;
3. verify the same raw JWT still succeeds;
4. verify the literal digest still returns `401`;
5. confirm `trusted_jwt_digests.json` is mode `0600` and the service remains healthy.

If managed verification fails, restore the backed-up `.env`, run `./update.sh`, verify service recovery, and leave the registry file for offline diagnosis without deleting the backup.

- [ ] **Step 8: Verify the live dashboard workflow**

Through an authenticated administrator browser session at `https://ai.ashesh.dev/dashboard#settings`:

1. confirm **Trusted JWT Digests** appears next to IP Allowlist on a wide viewport;
2. add a temporary test digest with a non-production label;
3. confirm it appears enabled;
4. disable it and confirm a request with its raw test credential returns `401`;
5. enable it and confirm inference authentication succeeds;
6. delete it and confirm the next request returns `401`;
7. confirm the production device entry remains enabled throughout.

Do not use the current production JWT for the disable/delete smoke.

- [ ] **Step 9: Final evidence report**

Record:

- merged PR URL and merge commit;
- isolated test-file pass/fail totals;
- lint/typecheck/build exit status;
- production checkout commit and health result;
- managed raw-JWT success and digest-literal rejection;
- dashboard add/disable/enable/delete smoke results;
- backup directory;
- confirmation that unrelated main-checkout files were preserved.
