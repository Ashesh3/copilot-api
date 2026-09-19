/* eslint-disable @typescript-eslint/require-await -- The synthetic validator preserves the asynchronous upstream interface. */
/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun asynchronous matchers must be awaited. */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import {
  routedControlPlaneFetch,
  routedFetch,
  runWithRoutedModelSelection,
  selectRoutedModel,
} from "~/lib/account-router"
import {
  AccountsService,
  createAccountMutationContext,
} from "~/lib/accounts-service"
import { getAccountsService } from "~/lib/accounts-service"
import { mergeConfigWithDefaults } from "~/lib/config"
import { GitHubDeviceLoginService } from "~/lib/github-device-login"
import {
  installResponsesRoutingAffinity,
  runWithRoutingAffinity,
} from "~/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshotForTest,
  resetRoutingTelemetryForTest,
} from "~/lib/routing-telemetry"
import { state } from "~/lib/state"
import { createAccountDistributionRepository } from "~/lib/storage/account-distribution-repository"
import { withSettingsActor } from "~/lib/storage/domain-settings"
import { getStoreRevision } from "~/lib/storage/operations"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { tokenPool } from "~/lib/token-pool"
import { createDashboardAccountRoutes } from "~/routes/dashboard/accounts"

import { createAuthStorageFixture } from "./helpers/auth-storage"

let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let accounts: AccountsService
let ids: Array<number>
let app: Hono
const originalFetch = globalThis.fetch
const originalMulti = state.isMultiToken

function model(id: string, endpoint = "/responses"): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "fixture",
    version: "test",
    model_picker_enabled: true,
    preview: false,
    supported_endpoints: [endpoint],
    capabilities: {
      family: "fixture",
      object: "model_capabilities",
      supports: { streaming: true, tool_calls: true },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  await mergeConfigWithDefaults()
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  state.isMultiToken = true
  accounts = new AccountsService(fixture.storage, {
    pool: tokenPool,
    validate: async (input) => {
      const second = input.token === "second"
      const models = [
        model("shared", second ? "/chat/completions" : "/responses"),
      ]
      if (second) models.push(model("second-only"))
      return {
        persisted: {
          token: input.token,
          instanceDomain: "github.com",
          upstreamUserId: input.token,
          login: input.token,
          label: null,
          accountType: "individual",
          modelCount: models.length,
        },
        resolved: {
          token: `tid=${input.token};exp=1900000000`,
          baseUrl: "https://api.githubcopilot.com",
          models: { object: "list", data: models },
        },
      }
    },
  })
  ids = []
  for (const token of ["first", "second"]) {
    const added = await accounts.create(
      { token },
      await createAccountMutationContext(
        fixture.storage,
        "account.create",
        { token },
        "owner:test",
      ),
    )
    ids.push(added.value.id)
  }
  app = new Hono()
  app.use("*", (_c, next) => withSettingsActor("admin:fixture", next))
  app.route(
    "/accounts",
    createDashboardAccountRoutes({
      accounts: () => accounts,
      device: () => new GitHubDeviceLoginService(accounts),
    }),
  )
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  state.isMultiToken = originalMulti
  await accounts.whenIdle()
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  await fixture.close()
})

async function configure(percentages: Array<number>) {
  const allocations = ids.map((accountId, index) => ({
    accountId,
    percentage: percentages[index],
  }))
  return createAccountDistributionRepository(fixture.storage).replace(
    allocations,
    await createAccountMutationContext(
      fixture.storage,
      "account.distribution.replace",
      { allocations },
      "admin:fixture",
    ),
  )
}

function select(key: string, modelId = "shared") {
  return runWithRoutingAffinity({ key, source: "copilot_session" }, () =>
    selectRoutedModel(modelId),
  )
}

