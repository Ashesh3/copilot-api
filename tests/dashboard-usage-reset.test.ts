import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  issueAdminSetupCode,
  setupAdminAuth,
} from "~/lib/admin-auth"
import { forwardError } from "~/lib/error"
import { OAuthStore } from "~/lib/oauth-store"
import {
  enableDatabaseRoutingTelemetryForTest,
  recordRoutingRequest,
  recordRoutingSelection,
  recordUpstreamCall,
} from "~/lib/routing-telemetry"
import { writeSetting } from "~/lib/storage/domain-settings"
import { getStoreRevision } from "~/lib/storage/operations"
import { createHistoryRuntime } from "~/lib/telemetry-writer"
import { enableDatabaseUsageForTest, recordUsage } from "~/lib/usage-tracker"
import { dashboardRoutes } from "~/routes/dashboard/route"

import { createAuthStorageFixture } from "./helpers/auth-storage"

const origin = "https://gateway.example.com"
const gatewayKey = "fixture-reset-gateway-credential"
const originalOrigin = process.env.COPILOT_ADMIN_ORIGIN
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let history: Awaited<ReturnType<typeof createHistoryRuntime>>
let app: Hono
let cookie: string
let csrf: string

beforeEach(async () => {
  process.env.COPILOT_ADMIN_ORIGIN = origin
  fixture = await createAuthStorageFixture()
  const setup = await setupAdminAuth(
    gatewayKey,
    "fixture-reset-administrator-password",
    (await issueAdminSetupCode()).code,
  )
  if (!("session" in setup)) throw new Error(setup.error)
  csrf = setup.session.csrfToken
  cookie = `${ADMIN_SESSION_COOKIE}=${setup.session.token}; ${ADMIN_CSRF_COOKIE}=${csrf}`
  enableDatabaseUsageForTest()
  enableDatabaseRoutingTelemetryForTest()
  history = await createHistoryRuntime(fixture.storage, { autoFlush: false })
  app = new Hono()
    .onError((error, c) => forwardError(c, error))
    .route("/dashboard", dashboardRoutes)
})

afterEach(async () => {
  fixture.failReads(false)
  fixture.failWrites(false)
  await fixture.close()
  if (originalOrigin === undefined) delete process.env.COPILOT_ADMIN_ORIGIN
  else process.env.COPILOT_ADMIN_ORIGIN = originalOrigin
})

function resetUsage(headers: Record<string, string> = {}) {
  return app.request(`${origin}/dashboard/api/usage`, {
    method: "DELETE",
    headers: {
      cookie,
      origin,
      "x-copilot-csrf": csrf,
      "idempotency-key": "fixture-usage-reset",
      ...headers,
    },
  })
}

async function readUsage(path = "/dashboard/api/usage"): Promise<unknown> {
  const response = await app.request(`${origin}${path}`, {
    headers: { cookie },
  })
  expect(response.status).toBe(200)
  return response.json()
}

function readUnrelatedState() {
  return fixture.storage.read(async (session) => ({
    admin: await session.query({ sql: "SELECT * FROM capi_admin", args: [] }),
    gateway: await session.query({
      sql: "SELECT * FROM capi_gateway_credentials",
      args: [],
    }),
    secrets: await session.query({
      sql: "SELECT * FROM capi_gateway_secrets",
      args: [],
    }),
    settings: await session.query({
      sql: "SELECT * FROM capi_settings",
      args: [],
    }),
  }))
}

function recordRequest() {
  recordUsage(7, 11, "reset-model")
  recordRoutingRequest({
    model: "reset-model",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    status: 200,
  })
  recordUpstreamCall({
    accountId: 7,
    model: "reset-model",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    reason: "failover",
    outcome: "success",
  })
  recordRoutingSelection({
    accountId: 7,
    eligibleAccountIds: [7, 8],
    mode: "sticky",
    affinitySource: "codex_thread",
    model: "reset-model",
  })
}

async function seedHistory() {
  recordRequest()
  const now = Date.now()
  history.writer.enqueue({
    id: "fixture-unknown-gap",
    kind: "collection-gap",
    generation: 0,
    recordedAt: now,
    payload: { unknown: true, startedAt: now },
  })
  history.writer.enqueue({
    id: "fixture-known-gap",
    kind: "collection-gap",
    generation: 0,
    recordedAt: now,
    payload: { startedAt: now, lostRecords: 3, lostBytes: 80 },
  })
  await history.writer.flush()
  recordRequest()
}

test("usage reset requires an administrator session and matching same-origin CSRF", async () => {
  await seedHistory()
  const before = await readUsage()
  const invalidHeaders: Array<Record<string, string>> = [
    { cookie: "" },
    { "x-copilot-csrf": "" },
    { "x-copilot-csrf": "wrong" },
    { origin: "" },
    { origin: "https://untrusted.example" },
    { cookie: `${ADMIN_SESSION_COOKIE}=invalid; ${ADMIN_CSRF_COOKIE}=${csrf}` },
  ]
  for (const headers of invalidHeaders) {
    const response = await resetUsage(headers)
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await readUsage()).toEqual(before)
  }
})

