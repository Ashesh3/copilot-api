/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun promise matchers must be awaited. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import {
  leaseAccount,
  withAccountLeaseScope,
} from "~/lib/account-lease-context"
import { forwardError } from "~/lib/error"
import {
  routedAccountStorage,
  setLastUsedRoutedAccountId,
} from "~/lib/request-session"
import { runWithRoutingAffinity } from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { createAccountDistributionRepository } from "~/lib/storage/account-distribution-repository"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { codexSearchRoutes } from "~/routes/codex-search/route"
import {
  executeWebSearch,
  resetWebSearchSessionsForTest,
} from "~/services/copilot/mcp-web-search"

import { createAuthStorageFixture } from "./helpers/auth-storage"

let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
const originalFetch = globalThis.fetch
const originalMulti = state.isMultiToken
const MODEL = "search-owner-model"
const OWNER = 70
const OTHER = 71
const sentCredentials: Array<string | null> = []

beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  state.isMultiToken = true
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  for (const id of [OWNER, OTHER]) {
    const account = tokenPool.addAccount(`search-token-${id}`, "individual", id)
    account.healthy = true
    account.models = new Set([MODEL])
    account.credentialRevision = 1
  }
  tokenPool.rebuildModelIndex()
  await fixture.storage.transaction(async (session) => {
    for (const id of [OWNER, OTHER])
      await session.execute({
        sql: "INSERT INTO capi_accounts(id,domain,enabled,credential_revision,created_at,updated_at) VALUES(?,'github.com',1,1,0,0)",
        args: [id],
      })
  })
  await repository().replace([{ accountId: OTHER, percentage: 100 }], {
    operationId: randomUUID(),
    expectedRevision: 0,
    actorId: "test:web-search",
    kind: "distribution",
    inputDigest: "synthetic",
  })
  resetWebSearchSessionsForTest()
  sentCredentials.length = 0
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as { method: string }
    sentCredentials.push(new Headers(init?.headers).get("authorization"))
    return Promise.resolve(
      request.method === "initialize" ?
        Response.json(
          { jsonrpc: "2.0", result: {} },
          { headers: { "Mcp-Session-Id": "fixture-session" } },
        )
      : Response.json({
          jsonrpc: "2.0",
          result: { content: [{ type: "text", text: "Synthetic result" }] },
        }),
    )
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  state.isMultiToken = originalMulti
  resetWebSearchSessionsForTest()
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  await fixture.close()
})

function repository() {
  return createAccountDistributionRepository(fixture.storage)
}

async function remember(key: string, accountId = OWNER) {
  return repository().assign({
    affinityKey: key,
    modelId: MODEL,
    eligibleAccountIds: [OWNER, OTHER],
    preferredAccountId: accountId,
    preferredReason: "pinned",
  })
}

function toolIdFor(accountId: number) {
  for (let index = 0; index < 100; index++) {
    const key = `tool-call-${index}`
    if (tokenPool.getAccountForModelBySession(MODEL, key)?.id === accountId)
      return key
  }
  throw new Error("Missing synthetic affinity")
}

function search(affinityKey?: string, toolId = toolIdFor(OTHER)) {
  return withRequestSnapshot(getStorageRuntime().snapshot.get(), () =>
    runWithRoutingAffinity(
      affinityKey ? { key: affinityKey, source: "codex_thread" } : undefined,
      () =>
        routedAccountStorage.run({}, () =>
          executeWebSearch("synthetic query", undefined, {
            modelId: MODEL,
            sessionId: toolId,
          }),
        ),
    ),
  )
}

test("standalone search honors the effective conversation owner at zero share instead of its tool ID", async () => {
  const toolId = toolIdFor(OTHER)
  await remember("recorded-conversation")
  expect(await search("recorded-conversation", toolId)).toBe("Synthetic result")
  expect(sentCredentials).toEqual([
    "Bearer search-token-70",
    "Bearer search-token-70",
  ])
  expect(await repository().lookup(toolId)).toBeUndefined()
})