test("distribution API validates and atomically publishes exact percentages with stale-save protection", async () => {
  const initial = await app.request("/accounts/distribution")
  expect(initial.status).toBe(200)
  const before = (await initial.json()) as {
    revision: number
    configured: boolean
  }
  expect(before.configured).toBe(false)
  const allocations = [
    { accountId: ids[0], percentage: 80 },
    { accountId: ids[1], percentage: 20 },
  ]
  const headers = {
    "content-type": "application/json",
    "if-match": String(before.revision),
    "idempotency-key": "distribution-route-fixture",
  }
  const saved = await app.request("/accounts/distribution", {
    method: "PUT",
    headers,
    body: JSON.stringify({ allocations }),
  })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ configured: true, allocations })
  const retry = await app.request("/accounts/distribution", {
    method: "PUT",
    headers,
    body: JSON.stringify({ allocations }),
  })
  expect(retry.status).toBe(200)
  const stale = await app.request("/accounts/distribution", {
    method: "PUT",
    headers: { ...headers, "idempotency-key": "different-edit" },
    body: JSON.stringify({
      allocations: [
        { accountId: ids[0], percentage: 50 },
        { accountId: ids[1], percentage: 50 },
      ],
    }),
  })
  expect(stale.status).toBe(409)
  const invalid = await app.request("/accounts/distribution", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      allocations: [{ accountId: ids[0], percentage: 95 }],
    }),
  })
  expect(invalid.status).toBe(400)
})

test("new weighted ownership selects endpoint authority and survives percentage edits at zero", async () => {
  await configure([0, 100])
  const first = await select("durable-conversation")
  expect(first.accountPin?.accountId).toBe(ids[1])
  expect(first.model?.supported_endpoints).toEqual(["/chat/completions"])
  await configure([100, 0])
  expect((await select("durable-conversation")).accountPin?.accountId).toBe(
    ids[1],
  )
  expect((await select("new-conversation")).accountPin?.accountId).toBe(ids[0])
})

test("legacy owners are recorded before first activation and model changes never create a second owner", async () => {
  const first = await select("legacy-owner")
  const owner = first.accountPin?.accountId
  expect(owner).toBeDefined()
  await configure(ids.map((id) => (id === owner ? 0 : 100)))
  expect((await select("legacy-owner")).accountPin?.accountId).toBe(owner)
  await configure([100, 0])
  await select("first-owned")
  await expect(select("first-owned", "second-only")).rejects.toMatchObject({
    response: { status: 409 },
  })
  await expect(
    select("no-positive-owner", "second-only"),
  ).rejects.toMatchObject({ response: { status: 503 } })
})

test("Codex forks reuse the effective parent's permanent account", async () => {
  await configure([0, 100])
  await select("parent")
  await configure([100, 0])
  const child = await runWithRoutingAffinity(
    { key: "child", source: "codex_thread" },
    () => {
      installResponsesRoutingAffinity({
        thread_id: "child",
        "x-codex-turn-metadata": { forked_from_thread_id: "parent" },
      })
      return selectRoutedModel("shared")
    },
  )
  expect(child.accountPin?.accountId).toBe(ids[1])
})

function controlPlane(key: string, path: string) {
  return runWithRoutingAffinity({ key, source: "copilot_session" }, () =>
    routedControlPlaneFetch({ path }),
  )
}

test("session issuance reserves ownership before inference and policy calls do not assign", async () => {
  await configure([0, 100])
  globalThis.fetch = (async () =>
    Response.json({ ok: true })) as unknown as typeof fetch
  const session = await controlPlane("issued-session", "/models/session")
  expect(session.account?.id).toBe(ids[1])
  await session.response.body?.cancel()
  await configure([100, 0])
  expect((await select("issued-session")).accountPin?.accountId).toBe(ids[1])
  const policy = await controlPlane("policy-only", "/models/shared/policy")
  await policy.response.body?.cancel()
  expect(
    await createAccountDistributionRepository(fixture.storage).lookup(
      "policy-only",
    ),
  ).toBeUndefined()
})

