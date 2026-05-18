import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setConfigForTest } from "../src/lib/config"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
const originalCustomApiKey = process.env.CUSTOM_PROVIDER_API_KEY
const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalApiKeyAuth = state.apiKeyAuth
const originalRateLimitSeconds = state.rateLimitSeconds
const originalIsMultiToken = state.isMultiToken

let fetchMock: ReturnType<typeof mock>
interface CapturedRequest {
  url: string
  body: Record<string, unknown>
  headers: Headers
}

interface ListedModel {
  id: string
  owned_by: string
  dimensions?: number
  alias?: boolean
}

let requests: Array<CapturedRequest>

const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-copilot",
      name: "GPT Copilot",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "gpt",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
    {
      id: "text-embedding-3-small",
      name: "Text Embedding 3 Small",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "embedding",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "embedding",
      },
    },
  ],
}

beforeAll(() => {
  fetchMock = mock((url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    const headers = new Headers(init?.headers)
    requests.push({ url, body, headers })

    if (url.includes("/embeddings")) {
      return Response.json({
        object: "list",
        model: body.model,
        data: [
          { object: "embedding", index: 0, embedding: Array(4096).fill(0.1) },
          { object: "embedding", index: 1, embedding: Array(4096).fill(0.2) },
        ],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      })
    }

    return Response.json({
      id: "chatcmpl-custom",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "custom" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  restoreEnv("CUSTOM_PROVIDER_API_KEY", originalCustomApiKey)
  setConfigForTest(null)
  state.models = originalModels
  state.copilotToken = originalCopilotToken
  state.apiKeyAuth = originalApiKeyAuth
  state.rateLimitSeconds = originalRateLimitSeconds
  state.isMultiToken = originalIsMultiToken
})

beforeEach(() => {
  fetchMock.mockClear()
  requests = []
  process.env.CUSTOM_PROVIDER_API_KEY = "custom-key"
  state.models = models
  state.copilotToken = "copilot-token"
  state.apiKeyAuth = undefined
  state.rateLimitSeconds = undefined
  state.isMultiToken = false
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "nebius",
        name: "Nebius",
        type: "openai-compatible",
        baseUrl: "https://api.studio.nebius.com/v1",
        apiKey: "nebius-key",
        headers: { "X-Provider": "nebius" },
        models: [
          {
            id: "Qwen/Qwen3-Embedding-8B",
            aliases: ["qwen3-embedding-8b"],
            kind: "embedding",
            dimensions: 4096,
          },
        ],
      },
      {
        id: "custom-chat",
        name: "Custom Chat",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKeyEnv: "CUSTOM_PROVIDER_API_KEY",
        models: [
          {
            id: "custom-chat-model",
            aliases: ["custom-chat-alias"],
            kind: "chat",
            supportsStreaming: true,
          },
        ],
      },
    ],
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    clearEnv(name)
    return
  }
  process.env[name] = value
}

function clearEnv(name: string): void {
  if (name === "NEBIUS_API_KEY") {
    delete process.env.NEBIUS_API_KEY
    return
  }
  if (name === "CUSTOM_PROVIDER_API_KEY") {
    delete process.env.CUSTOM_PROVIDER_API_KEY
  }
}

test("custom models appear in /v1/models with aliases and metadata", async () => {
  const response = await server.request("/v1/models")
  const body = (await response.json()) as {
    data: Array<ListedModel>
  }

  expect(response.status).toBe(200)
  const canonicalModel: ListedModel = {
    id: "Qwen/Qwen3-Embedding-8B",
    owned_by: "Nebius",
    dimensions: 4096,
  }
  const aliasModel: ListedModel = {
    id: "qwen3-embedding-8b",
    owned_by: "Nebius",
    dimensions: 4096,
    alias: true,
  }
  expect(body.data).toContainEqual(
    expect.objectContaining(canonicalModel) as ListedModel,
  )
  expect(body.data).toContainEqual(
    expect.objectContaining(aliasModel) as ListedModel,
  )
})

test("chat request routes to custom provider by model id", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
    }),
  })
  const body = (await response.json()) as { model: string }

  expect(response.status).toBe(200)
  expect(body.model).toBe("custom-chat-model")
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe("https://custom.example/v1/chat/completions")
  expect(requests[0]?.body.model).toBe("custom-chat-model")
  expect(requests[0]?.body.temperature).toBe(0.2)
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer custom-key")
})

test("embeddings request routes to Nebius config by alias", async () => {
  const response = await server.request("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-embedding-8b",
      input: ["incident cpu saturation", "postgres connection timeout"],
    }),
  })
  const body = (await response.json()) as {
    model: string
    data: Array<{ index: number; embedding: Array<number> }>
  }

  expect(response.status).toBe(200)
  expect(body.model).toBe("qwen3-embedding-8b")
  expect(body.data).toHaveLength(2)
  expect(body.data.map((item) => item.index)).toEqual([0, 1])
  expect(body.data[0]?.embedding).toHaveLength(4096)
  expect(
    body.data[0]?.embedding.every((value) => typeof value === "number"),
  ).toBe(true)
  expect(requests[0]?.url).toBe("https://api.studio.nebius.com/v1/embeddings")
  expect(requests[0]?.body.model).toBe("Qwen/Qwen3-Embedding-8B")
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer nebius-key")
  expect(requests[0]?.headers.get("x-provider")).toBe("nebius")
})

test("missing custom provider API key returns a clear error", async () => {
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "nebius",
        name: "Nebius",
        type: "openai-compatible",
        baseUrl: "https://api.studio.nebius.com/v1",
        apiKeyEnv: "NEBIUS_API_KEY",
        models: [
          {
            id: "Qwen/Qwen3-Embedding-8B",
            aliases: ["qwen3-embedding-8b"],
            kind: "embedding",
            dimensions: 4096,
          },
        ],
      },
    ],
  })
  clearEnv("NEBIUS_API_KEY")

  const response = await server.request("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-embedding-8b",
      input: "hello",
    }),
  })
  const body = (await response.json()) as { error: { message: string } }

  expect(response.status).toBe(500)
  expect(body.error.message).toContain("NEBIUS_API_KEY")
  expect(requests).toHaveLength(0)
})

test("dashboard can store provider API key directly", async () => {
  const response = await server.request("/dashboard/api/custom-providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "dashboard-provider",
      name: "Dashboard Provider",
      type: "openai-compatible",
      baseUrl: "https://dashboard.example/v1",
      apiKey: "dashboard-key",
      models: [{ id: "dashboard-chat", kind: "chat" }],
    }),
  })
  const body = (await response.json()) as {
    apiKey?: string
    apiKeyEnv?: string
  }

  expect(response.status).toBe(200)
  expect(body.apiKey).toBe("dashboard-key")
  expect(body.apiKeyEnv).toBeUndefined()

  const chatResponse = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "dashboard-chat",
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(chatResponse.status).toBe(200)
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer dashboard-key")
})

test("Copilot models still route through the existing path", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-copilot",
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe(
    "https://api.githubcopilot.com/chat/completions",
  )
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer copilot-token")
})

test("embedding dimension metadata is validated", async () => {
  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    requests.push({ url, body, headers: new Headers(init?.headers) })
    return Response.json({
      object: "list",
      model: body.model,
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })
  })

  const response = await server.request("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-embedding-8b",
      input: "hello",
    }),
  })
  const body = (await response.json()) as { error: { message: string } }

  expect(response.status).toBe(502)
  expect(body.error.message).toContain("expected 4096")
})
