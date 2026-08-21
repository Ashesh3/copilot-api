/* eslint-disable max-lines -- hotfix extends an existing integration matrix */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setConfigForTest } from "../src/lib/config"
import {
  createCustomProviderChatCompletions,
  createCustomProviderEmbeddings,
  resolveCustomProviderModel,
} from "../src/lib/custom-providers"
import { HTTPError } from "../src/lib/error"
import {
  getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  TEST_GATEWAY_KEY,
} from "./helpers/admin-session"

const originalFetch = globalThis.fetch
const originalCustomApiKey = process.env.CUSTOM_PROVIDER_API_KEY
const originalModels = state.models
const originalCopilotToken = state.copilotToken
const originalApiKeyAuth = state.apiKeyAuth
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

type RequestBodyCheck = (body: Record<string, unknown>) => void

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
  state.isMultiToken = originalIsMultiToken
  resetTestAdminSession()
})

beforeEach(() => {
  fetchMock.mockClear()
  requests = []
  process.env.CUSTOM_PROVIDER_API_KEY = "custom-key"
  state.models = models
  state.copilotToken = "copilot-token"
  state.apiKeyAuth = undefined
  state.isMultiToken = false
  resetRoutingTelemetryForTest()
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
          {
            id: "glm-5.2",
            kind: "chat",
            supportsStreaming: true,
            passReasoningEffort: true,
          },
        ],
      },
      {
        id: "zenmux",
        name: "ZenMux",
        type: "openai-compatible",
        baseUrl: "https://zenmux.example/v1",
        apiKey: "zenmux-key",
        models: [{ id: "z-ai/glm-5.3-free", kind: "chat" }],
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

function routingSnapshot() {
  return getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
}

function expectChatDispatch(
  response: Response,
  bodyCheck: RequestBodyCheck,
  options?: {
    url?: string
    requestCount?: number
  },
) {
  const url = options?.url ?? "https://custom.example/v1/chat/completions"
  const requestCount = options?.requestCount ?? 1
  expect(response.status).toBe(200)
  expect(requests).toHaveLength(requestCount)
  const dispatched = requests.at(-1)
  expect(dispatched?.url).toBe(url)
  bodyCheck(dispatched?.body ?? {})
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

  expect(routingSnapshot().models[0]).toMatchObject({
    accounts: [],
    model: "custom-chat-model",
    provider: "Custom Chat",
    requests: 1,
    upstreamCalls: 1,
  })
})

test("Anthropic messages request routes to custom chat provider by model id", async () => {
  const response = await server.request("/v1/messages?beta=true", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1,
      output_config: {
        effort: "high",
      },
    }),
  })
  const body = (await response.json()) as {
    content: Array<{ type: string; text?: string }>
    model: string
  }

  expect(response.status).toBe(200)
  expect(body.model).toBe("glm-5.2")
  expect(body.content).toEqual([{ type: "text", text: "custom" }])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe("https://custom.example/v1/chat/completions")
  expect(requests[0]?.body.model).toBe("glm-5.2")
  expect(requests[0]?.body.max_tokens).toBe(1)
  expect(requests[0]?.body.reasoning_effort).toBe("high")
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer custom-key")
})

test("custom Messages stream closes partial text before one EOF error", async () => {
  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    requests.push({ url, body, headers: new Headers(init?.headers) })
    const chunk = {
      id: "chatcmpl-custom-stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "glm-5.2",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "partial" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  })

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
      stream: true,
    }),
  })
  const body = await response.text()

  expect(
    Array.from(body.matchAll(/^event: (.+)$/gm), (match) => match[1]),
  ).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "error",
  ])
  expect(body).not.toContain("message_delta")
  expect(body).not.toContain("message_stop")
})