test("gateway and inference credentials cannot reset usage history", async () => {
  await seedHistory()
  const inference = await new OAuthStore({
    storage: fixture.storage,
  }).mintInferenceCredential()
  const before = await readUsage()
  for (const credential of [gatewayKey, inference]) {
    const response = await resetUsage({
      cookie: "",
      authorization: `Bearer ${credential}`,
    })
    expect(response.status).toBe(401)
    expect(await readUsage()).toEqual(before)
  }
})

test("usage reset clears persisted and pending totals, routing and collection gaps", async () => {
  await seedHistory()
  expect(await readUsage()).toMatchObject({
    lifetime: { total_requests: 2, total_input_tokens: 14 },
    collection: { knownLostRecords: 3, knownLostBytes: 80, unknownGaps: 1 },
  })
  expect(await readUsage("/dashboard/api/usage-routing")).toMatchObject({
    totals: { requests: 2, upstreamCalls: 2, failovers: 2 },
  })

  const response = await resetUsage()
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({ success: true })
  expect(await readUsage()).toMatchObject({
    twenty_four_hour: {
      tokens_used: 0,
      request_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
    },
    lifetime: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_tokens: 0,
      total_requests: 0,
      first_request_at: null,
    },
    collection: {
      pendingRecords: 0,
      pendingBytes: 0,
      droppedRecords: 0,
      degraded: false,
      knownLostRecords: 0,
      knownLostBytes: 0,
      unknownGaps: 0,
    },
  })
  expect(await readUsage("/dashboard/api/usage-routing")).toMatchObject({
    totals: { requests: 0, upstreamCalls: 0, retries: 0, failovers: 0 },
    lifetime: { requests: 0, upstreamCalls: 0, retries: 0, failovers: 0 },
    models: [],
    routes: [],
    selectionModes: { sticky: 0, default: 0, single: 0 },
    affinitySources: { codex_thread: 0 },
    collection: { unknownGaps: 0, knownLostRecords: 0 },
  })
})

test("usage reset preserves administrator, gateway credentials and configuration", async () => {
  await writeSetting("feature_flags", { retained_after_usage_reset: true })
  await seedHistory()
  const before = await readUnrelatedState()
  expect(before.admin).toHaveLength(1)
  expect(before.gateway).toHaveLength(1)
  expect(before.secrets).toHaveLength(1)
  expect(before.settings).toHaveLength(1)

  expect((await resetUsage()).status).toBe(200)
  expect(await readUnrelatedState()).toEqual(before)
  expect(await readUsage()).toMatchObject({ lifetime: { total_requests: 0 } })
})

test("retrying a usage reset with the same idempotency key preserves new history", async () => {
  await seedHistory()
  expect((await resetUsage()).status).toBe(200)
  const revision = await getStoreRevision(fixture.storage)
  recordRequest()
  await history.writer.flush()
  recordRequest()

  expect((await resetUsage()).status).toBe(200)
  expect(await getStoreRevision(fixture.storage)).toBe(revision)
  expect(await readUsage()).toMatchObject({
    lifetime: { total_requests: 2, total_input_tokens: 14 },
  })
  expect(await readUsage("/dashboard/api/usage-routing")).toMatchObject({
    totals: { requests: 2, upstreamCalls: 2 },
  })
  expect((await resetUsage({ "idempotency-key": "next-reset" })).status).toBe(
    200,
  )
  expect(await readUsage()).toMatchObject({ lifetime: { total_requests: 0 } })
})

test("a failed usage reset returns 503 and preserves persisted and pending history", async () => {
  await seedHistory()
  const before = await readUsage()
  const revision = await getStoreRevision(fixture.storage)
  fixture.failWrites()
  const response = await resetUsage()
  fixture.failWrites(false)

  expect(response.status).toBe(503)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toMatchObject({
    error: { code: "storage_unavailable" },
  })
  expect(await getStoreRevision(fixture.storage)).toBe(revision)
  expect(await readUsage()).toEqual(before)
  expect((await resetUsage()).status).toBe(200)
  expect(await readUsage()).toMatchObject({ lifetime: { total_requests: 0 } })
})

test("usage resets without an idempotency key receive independent operation identities", async () => {
  for (let index = 0; index < 2; index++) {
    recordRequest()
    expect(await readUsage()).toMatchObject({ lifetime: { total_requests: 1 } })
    const response = await app.request(`${origin}/dashboard/api/usage`, {
      method: "DELETE",
      headers: { cookie, origin, "x-copilot-csrf": csrf },
    })
    expect(response.status).toBe(200)
    expect(await readUsage()).toMatchObject({ lifetime: { total_requests: 0 } })
  }
})

test("retrying an unconfirmed reset reconciles its commit and preserves subsequent requests", async () => {
  await seedHistory()
  fixture.loseNextCommitResponse({ failReads: true })
  const response = await resetUsage()
  fixture.failReads(false)
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({
    error: { code: "storage_commit_unknown" },
  })

  expect(await readUsage()).toMatchObject({ lifetime: { total_requests: 0 } })
  recordRequest()
  expect((await resetUsage()).status).toBe(200)
  expect(await readUsage()).toMatchObject({
    lifetime: { total_requests: 1, total_input_tokens: 7 },
    collection: { unknownGaps: 0, knownLostRecords: 0 },
  })
  expect(await readUsage("/dashboard/api/usage-routing")).toMatchObject({
    totals: { requests: 1, upstreamCalls: 1 },
  })
})
