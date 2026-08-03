# Model Routing GitHub Usernames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each token's GitHub username as muted supporting text beneath its stable Model Routing account number.

**Architecture:** Resolve the authenticated GitHub login once during token-pool account initialization and cache it as optional in-memory account metadata. Return that non-secret metadata from the authenticated Model Routing API, then format it through a small UI helper so both visible and accessible labels share the same fallback behavior.

**Tech Stack:** Bun, TypeScript, Hono, React 19, Astryx Design System, Vite, Bun test runner

---

## File Structure

- Modify `src/services/github/get-user.ts` so callers can resolve a user with an explicit account token while preserving the existing single-token default.
- Modify `src/lib/token-pool.ts` to cache `githubUsername?: string` and make username lookup non-fatal during initialization.
- Modify `src/routes/dashboard/api.ts` to expose only the optional username, never the token.
- Modify `ui/src/lib/types.ts` to describe the optional API field.
- Create `ui/src/lib/model-routing.ts` for the account detail and accessible-summary formatting rules.
- Modify `ui/src/screens/ModelRouting.tsx` to render the formatted muted subtext.
- Modify `tests/account-router.test.ts` for account-initialization behavior.
- Create `tests/dashboard-model-routing.test.ts` for API secrecy, formatting fallbacks, and generated-bundle coverage.
- Regenerate `src/routes/dashboard/page-generated.ts` from the UI source.

### Task 1: Resolve and cache each account's GitHub username

**Files:**
- Modify: `tests/account-router.test.ts:188-209`
- Modify: `src/services/github/get-user.ts:1-22`
- Modify: `src/lib/token-pool.ts:17-130, 394-414`

- [ ] **Step 1: Write failing account-initialization tests**

Add these tests after the existing multi-token model-discovery test in `tests/account-router.test.ts`:

```ts
test("resolves the GitHub username during account initialization", async () => {
  const account = tokenPool.addAccount(
    "github-username-token",
    "individual",
    1111,
  )
  queuedResults.push(
    new Response(
      JSON.stringify({
        token: "copilot-username-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ login: "octocat" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )

  await tokenPool.initializeAccount(account)

  expect(account.githubUsername).toBe("octocat")
  expect(capturedRequests[2]?.url).toBe("https://api.github.com/user")
  expect(capturedRequests[2]?.init?.headers).toMatchObject({
    authorization: "token github-username-token",
  })
})

test("keeps an account healthy when GitHub username lookup fails", async () => {
  const account = tokenPool.addAccount(
    "github-username-failure-token",
    "individual",
    1112,
  )
  queuedResults.push(
    new Response(
      JSON.stringify({
        token: "copilot-username-failure-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response("Service unavailable", { status: 503 }),
  )

  await tokenPool.initializeAccount(account)

  expect(account.healthy).toBe(true)
  expect(account.githubUsername).toBeUndefined()
  expect(capturedRequests[2]?.url).toBe("https://api.github.com/user")
})
```

- [ ] **Step 2: Run the focused test and verify the new assertions fail**

Run: `bun test tests/account-router.test.ts`

Expected: FAIL because `Account` has no `githubUsername` and initialization does not request `/user`.

- [ ] **Step 3: Add explicit-token user lookup and non-fatal caching**

Change `src/services/github/get-user.ts` so the current single-account call still works and token-pool callers can pass the account token:

```ts
export async function getGitHubUser(githubToken = state.githubToken) {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      authorization: `token ${githubToken}`,
      ...standardHeaders(),
    },
  })

  if (!response.ok) throw new HTTPError("Failed to get GitHub user", response)

  return (await response.json()) as GithubUserResponse
}
```

Import `getGitHubUser` in `src/lib/token-pool.ts`, add the optional account field, and resolve it after models have loaded:

```ts
import { getGitHubUser } from "~/services/github/get-user"

export interface Account {
  id: number
  githubToken: string
  githubUsername?: string
  copilotToken?: string
  copilotTokenExpiry?: number
  models: Set<string>
  modelsData: Array<Model>
  accountType: string
  healthy: boolean
}
```

```ts
    account.modelsData = modelsResponse.data
    // eslint-disable-next-line require-atomic-updates
    account.models = new Set(modelsResponse.data.map((m) => m.id))

    await this.resolveGitHubUsername(account)

    consola.info(
      `Account #${account.id} (${account.accountType}): ${account.models.size} models available`,
    )
