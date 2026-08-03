import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"

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
const ACCOUNT_WITHOUT_USERNAME_ID = 8302
const GITHUB_TOKEN = "dashboard-model-routing-secret-token"
const GITHUB_TOKEN_WITHOUT_USERNAME =
  "dashboard-model-routing-second-secret-token"

let adminSession: TestAdminSession
const accounts: Array<Account> = [
  {
    id: ACCOUNT_ID,
    accountType: "individual",
    githubToken: GITHUB_TOKEN,
    githubUsername: "octocat",
    healthy: true,
    models: new Set(["dashboard-routing-model"]),
    modelsData: [],
  },
  {
    id: ACCOUNT_WITHOUT_USERNAME_ID,
    accountType: "business",
    githubToken: GITHUB_TOKEN_WITHOUT_USERNAME,
    healthy: false,
    models: new Set(),
    modelsData: [],
  },
]
const getAllAccountsSpy = spyOn(tokenPool, "getAllAccounts")

beforeAll(async () => {
  adminSession = await createTestAdminSession()
  getAllAccountsSpy.mockReturnValue(accounts)
})

afterAll(() => {
  getAllAccountsSpy.mockRestore()
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
  const accountWithoutUsername = body.accounts.find(
    (candidate) => candidate.id === ACCOUNT_WITHOUT_USERNAME_ID,
  )

  expect(response.status).toBe(200)
  expect(listedAccount).toEqual({
    id: ACCOUNT_ID,
    accountType: "individual",
    githubUsername: "octocat",
    healthy: true,
    modelsCount: 1,
  })
  expect(accountWithoutUsername).toEqual({
    id: ACCOUNT_WITHOUT_USERNAME_ID,
    accountType: "business",
    healthy: false,
    modelsCount: 0,
  })
  expect(Object.hasOwn(accountWithoutUsername ?? {}, "githubUsername")).toBe(
    false,
  )
  expect(
    body.accounts.every((account) => !Object.hasOwn(account, "githubToken")),
  ).toBe(true)
  const serializedBody = JSON.stringify(body)
  expect(serializedBody).not.toContain(GITHUB_TOKEN)
  expect(serializedBody).not.toContain(GITHUB_TOKEN_WITHOUT_USERNAME)
})
