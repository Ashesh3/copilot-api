import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { getLastUsedAccountId, routedFetch } from "../src/lib/account-router"
import { setModelRoutingOverridesForTest } from "../src/lib/model-routing"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"

const originalFetch = globalThis.fetch
const queuedResults: Array<Error | Response> = []
const capturedRequests: Array<{ url: string; init?: RequestInit }> = []

function getRequestUrl(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url
  }
  if (url instanceof URL) {
    return url.toString()
  }
  return url.url
}

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const requestUrl = getRequestUrl(url)
  capturedRequests.push({ url: requestUrl, init })

  const next = queuedResults.shift()
  if (!next) {
    throw new Error(`Unexpected fetch: ${requestUrl}`)
  }

  if (next instanceof Error) {
    throw next
  }

  return next
})

function createModel(id: string): Model {
  return {
    capabilities: {
      family: "gpt-4o",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "test",
  }
}

function registerAccount(
  id: number,
  modelId: string,
  copilotToken: string,
): void {
  const account = tokenPool.addAccount(`github-token-${id}`, "individual", id)
  account.copilotToken = copilotToken
  account.models = new Set([modelId])
  account.modelsData = [createModel(modelId)]
  account.healthy = true
}

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  setModelRoutingOverridesForTest({})
  tokenPool.rebuildModelIndex()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  tokenPool.dispose()
  fetchMock.mockClear()
  queuedResults.length = 0
  capturedRequests.length = 0
  setModelRoutingOverridesForTest({})
  state.isMultiToken = true
  state.sessionId = "router-test-session"
})

test("fails over to the next account immediately after a multi-token 401", async () => {
  const modelId = "router-401-failover-test"
  registerAccount(1001, modelId, "primary-copilot-token")
  registerAccount(1002, modelId, "secondary-copilot-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("Unauthorized", {
      status: 401,
      headers: { "retry-after": "0" },
    }),
    new Response(
      JSON.stringify({
        token: "fresh-primary-copilot-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
    new Response("Unauthorized", {
      status: 401,
      headers: { "retry-after": "0" },
    }),
    new Response("{}", { status: 200 }),
  )

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1002)
  expect(capturedRequests).toHaveLength(4)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer primary-copilot-token",
  })
  expect(capturedRequests[1]?.url).toContain("/copilot_internal/v2/token")
  expect(capturedRequests[2]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-primary-copilot-token",
  })
  expect(capturedRequests[3]?.init?.headers).toMatchObject({
    Authorization: "Bearer secondary-copilot-token",
  })
})

test("refreshes a multi-token account and retries after a 401", async () => {
  const modelId = "router-401-refresh-test"
  registerAccount(1011, modelId, "expired-copilot-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("IDE token expired: unauthorized: token expired\n", {
      status: 401,
    }),
    new Response(
      JSON.stringify({
        token: "fresh-copilot-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
    new Response("{}", { status: 200 }),
  )

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1011)
  expect(account?.copilotToken).toBe("fresh-copilot-token")
  expect(capturedRequests).toHaveLength(3)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer expired-copilot-token",
  })
  expect(capturedRequests[1]?.url).toContain("/copilot_internal/v2/token")
  expect(capturedRequests[1]?.init?.headers).toMatchObject({
    authorization: "token github-token-1011",
  })
  expect(capturedRequests[2]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-copilot-token",
  })
})

test("does not fail over aborted multi-token requests", async () => {
  const modelId = "router-abort-test"
  registerAccount(1003, modelId, "abort-primary-token")
  registerAccount(1004, modelId, "abort-secondary-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Error("The operation was aborted"),
    new Response("{}", { status: 200 }),
  )

  let thrownError: unknown
  try {
    await routedFetch("/chat/completions", { method: "POST" }, { modelId })
  } catch (error) {
    thrownError = error
  }
  expect(thrownError).toBeInstanceOf(Error)
  if (!(thrownError instanceof Error)) {
    throw new TypeError("Expected routedFetch to throw an Error")
  }
  expect(thrownError.message).toContain("aborted")

  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer abort-primary-token",
  })
})