test("dispatch reuses the selected owner and does not allocate a second scheduler turn", async () => {
  await configure([50, 50])
  let authorization = ""
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    authorization = new Headers(init?.headers).get("authorization") ?? ""
    return Response.json({ ok: true })
  }) as unknown as typeof fetch
  const revision = await getStoreRevision(fixture.storage)
  await runWithRoutingAffinity(
    { key: "one", source: "copilot_session" },
    async () => {
      const selection = await selectRoutedModel("shared")
      const response = await runWithRoutedModelSelection(selection, () =>
        routedFetch("/responses", { method: "POST" }, { modelId: "shared" }),
      )
      await response.response.body?.cancel()
      expect(response.account?.id).toBe(ids[0])
    },
  )
  expect(authorization).toBe("Bearer tid=first;exp=1900000000")
  expect((await select("two")).accountPin?.accountId).toBe(ids[1])
  expect(await getStoreRevision(fixture.storage)).toBe(revision)
})

test("an eligibility change during reservation rolls back the new owner and scheduler", async () => {
  await configure([50, 50])
  await getAccountsService().refreshRuntime()
  const account = tokenPool
    .getAllAccounts()
    .find((candidate) => candidate.id === ids[0])
  if (!account) throw new Error("Missing fixture account")
  fixture.beforeNextTransaction(async () => {
    tokenPool.markUnhealthy(account)
  })
  await expect(select("eligibility-race")).rejects.toMatchObject({
    response: { status: 503 },
  })
  const repository = createAccountDistributionRepository(fixture.storage)
  expect(await repository.lookup("eligibility-race")).toBeUndefined()
  expect((await select("eligibility-race")).accountPin?.accountId).toBe(ids[1])
})

test("a changed allocation policy rejects new reservation under stale admission without moving existing ownership", async () => {
  await configure([100, 0])
  await select("already-recorded")
  const snapshot = getStorageRuntime().snapshot.get()
  await configure([0, 100])
  await expect(
    withRequestSnapshot(snapshot, () => select("stale-new")),
  ).rejects.toMatchObject({ response: { status: 503 } })
  expect(
    await createAccountDistributionRepository(fixture.storage).lookup(
      "stale-new",
    ),
  ).toBeUndefined()
  expect(
    (await withRequestSnapshot(snapshot, () => select("already-recorded")))
      .accountPin?.accountId,
  ).toBe(ids[0])
  expect((await select("stale-new")).accountPin?.accountId).toBe(ids[1])
})

test("model catalog probes do not allocate and the final selected model controls initial ownership", async () => {
  await configure([80, 20])
  await runWithRoutingAffinity(
    { key: "replacement", source: "copilot_session" },
    async () => {
      await selectRoutedModel("shared", { createAssignment: false })
      expect(
        await createAccountDistributionRepository(fixture.storage).lookup(
          "replacement",
        ),
      ).toBeUndefined()
      const final = await selectRoutedModel("second-only")
      expect(final.accountPin?.accountId).toBe(ids[1])
    },
  )
})

test("committed assignments are counted once before dispatch, even when endpoint preparation stops", async () => {
  await configure([50, 50])
  resetRoutingTelemetryForTest()
  await select("prepared-only")
  await select("prepared-only")
  const report = getRoutingTelemetrySnapshotForTest({
    accounts: ids.map((id) => ({
      id,
      healthy: true,
      accountType: "individual",
    })),
    multiToken: true,
    window: "1h",
  })
  expect(
    report.accounts.reduce(
      (sum, account) => sum + (account.newAssignments ?? 0),
      0,
    ),
  ).toBe(1)
  expect(
    report.accounts.reduce((sum, account) => sum + account.selected, 0),
  ).toBe(0)
})

test("upstream token counting reads ownership without allocating or consuming a scheduler turn", async () => {
  await configure([50, 50])
  for (const account of tokenPool.getAllAccounts())
    account.modelsData = [model("shared", "/v1/messages/count_tokens")]
  tokenPool.rebuildModelIndex()
  globalThis.fetch = (async () =>
    Response.json({ input_tokens: 8 })) as unknown as typeof fetch
  const result = await runWithRoutingAffinity(
    { key: "count-only", source: "claude_session" },
    () =>
      routedFetch(
        "/v1/messages/count_tokens",
        { method: "POST" },
        { modelId: "shared" },
      ),
  )
  await result.response.body?.cancel()
  expect(
    await createAccountDistributionRepository(fixture.storage).lookup(
      "count-only",
    ),
  ).toBeUndefined()
  expect((await select("count-only")).accountPin?.accountId).toBe(ids[0])
})
