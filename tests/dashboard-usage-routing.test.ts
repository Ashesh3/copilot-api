import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test"

import type { Account } from "../src/lib/token-pool"

import {
  recordRoutingRequest,
  recordUpstreamCall,
  resetRoutingTelemetryForTest,
  type RoutingTelemetrySnapshot,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { server } from "../src/server"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

const SECRET_GITHUB_TOKEN = "github-routing-usage-secret"
const SECRET_COPILOT_TOKEN = "copilot-routing-usage-secret"
const ACCOUNT_ID = 9201

const account: Account = {
  accountType: "individual",
  copilotToken: SECRET_COPILOT_TOKEN,
  githubToken: SECRET_GITHUB_TOKEN,
  githubUsername: "octocat",
  healthy: true,
  id: ACCOUNT_ID,
  models: new Set(["usage-routing-model"]),
  modelsData: [],
}

let admin: TestAdminSession
const getAllAccountsSpy = spyOn(tokenPool, "getAllAccounts")

beforeAll(() => {
  getAllAccountsSpy.mockReturnValue([account])
})

afterAll(() => {
  getAllAccountsSpy.mockRestore()
  resetTestAdminSession()
})

beforeEach(async () => {
  admin = await createTestAdminSession()
  resetRoutingTelemetryForTest(Date.UTC(2026, 7, 3, 12))
  state.isMultiToken = true
})

async function getUsageRouting(path = "?window=1h"): Promise<Response> {
  return await server.request(`/dashboard/api/usage-routing${path}`, {
    headers: adminHeaders(admin, false),
  })
}

test("routing usage requires dashboard authentication", async () => {
  const response = await server.request("/dashboard/api/usage-routing")

  expect(response.status).toBe(401)
})

test("routing usage defaults to one hour and exposes safe account metadata", async () => {
  const response = await getUsageRouting("")
  const body = (await response.json()) as RoutingTelemetrySnapshot

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    multiToken: true,
    retentionMinutes: 1440,
    totals: { requests: 0, upstreamCalls: 0 },
    window: "1h",
    windowMinutes: 60,
  })
  expect(body.accounts).toHaveLength(1)
  expect(body.accounts[0]).toMatchObject({
    accountId: ACCOUNT_ID,
    accountType: "individual",
    githubUsername: "octocat",
    healthy: true,
    label: `Account #${ACCOUNT_ID}`,
  })

  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain(SECRET_GITHUB_TOKEN)
  expect(serialized).not.toContain(SECRET_COPILOT_TOKEN)
  for (const forbidden of [
    "githubToken",
    "copilotToken",
    "authorization",
    "requestId",
    "sessionId",
    "headers",
    "prompt",
  ]) {
    expect(serialized).not.toContain(forbidden)
  }
})

test("routing usage accepts every supported time window", async () => {
  for (const [window, minutes] of [
    ["15m", 15],
    ["1h", 60],
    ["6h", 360],
    ["24h", 1440],
  ] as const) {
    const response = await getUsageRouting(`?window=${window}`)
    const body = (await response.json()) as RoutingTelemetrySnapshot
    expect(response.status).toBe(200)
    expect(body.window).toBe(window)
    expect(body.windowMinutes).toBe(minutes)
  }
})

test("routing usage rejects invalid, empty, and repeated windows", async () => {
  for (const query of ["?window=7d", "?window=", "?window=1h&window=6h"]) {
    const response = await getUsageRouting(query)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "window must be one of 15m, 1h, 6h, or 24h",
    })
  }
})

test("routing usage returns current in-memory model and call totals", async () => {
  recordRoutingRequest({
    model: "usage-routing-model",
    provider: "GitHub Copilot",
    route: "Responses -> Responses",
    status: 200,
  })
  recordUpstreamCall({
    accountId: ACCOUNT_ID,
    model: "usage-routing-model",
    outcome: "success",
    provider: "GitHub Copilot",
    reason: "initial",
    route: "Responses -> Responses",
  })

  const response = await getUsageRouting()
  const body = (await response.json()) as RoutingTelemetrySnapshot

  expect(response.status).toBe(200)
  expect(body.totals).toMatchObject({ requests: 1, upstreamCalls: 1 })
  expect(body.models[0]).toMatchObject({
    model: "usage-routing-model",
    requests: 1,
    upstreamCalls: 1,
  })
})
