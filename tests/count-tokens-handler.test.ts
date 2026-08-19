import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { RoutingAffinity } from "../src/lib/routing-affinity"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setConfigForTest } from "../src/lib/config"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { getRoutingAffinity } from "../src/lib/routing-affinity"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalAccountType = state.accountType
const originalCopilotToken = state.copilotToken
const originalGithubToken = state.githubToken
const originalApiKeyAuth = state.apiKeyAuth
const originalIsMultiToken = state.isMultiToken
const originalManualApprove = state.manualApprove

interface CapturedRequest {
  body: Record<string, unknown>
  headers: Headers
  path: string
  routingAffinity?: RoutingAffinity
  signal?: AbortSignal | null
}

let capturedRequests: Array<CapturedRequest>
let responseFactory: () => Response

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected native count-tokens JSON body")
  }
  capturedRequests.push({
    body: JSON.parse(init.body) as Record<string, unknown>,
    headers: new Headers(init.headers),
    path: new URL(url instanceof Request ? url.url : url).pathname,
    routingAffinity: getRoutingAffinity(),
    signal: init.signal,
  })
  return responseFactory()
})

const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-opus-4.7-1m-internal",
      name: "Claude Opus 4.7 1M Internal",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "claude",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
    {
      id: "gpt-5.5",
      name: "GPT 5.5",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "gpt-5.5",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    },
  ],
}

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  setConfigForTest(null)
  state.models = originalModels
  state.accountType = originalAccountType
  state.copilotToken = originalCopilotToken
  state.githubToken = originalGithubToken
  state.apiKeyAuth = originalApiKeyAuth
  state.isMultiToken = originalIsMultiToken
  state.manualApprove = originalManualApprove
})

beforeEach(() => {
  fetchMock.mockClear()
  capturedRequests = []
  responseFactory = () => Response.json({ input_tokens: 42 })
  setModelRedirectsForTest([])
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "custom-count",
        name: "Custom Count",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "custom-key",
        models: [
          {
            id: "custom-count-model",
            aliases: ["custom-count-alias"],
            kind: "chat",
          },
        ],
      },
    ],
  })
  state.models = models
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.apiKeyAuth = undefined
  state.isMultiToken = false
  state.manualApprove = false
})

async function requestCountTokens(options?: {
  body?: Record<string, unknown>
  headers?: Record<string, string>
  model?: string
}): Promise<Response> {
  return await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...options?.headers,
    },
    body: JSON.stringify({
      model: options?.model ?? "claude-opus-4.7-1m-internal",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
      ...options?.body,
    }),
  })
}

test("count_tokens strips a reasoning suffix and returns the upstream count", async () => {
  responseFactory = () => Response.json({ input_tokens: 37 })

  const response = await requestCountTokens({
    model: "claude-opus-4.7-1m-internal:xhigh",
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 37 })
  expect(capturedRequests).toHaveLength(1)
  expect(capturedRequests[0]?.path).toBe("/v1/messages/count_tokens")
  expect(capturedRequests[0]?.body).toEqual({
    model: "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: "Hello" }],
  })
})

test("count_tokens forwards prepared native headers", async () => {
  const response = await requestCountTokens({
    headers: {
      "anthropic-beta": " beta-one, beta-two, beta-one ",
      "anthropic-version": "2024-01-01",
      "x-model-provider-preference": "anthropic",
    },
  })

  expect(response.status).toBe(200)
  const headers = capturedRequests[0]?.headers
  expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
  expect(headers.get("anthropic-version")).toBe("2024-01-01")
  expect(headers.get("x-model-provider-preference")).toBe("anthropic")
})

test("count_tokens uses the redirected target model upstream", async () => {
  setModelRedirectsForTest([
    {
      id: "claude-gpt-to-gpt",
      sourceModel: "claude-gpt-5.5",
      sourceEffort: "all",
      targetModel: "gpt-5.5",
      enabled: true,
    },
  ])
  responseFactory = () => Response.json({ input_tokens: 53 })

  const response = await requestCountTokens({
    model: "claude-gpt-5.5:xhigh",
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 53 })
  expect(capturedRequests[0]?.body).toHaveProperty("model", "gpt-5.5")
})

test("count_tokens installs metadata affinity unless a header wins", async () => {
  const body = {
    metadata: {
      user_id: JSON.stringify({ session_id: "count-body-session" }),
    },
  }

  await requestCountTokens({ body })
  await requestCountTokens({
    body,
    headers: { "x-client-session-id": "count-header-session" },
  })

  expect(capturedRequests.map((request) => request.routingAffinity)).toEqual([
    { key: "count-body-session", source: "claude_metadata" },
    { key: "count-header-session", source: "copilot_session" },
  ])
})

test("count_tokens forwards the request abort signal upstream", async () => {
  await requestCountTokens()

  expect(capturedRequests[0]?.signal).toBeInstanceOf(AbortSignal)
})

test("count_tokens returns an Anthropic model-not-found error", async () => {
  const response = await requestCountTokens({ model: "missing-model" })

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "not_found_error",
      message: 'Model "missing-model" not found.',
    },
  })
  expect(capturedRequests).toHaveLength(0)
})

test("count_tokens propagates an upstream HTTP status", async () => {
  responseFactory = () =>
    Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "private upstream" },
      },
      {
        status: 400,
        headers: {
          "retry-after": "17",
          "x-quota-snapshot-premium_interactions": "remaining=0;limit=100",
        },
      },
    )

  const response = await requestCountTokens({
    headers: { "x-request-id": "req-count-safe" },
  })
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(400)
  expect(body).toEqual({
    type: "error",
    request_id: "req-count-safe",
    error: {
      type: "invalid_request_error",
      message: "The Copilot Messages request was rejected.",
    },
  })
  expect(response.headers.get("retry-after")).toBe("17")
  expect(response.headers.get("x-quota-snapshot-premium_interactions")).toBe(
    "remaining=0;limit=100",
  )
  expect(JSON.stringify(body)).not.toContain("private upstream")
})

test("count_tokens estimates configured custom-provider models locally", async () => {
  const response = await requestCountTokens({ model: "custom-count-alias" })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 8 })
  expect(capturedRequests).toHaveLength(0)
})