test("applies headerOptions when multi-token falls back with no matching account", async () => {
  state.copilotToken = "fallback-copilot-token"
  const modelId = "router-no-account-header-fallback"
  registerAccount(1012, "different-known-model", "healthy-fallback-token")
  tokenPool.rebuildModelIndex()
  const expectedAccount = tokenPool.getFirstHealthyAccount()
  if (!expectedAccount) {
    throw new Error("Expected a healthy fallback account")
  }
  expectedAccount.copilotToken = "healthy-fallback-token"

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    {
      modelId,
      headerOptions: {
        initiator: "agent",
        vision: true,
      },
    },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(expectedAccount.id)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer healthy-fallback-token",
    "X-Initiator": "agent",
    "Copilot-Vision-Request": "true",
  })
})

test("refreshes the fallback account for unknown models after a 401", async () => {
  const modelId = "gpt-4.1-mini"
  registerAccount(1013, "different-known-model", "expired-fallback-token")
  tokenPool.rebuildModelIndex()
  const expectedAccount = tokenPool.getFirstHealthyAccount()
  if (!expectedAccount) {
    throw new Error("Expected a healthy fallback account")
  }
  expectedAccount.copilotToken = "expired-fallback-token"

  queuedResults.push(
    new Response("IDE token expired: unauthorized: token expired\n", {
      status: 401,
    }),
    new Response(
      JSON.stringify({
        token: "fresh-fallback-token",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
    new Response("{}", { status: 200 }),
  )

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(expectedAccount.id)
  expect(account?.copilotToken).toBe("fresh-fallback-token")
  expect(capturedRequests).toHaveLength(3)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer expired-fallback-token",
  })
  expect(capturedRequests[1]?.url).toContain("/copilot_internal/v2/token")
  expect(capturedRequests[2]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-fallback-token",
  })
})

test("does not expose last used account globally outside request context", async () => {
  const modelId = "router-no-global-last-account"
  registerAccount(1005, modelId, "single-router-token")
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1005)
  expect(getLastUsedAccountId()).toBeUndefined()
})

test("routes a model only to accounts where the model is enabled", async () => {
  const modelId = "router-model-disabled-primary"
  registerAccount(1006, modelId, "disabled-account-token")
  registerAccount(1007, modelId, "enabled-account-token")
  setModelRoutingOverridesForTest({ [modelId]: { "1006": false } })
  tokenPool.rebuildModelIndex()

  queuedResults.push(new Response("{}", { status: 200 }))

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1007)
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer enabled-account-token",
  })
})

test("does not fail over to an account where the model is disabled", async () => {
  const modelId = "router-model-disabled-failover"
  registerAccount(1008, modelId, "enabled-failover-primary")
  registerAccount(1009, modelId, "disabled-failover-secondary")
  setModelRoutingOverridesForTest({ [modelId]: { "1009": false } })
  tokenPool.rebuildModelIndex()

  queuedResults.push(
    new Response("Unauthorized", { status: 401 }),
    new Response(
      JSON.stringify({
        token: "fresh-enabled-failover-primary",
        expires_at: 1_900_000_000,
        refresh_in: 1800,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
    new Response("Unauthorized", { status: 401 }),
  )

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(401)
  expect(account?.id).toBe(1008)
  expect(capturedRequests).toHaveLength(3)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer enabled-failover-primary",
  })
  expect(capturedRequests[1]?.url).toContain("/copilot_internal/v2/token")
  expect(capturedRequests[2]?.init?.headers).toMatchObject({
    Authorization: "Bearer fresh-enabled-failover-primary",
  })
})

test("returns a routing error when every known account for a model is disabled", async () => {
  const modelId = "router-model-all-disabled"
  registerAccount(1010, modelId, "disabled-only-token")
  setModelRoutingOverridesForTest({ [modelId]: { "1010": false } })
  tokenPool.rebuildModelIndex()

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(403)
  expect(account).toBeUndefined()
  expect(capturedRequests).toHaveLength(0)

  const body = (await response.json()) as { error: { type: string } }
  expect(body.error.type).toBe("model_routing_error")
})