test.each([
  {
    name: "root cache control",
    extra: { cache_control: { type: "ephemeral" } },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(body).not.toHaveProperty("cache_control")
    },
  },
  {
    name: "future root field",
    extra: { future_native_field: true },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(body).not.toHaveProperty("future_native_field")
    },
  },
  {
    name: "deferred native tool",
    extra: {
      tools: [{ type: "future_native_20270101", name: "future_native" }],
    },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(body).not.toHaveProperty("tools")
    },
  },
  {
    name: "document context",
    extra: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "text", data: "notes" },
              context: "must stay structural",
            },
          ],
        },
      ],
    },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content: "<document>\nmust stay structural\nnotes\n</document>",
          },
        ],
      })
    },
  },
  {
    name: "Responses thinking signature",
    extra: {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private", signature: "item@opaque" },
          ],
        },
      ],
    },
    check: (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: null, reasoning_text: "private" },
        ],
      })
      const assistantMessage = (
        body.messages as Array<Record<string, unknown>> | undefined
      )?.[1]
      expect(assistantMessage).not.toHaveProperty("reasoning_opaque")
    },
  },
] as const)(
  "best-effort translates custom-provider Messages $name before Chat dispatch",
  async ({ extra, check }) => {
    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-chat-model",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
        ...extra,
      }),
    })

    expectChatDispatch(response, check)
  },
)

test("custom Messages dispatches a versioned web-search schema after URL-image fallback", async () => {
  const marker = "PRIVATE_CUSTOM_WEB_SEARCH_SCHEMA"
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                url: "https://private.example/image.png",
              },
            },
          ],
        },
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string", description: marker },
            },
          },
        },
      ],
    }),
  })

  expectChatDispatch(
    response,
    (requestBody) => {
      expect(requestBody).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content:
              '[image attachment "https://private.example/image.png" omitted: the URL could not be fetched by the proxy]',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "web_search",
            },
          },
        ],
      })
      expect(JSON.stringify(requestBody)).not.toContain(marker)
      expect(JSON.stringify(requestBody)).not.toContain(
        "endpoint_translation_unsupported",
      )
    },
    { requestCount: 2 },
  )
})

test("custom Messages dispatches an unknown typed tool with a schema", async () => {
  const privateType = "PRIVATE_CUSTOM_NATIVE_TYPE"
  const privateName = "PRIVATE_CUSTOM_NATIVE_NAME"
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: privateType,
          name: privateName,
          input_schema: { type: "object", properties: {} },
        },
      ],
    }),
  })

  expectChatDispatch(response, (requestBody) => {
    expect(requestBody).toMatchObject({
      model: "custom-chat-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: privateName,
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    })
    expect(JSON.stringify(requestBody)).not.toContain(privateType)
  })
})

test.each([
  "web_searchfuture",
  "Web_search_20250305",
  "prefix_web_search_20250305",
  "web-search_20250305",
  "web_search_",
  "web_search__20250305",
])(
  "custom Messages dispatches web-search lookalike type %s as a function tool",
  async (type) => {
    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type,
            name: "future_native",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    })

    expectChatDispatch(response, (requestBody) => {
      expect(requestBody).toMatchObject({
        model: "custom-chat-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "future_native",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      })
      expect(JSON.stringify(requestBody)).not.toContain(
        "endpoint_translation_unsupported",
      )
    })
  },
)

test("custom Messages flattens documents before attachment normalization", async () => {
  const document = {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: "custom notes" },
    title: "notes.txt",
    context: "custom context",
  }

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      messages: [{ role: "user", content: [document] }],
      max_tokens: 16,
    }),
  })

  expectChatDispatch(response, (requestBody) => {
    expect(requestBody).toMatchObject({
      model: "custom-chat-model",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content:
            '<document title="notes.txt">\ncustom context\ncustom notes\n</document>',
        },
      ],
    })
  })
})

