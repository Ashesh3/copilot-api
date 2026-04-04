import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { getLastUsedAccountId, routedFetch } from "../src/lib/account-router"
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
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  queuedResults.length = 0
  capturedRequests.length = 0
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
    new Response("{}", { status: 200 }),
  )

  const { response, account } = await routedFetch(
    "/chat/completions",
    { method: "POST" },
    { modelId },
  )

  expect(response.status).toBe(200)
  expect(account?.id).toBe(1002)
  expect(capturedRequests).toHaveLength(2)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer primary-copilot-token",
  })
  expect(capturedRequests[1]?.init?.headers).toMatchObject({
    Authorization: "Bearer secondary-copilot-token",
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
  expect(account).toBeUndefined()
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.init?.headers).toMatchObject({
    Authorization: "Bearer fallback-copilot-token",
    "X-Initiator": "agent",
    "Copilot-Vision-Request": "true",
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