```

Add this private helper immediately before `fetchCopilotToken`:

```ts
  private async resolveGitHubUsername(account: Account): Promise<void> {
    try {
      const user = await getGitHubUser(account.githubToken)
      // eslint-disable-next-line require-atomic-updates
      account.githubUsername = user.login
    } catch (error) {
      consola.warn(
        `Failed to resolve GitHub username for account #${account.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
```

Also append a successful `{ "login": "model-user" }` response to the queue in the pre-existing `disables pooling for multi-token model discovery` test so it exercises the complete initialization path without an intentional warning.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `bun test tests/account-router.test.ts`

Expected: PASS, including the successful lookup and non-fatal failure cases.

- [ ] **Step 5: Commit the account metadata change**

```powershell
git add -- src/services/github/get-user.ts src/lib/token-pool.ts tests/account-router.test.ts
git commit -m "feat: resolve GitHub usernames for token accounts"
```

### Task 2: Return the username from the authenticated dashboard API

**Files:**
- Create: `tests/dashboard-model-routing.test.ts`
- Modify: `src/routes/dashboard/api.ts:598-619`
- Modify: `ui/src/lib/types.ts:135-140`

- [ ] **Step 1: Write the failing dashboard API regression test**

Create `tests/dashboard-model-routing.test.ts` with the authenticated route test:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test"

import type { Account } from "../src/lib/token-pool"
import type { ModelRouting } from "../ui/src/lib/types"

import { tokenPool } from "../src/lib/token-pool"
import { server } from "../src/server"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

const ACCOUNT_ID = 8301
const GITHUB_TOKEN = "dashboard-model-routing-secret-token"
let account: Account
let adminSession: TestAdminSession

beforeAll(async () => {
  adminSession = await createTestAdminSession()
  account = tokenPool.addAccount(GITHUB_TOKEN, "individual", ACCOUNT_ID)
  account.githubUsername = "octocat"
  account.healthy = true
  account.models = new Set(["dashboard-routing-model"])
})

afterAll(() => {
  account.githubUsername = undefined
  account.healthy = false
  account.models.clear()
  account.modelsData = []
  resetTestAdminSession()
})

test("model routing requires dashboard authentication", async () => {
  const response = await server.request("/dashboard/api/model-routing")

  expect(response.status).toBe(401)
})

test("model routing returns usernames without exposing GitHub tokens", async () => {
  const response = await server.request("/dashboard/api/model-routing", {
    headers: adminHeaders(adminSession, false),
  })
  const body = (await response.json()) as ModelRouting
  const listedAccount = body.accounts.find(
    (candidate) => candidate.id === ACCOUNT_ID,
  )

  expect(response.status).toBe(200)
  expect(listedAccount).toEqual({
    id: ACCOUNT_ID,
    accountType: "individual",
    githubUsername: "octocat",
    healthy: true,
    modelsCount: 1,
  })
  expect(JSON.stringify(body)).not.toContain(GITHUB_TOKEN)
  expect(Object.hasOwn(listedAccount ?? {}, "githubToken")).toBe(false)
})
```

- [ ] **Step 2: Run the API test and verify it fails**

Run: `bun test tests/dashboard-model-routing.test.ts`

Expected: FAIL because the returned account object does not contain `githubUsername`.

- [ ] **Step 3: Expose the optional non-secret field and update the UI contract**

Add the field to the account mapping in `src/routes/dashboard/api.ts`:

```ts
  const accounts = tokenPool.getAllAccounts().map((account) => ({
    id: account.id,
    accountType: account.accountType,
    githubUsername: account.githubUsername,
    healthy: account.healthy,
    modelsCount: account.models.size,
  }))
```

Add the matching optional field in `ui/src/lib/types.ts`:

```ts
export interface ModelRoutingAccount {
  id: number
  accountType: string
  githubUsername?: string
  healthy: boolean
  modelsCount: number
}
```

- [ ] **Step 4: Run the API test and verify it passes**

Run: `bun test tests/dashboard-model-routing.test.ts`

Expected: PASS with the username present and the raw GitHub token absent.

- [ ] **Step 5: Commit the API contract change**

```powershell
git add -- src/routes/dashboard/api.ts ui/src/lib/types.ts tests/dashboard-model-routing.test.ts
git commit -m "feat: expose account usernames to model routing"
```

### Task 3: Render muted username subtext with a quiet fallback

**Files:**
- Modify: `tests/dashboard-model-routing.test.ts`
- Create: `ui/src/lib/model-routing.ts`
- Modify: `ui/src/screens/ModelRouting.tsx:13-16, 89-113`
- Regenerate: `src/routes/dashboard/page-generated.ts`

- [ ] **Step 1: Add failing formatter and generated-bundle tests**

Extend the imports in `tests/dashboard-model-routing.test.ts`:

```ts
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import {
  formatModelRoutingAccountDetails,
  formatModelRoutingAccountSummary,
} from "../ui/src/lib/model-routing"
```

Add these tests:

```ts
test("formats a GitHub username as muted account supporting text", () => {
  const accountWithUsername = {
    id: 3,
    accountType: "individual",
    githubUsername: "octocat",
    healthy: true,
    modelsCount: 46,
  }

  expect(formatModelRoutingAccountDetails(accountWithUsername)).toBe(
    "@octocat · 46 models",
  )
  expect(formatModelRoutingAccountSummary(accountWithUsername)).toBe(
    "Account #3, @octocat, individual, Healthy",
  )
})

test("omits unavailable usernames from account labels", () => {
  const accountWithoutUsername = {
    id: 3,
    accountType: "individual",
    healthy: false,
    modelsCount: 46,
  }

  expect(formatModelRoutingAccountDetails(accountWithoutUsername)).toBe(
    "46 models",
  )
  expect(formatModelRoutingAccountSummary(accountWithoutUsername)).toBe(
    "Account #3, individual, Unhealthy",
  )
})

test("dashboard bundle ships GitHub username account labels", () => {
  expect(DASHBOARD_HTML).toContain("githubUsername")
  expect(DASHBOARD_HTML).toContain(" · ")
})
```

- [ ] **Step 2: Run the dashboard test and verify the new tests fail**

Run: `bun test tests/dashboard-model-routing.test.ts`

Expected: FAIL because `ui/src/lib/model-routing.ts` does not exist and the generated bundle lacks `githubUsername`.

- [ ] **Step 3: Implement the shared account-label formatting**

Create `ui/src/lib/model-routing.ts`:

```ts
import type { ModelRoutingAccount } from "./types"

export function formatModelRoutingAccountDetails(
  account: ModelRoutingAccount,
): string {
  const models = `${account.modelsCount} models`
  return account.githubUsername ?
      `@${account.githubUsername} · ${models}`
    : models
}

export function formatModelRoutingAccountSummary(
  account: ModelRoutingAccount,
): string {
  const username =
    account.githubUsername ? `, @${account.githubUsername}` : ""
  const health = account.healthy ? "Healthy" : "Unhealthy"
  return `Account #${account.id}${username}, ${account.accountType}, ${health}`
}
```

Import both helpers in `ui/src/screens/ModelRouting.tsx` and replace the inline summary/detail construction:

```ts
import {
  formatModelRoutingAccountDetails,
  formatModelRoutingAccountSummary,
} from "../lib/model-routing"
```

```tsx
        ...data.accounts.map((account): TableColumn<ModelRow> => {
          const accountSummary = formatModelRoutingAccountSummary(account)
          const accountDetails = formatModelRoutingAccountDetails(account)

          return {
            key: `account-${account.id}`,
            header: (
              <div aria-label={accountSummary} title={accountSummary}>
                <HStack gap={1.5} vAlign="center" hAlign="center" width="100%">
                  <StatusDot
                    variant={account.healthy ? "success" : "error"}
                    label={accountSummary}
                    tooltip={accountSummary}
                  />
                  <VStack gap={0} hAlign="start">
                    <Text weight="medium">Account #{account.id}</Text>
                    <Text type="supporting">{accountDetails}</Text>
                  </VStack>
                </HStack>
              </div>
            ),
            width: pixel(180),
```

The `supporting` text style supplies the requested muted/grey treatment. The wider column accommodates the username without changing routing behavior.

- [ ] **Step 4: Typecheck and regenerate the dashboard bundle**

Run: `npm --prefix ui run typecheck`

Expected: PASS.

Run: `bun run build:ui`

Expected: PASS and update `src/routes/dashboard/page-generated.ts` from the React source.

- [ ] **Step 5: Run the dashboard regression test and verify it passes**

Run: `bun test tests/dashboard-model-routing.test.ts`

Expected: PASS for username formatting, missing-username fallback, API secrecy, and generated-bundle content.

- [ ] **Step 6: Commit the UI change and generated artifact**

```powershell
git add -- ui/src/lib/model-routing.ts ui/src/screens/ModelRouting.tsx tests/dashboard-model-routing.test.ts src/routes/dashboard/page-generated.ts
git commit -m "feat: label model routing accounts by GitHub user"
```

### Task 4: Verify the complete change

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run focused linting**

Run:

```powershell
bun run lint -- src/services/github/get-user.ts src/lib/token-pool.ts src/routes/dashboard/api.ts ui/src/lib/types.ts ui/src/lib/model-routing.ts ui/src/screens/ModelRouting.tsx tests/account-router.test.ts tests/dashboard-model-routing.test.ts
```

Expected: PASS with no lint errors.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/account-router.test.ts tests/dashboard-model-routing.test.ts`

Expected: PASS.

- [ ] **Step 3: Run root and UI typechecks**

Run: `bun run typecheck`

Expected: PASS.

Run: `npm --prefix ui run typecheck`

Expected: PASS.

- [ ] **Step 4: Verify both builds**

Run: `bun run build:ui`

Expected: PASS with no additional diff after deterministic regeneration.

Run: `bun run build`

Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `bun test`

Expected: PASS with no regressions.

- [ ] **Step 6: Inspect the final diff and repository state**

Run:

```powershell
git diff --check
git status --short
git log -4 --oneline
```

Expected: no whitespace errors, no unintended files, and the three focused implementation commits above the approved design/plan commits.
