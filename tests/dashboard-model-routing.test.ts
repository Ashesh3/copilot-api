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
  account.modelsData.length = 0
  resetTestAdminSession()
})

test("model routing requires dashboard authentication", async () => {
  const response = await server.request("/dashboard/api/model-routing")

  expect(response.status).toBe(401)
})

test("model routing returns account usernames without GitHub tokens", async () => {
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