test.each([
  "unhealthy",
  "disabled",
  "deleting",
  "removed",
  "model-unavailable",
] as const)(
  "does not move standalone search when its owner is %s",
  async (condition) => {
    await remember("recorded-conversation")
    const owner = tokenPool
      .getAllAccounts()
      .find((account) => account.id === OWNER)
    if (!owner) throw new Error("Missing synthetic owner")
    if (condition === "unhealthy") owner.healthy = false
    if (condition === "disabled") owner.enabled = false
    if (condition === "deleting") owner.deleting = true
    if (condition === "removed") tokenPool.deleteAccount(OWNER)
    if (condition === "model-unavailable") owner.models.clear()
    tokenPool.rebuildModelIndex()
    await expect(search("recorded-conversation")).rejects.toMatchObject({
      response: { status: 409 },
      clientBody: { error: { code: "conversation_account_unavailable" } },
    })
    expect(sentCredentials).toEqual([])
    expect(await repository().lookup("recorded-conversation")).toBe(OWNER)
  },
)

test("unmapped standalone searches keep legacy selection without recording a tool or conversation root", async () => {
  const toolId = toolIdFor(OTHER)
  expect(await search("new-conversation", toolId)).toBe("Synthetic result")
  expect(sentCredentials).toEqual([
    "Bearer search-token-71",
    "Bearer search-token-71",
  ])
  expect(await repository().lookup("new-conversation")).toBeUndefined()
  expect(await repository().lookup(toolId)).toBeUndefined()
})

test("a tool ID alone is not treated as a recorded conversation identity", async () => {
  const toolId = toolIdFor(OTHER)
  await remember(toolId)
  expect(await search(undefined, toolId)).toBe("Synthetic result")
  expect(sentCredentials).toEqual([
    "Bearer search-token-71",
    "Bearer search-token-71",
  ])
})

test("an unmapped search without accounts retains the generic tool error response", async () => {
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  expect(await search(undefined, "unmapped-tool")).toBe(
    "Web search failed: No healthy configured account is available for this request.",
  )
  expect(sentCredentials).toEqual([])
})

test("standalone search returns the structured continuity error through its HTTP route", async () => {
  const toolId = toolIdFor(OTHER)
  await remember("recorded-conversation")
  tokenPool.deleteAccount(OWNER)
  const app = new Hono()
  app.use("*", (_context, next) =>
    withRequestSnapshot(getStorageRuntime().snapshot.get(), () =>
      runWithRoutingAffinity(
        { key: "recorded-conversation", source: "codex_thread" },
        next,
      ),
    ),
  )
  app.onError((error, context) => forwardError(context, error))
  app.route("/alpha/search", codexSearchRoutes)
  const response = await app.request("/alpha/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: toolId,
      model: MODEL,
      commands: { search_query: [{ q: "synthetic query" }] },
    }),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    error: { code: "conversation_account_unavailable" },
  })
  expect(sentCredentials).toEqual([])
})

test("inline searches retain the admitted account lease through an account disable", async () => {
  await remember("recorded-conversation")
  const owner = tokenPool
    .getAllAccounts()
    .find((account) => account.id === OWNER)
  if (!owner) throw new Error("Missing synthetic owner")
  await withRequestSnapshot(getStorageRuntime().snapshot.get(), () =>
    runWithRoutingAffinity(
      { key: "recorded-conversation", source: "codex_thread" },
      () =>
        routedAccountStorage.run({}, () =>
          withAccountLeaseScope(undefined, async () => {
            leaseAccount(owner)
            setLastUsedRoutedAccountId(OWNER)
            owner.enabled = false
            tokenPool.rebuildModelIndex()
            expect(
              await executeWebSearch("synthetic query", undefined, {
                modelId: MODEL,
                sessionId: toolIdFor(OTHER),
              }),
            ).toBe("Synthetic result")
          }),
        ),
    ),
  )
  expect(sentCredentials).toEqual([
    "Bearer search-token-70",
    "Bearer search-token-70",
  ])
})