test.each([
  {
    name: "image source extension",
    extra: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                url: "https://private.example/image.png",
                private_custom_source: true,
              },
            },
          ],
        },
      ],
    },
    param: "source_extension",
  },
  {
    name: "tool schema extension",
    extra: {
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: {},
            private_custom_schema: true,
          },
        },
      ],
    },
    param: "tool_extension",
  },
  {
    name: "format extension",
    extra: {
      output_config: {
        format: {
          type: "json_object",
          private_custom_format: true,
        },
      },
    },
    param: "format_extension",
  },
] as const)(
  "best-effort translates custom-provider nested $name without local rejection",
  async ({ extra, param }) => {
    const response = await server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-chat-model",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
        ...extra,
      }),
    })

    expectChatDispatch(
      response,
      (requestBody) => {
        if (param === "source_extension") {
          expect(requestBody).toMatchObject({
            model: "custom-chat-model",
            max_tokens: 16,
            messages: [
              {
                role: "user",
                content:
                  '[image attachment "https://private.example/image.png" omitted: the URL could not be fetched by the proxy]',
              },
            ],
          })
          return
        }

        if (param === "tool_extension") {
          expect(requestBody).toMatchObject({
            model: "custom-chat-model",
            max_tokens: 16,
            messages: [{ role: "user", content: "hello" }],
            tools: [
              {
                type: "function",
                function: {
                  name: "lookup",
                  parameters: {
                    type: "object",
                    properties: {},
                    private_custom_schema: true,
                  },
                },
              },
            ],
          })
          return
        }

        expect(requestBody).toMatchObject({
          model: "custom-chat-model",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
          response_format: {
            type: "json_object",
            private_custom_format: true,
          },
        })
        expect(JSON.stringify(requestBody)).not.toContain(
          "endpoint_translation_unsupported",
        )
      },
      {
        requestCount: param === "source_extension" ? 2 : 1,
      },
    )
  },
)

test("Claude Code Messages cache-control routes to ZenMux custom provider", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "z-ai/glm-5.3-free",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    }),
  })
  const body = (await response.json()) as { model: string }

  expect(body.model).toBe("z-ai/glm-5.3-free")
  expectChatDispatch(
    response,
    (requestBody) => {
      expect(requestBody).toMatchObject({
        model: "z-ai/glm-5.3-free",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      })
      expect(JSON.stringify(requestBody)).not.toContain("cache_control")
    },
    {
      url: "https://zenmux.example/v1/chat/completions",
    },
  )
  expect(routingSnapshot().models[0]).toMatchObject({
    accounts: [],
    model: "z-ai/glm-5.3-free",
    provider: "ZenMux",
    requests: 1,
    upstreamCalls: 1,
  })
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

  expect(routingSnapshot().models[0]).toMatchObject({
    accounts: [],
    model: "Qwen/Qwen3-Embedding-8B",
    provider: "Nebius",
    requests: 1,
    upstreamCalls: 1,
  })
})

test("records custom-provider transport failures without swallowing them", async () => {
  fetchMock.mockImplementationOnce(() => {
    throw new Error("custom provider connection failed")
  })

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      model: "custom-chat-model",
    }),
  })

  expect(response.status).toBe(500)
  expect(routingSnapshot().models[0]).toMatchObject({
    accounts: [],
    model: "custom-chat-model",
    outcomes: { transportError: 1 },
    provider: "Custom Chat",
    upstreamCalls: 1,
  })
})

test("preserves custom-provider chat response identity and exact bytes", async () => {
  const statusMarker = "custom-private-status"
  const body = new TextEncoder().encode(" custom-private-body\r\n")
  const upstream = new Response(body.slice(), {
    status: 400,
    statusText: statusMarker,
    headers: { "content-type": "application/problem+json" },
  })
  fetchMock.mockImplementationOnce(() => upstream)
  const errorSpy = spyOn(consola, "error")

  try {
    const reference = resolveCustomProviderModel({
      model: "custom-chat-model",
      kind: "chat",
      copilotModelIds: new Set(),
    })
    if (!reference) throw new TypeError("Expected custom chat reference")
    const error = await createCustomProviderChatCompletions(reference, {
      model: "custom-chat-model",
      messages: [{ role: "user", content: "hello" }],
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).response).toBe(upstream)
    expect(upstream.bodyUsed).toBe(false)

    const output = JSON.stringify(errorSpy.mock.calls)
    expect(output).not.toContain(statusMarker)

    fetchMock.mockImplementationOnce(
      () =>
        new Response(body.slice(), {
          status: 400,
          statusText: statusMarker,
          headers: { "content-type": "application/problem+json" },
        }),
    )
    const response = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "custom-chat-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    )
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(body),
    )
  } finally {
    errorSpy.mockRestore()
  }
})

test("preserves custom-provider embedding binary failures", async () => {
  const body = Uint8Array.from([0, 255, 13, 10, 65])
  const upstream = new Response(body.slice(), {
    status: 422,
    headers: { "content-type": "application/octet-stream" },
  })
  fetchMock.mockImplementationOnce(() => upstream)
  const reference = resolveCustomProviderModel({
    model: "qwen3-embedding-8b",
    kind: "embedding",
    copilotModelIds: new Set(),
  })
  if (!reference) throw new TypeError("Expected custom embedding reference")

  const error = await createCustomProviderEmbeddings(reference, {
    model: "qwen3-embedding-8b",
    input: "hello",
  }).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).response).toBe(upstream)
  expect(upstream.bodyUsed).toBe(false)

  fetchMock.mockImplementationOnce(
    () =>
      new Response(body.slice(), {
        status: 422,
        headers: { "content-type": "application/octet-stream" },
      }),
  )
  const response = await server.request("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3-embedding-8b", input: "hello" }),
  })
  expect(response.status).toBe(422)
  expect(response.headers.get("content-type")).toBe("application/octet-stream")
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
    Array.from(body),
  )
})

test("keeps future-named custom SSE data after comments and unknown fields", async () => {
  const chunk = {
    id: "chunk_future",
    object: "chat.completion.chunk",
    created: 1,
    model: "provider-model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "future" },
        finish_reason: null,
      },
    ],
  }
  fetchMock.mockImplementationOnce(
    () =>
      new Response(
        `: keepalive\nx-future: ignored\n\nevent: provider.future\ndata: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  )

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  })
  const text = await response.text()

  expect(response.status).toBe(200)
  expect(text).toContain("event: provider.future")
  expect(text).toContain('"id":"chunk_future"')
  expect(text).toContain('"model":"custom-chat-model"')
  expect(text).toContain("data: [DONE]")
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

test("dashboard stores provider API key without returning it", async () => {
  const admin = await createTestAdminSession()
  const response = await server.request("/dashboard/api/custom-providers", {
    method: "POST",
    headers: adminHeaders(admin),
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
    apiKeyConfigured?: boolean
    apiKeyEnv?: string
  }

  expect(response.status).toBe(200)
  expect(body.apiKey).toBeUndefined()
  expect(body.apiKeyConfigured).toBe(true)
  expect(body.apiKeyEnv).toBeUndefined()

  const chatResponse = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_GATEWAY_KEY}`,
    },
    body: JSON.stringify({
      model: "dashboard-chat",
      messages: [{ role: "user", content: "hello" }],
    }),
  })

  expect(chatResponse.status).toBe(200)
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer dashboard-key")
})

test("Nebius dashboard shortcut never returns the submitted API key", async () => {
  const admin = await createTestAdminSession()
  const response = await server.request(
    "/dashboard/api/custom-providers/nebius-qwen3",
    {
      method: "POST",
      headers: adminHeaders(admin),
      body: JSON.stringify({ apiKey: "nebius-dashboard-secret" }),
    },
  )
  const body = (await response.json()) as {
    apiKey?: string
    apiKeyConfigured?: boolean
    headerNames?: Array<string>
  }

  expect(response.status).toBe(200)
  expect(body.apiKey).toBeUndefined()
  expect(body.apiKeyConfigured).toBe(true)
  expect(body.headerNames).toEqual([])
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
