import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch

let lastResponsesPayload: ResponsesPayload | undefined
let lastHeaders: Record<string, string> | undefined
let lastPath: string | undefined
let lastBody: Record<string, unknown> | undefined

function parseRequestBody(init?: RequestInit): ResponsesPayload {
  if (typeof init?.body !== "string") {
    return {} as ResponsesPayload
  }

  return JSON.parse(init.body) as ResponsesPayload
}

function hasEphemeralCacheControl(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "ephemeral"
  )
}

const responsesResult = {
  id: "resp_1",
  object: "response" as const,
  created_at: 1,
  model: "gpt-4o-mini",
  output: [
    {
      id: "msg_1",
      type: "message" as const,
      role: "assistant" as const,
      status: "completed" as const,
      content: [{ type: "output_text" as const, text: "hello" }],
    },
  ],
  output_text: "hello",
  status: "completed",
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
  },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
}

const responsesCapableModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-4o-mini",
      name: "gpt-4o-mini",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

const fetchMock = mock((url: string, init?: RequestInit) => {
  lastPath = new URL(url).pathname
  lastResponsesPayload = parseRequestBody(init)
  lastBody = lastResponsesPayload as unknown as Record<string, unknown>
  lastHeaders = init?.headers as Record<string, string> | undefined

  return new Response(JSON.stringify(responsesResult), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  lastResponsesPayload = undefined
  lastHeaders = undefined
  lastPath = undefined
  lastBody = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = responsesCapableModels
  setModelRedirectsForTest([])
})

test("adds reasoning defaults on the Google AI responses path", async () => {
  const response = await server.request(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  const reasoning = lastResponsesPayload?.reasoning
  expect(reasoning).toBeTruthy()
  if (!reasoning) {
    throw new Error("Expected reasoning defaults on responses payload")
  }
  expect(reasoning.summary).toBe("auto")
  expect(lastResponsesPayload?.include).toContain("reasoning.encrypted_content")
})

test("routes Google googleSearch through Copilot native Responses web search", async () => {
  const response = await server.request(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "What changed today?" }] }],
        tools: [{ googleSearch: {} }],
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastResponsesPayload?.tools?.[0]).toMatchObject({
    type: "web_search",
  })
})

test("forwards Google maxOutputTokens above the advertised model limit", async () => {
  const response = await server.request(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 2048 },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(
    (lastResponsesPayload as Record<string, unknown> | undefined)
      ?.max_output_tokens,
  ).toBe(2048)
})

test("adds prompt caching markers on the Google AI responses path", async () => {
  const response = await server.request(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "Remember this context." }] },
          { role: "model", parts: [{ text: "Stored." }] },
          { role: "user", parts: [{ text: "Use the cached context." }] },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                parameters: {
                  type: "object",
                  properties: {
                    location: { type: "string" },
                  },
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  const inputItems = lastResponsesPayload?.input
  expect(Array.isArray(inputItems)).toBe(true)
  if (!Array.isArray(inputItems)) {
    throw new TypeError("Expected input array on responses payload")
  }
  const hasAssistantCacheMarker = inputItems.some((item) => {
    const record = item as {
      role?: unknown
      copilot_cache_control?: unknown
    }
    return (
      record.role === "assistant"
      && hasEphemeralCacheControl(record.copilot_cache_control)
    )
  })
  expect(hasAssistantCacheMarker).toBe(true)

  const tools = lastResponsesPayload?.tools
  expect(Array.isArray(tools)).toBe(true)
  if (!Array.isArray(tools)) {
    throw new TypeError("Expected tools array on responses payload")
  }
  const hasToolCacheMarker = tools.some((tool) => {
    return hasEphemeralCacheControl(
      (tool as { copilot_cache_control?: unknown }).copilot_cache_control,
    )
  })
  expect(hasToolCacheMarker).toBe(true)
})

test("detects vision and initiator headers on the Google AI responses path", async () => {
  const response = await server.request(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Review this image." },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: "aGVsbG8=",
                },
              },
            ],
          },
          { role: "model", parts: [{ text: "I will inspect it." }] },
        ],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastHeaders?.["Copilot-Vision-Request"]).toBe("true")
  expect(lastHeaders?.["X-Initiator"]).toBe("agent")
})

test("threads typed native options through the Google PDF Messages path", async () => {
  state.models = {
    object: "list",
    data: [
      {
        ...structuredClone(responsesCapableModels.data[0]),
        id: "claude-native",
        name: "claude-native",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }
  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    lastPath = new URL(url).pathname
    lastHeaders = init?.headers as Record<string, string> | undefined
    lastBody =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : undefined
    return Response.json({
      id: "msg_google_native",
      type: "message",
      role: "assistant",
      model: "claude-native",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })

  const response = await server.request(
    "/v1/models/claude-native:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": " beta-one,beta-two,beta-one ",
        "anthropic-version": "2024-01-01",
        "x-model-provider-preference": "anthropic",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Review the PDF." },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: "JVBERi0=",
                },
              },
            ],
          },
          { role: "model", parts: [{ text: "I will inspect it." }] },
        ],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastPath).toBe("/v1/messages")
  expect(new Headers(lastHeaders).get("anthropic-beta")).toBe(
    "beta-one,beta-two",
  )
  expect(new Headers(lastHeaders).get("anthropic-version")).toBe("2024-01-01")
  expect(new Headers(lastHeaders).get("x-model-provider-preference")).toBe(
    "anthropic",
  )
  expect(new Headers(lastHeaders).get("x-initiator")).toBe("agent")
  expect(lastBody).not.toHaveProperty("anthropic-beta")
  expect(lastBody).not.toHaveProperty("anthropic-version")
  expect(lastBody).not.toHaveProperty("x-model-provider-preference")
})

test("keeps the requested Google model in a redirected native response", async () => {
  state.models = {
    object: "list",
    data: [
      {
        ...structuredClone(responsesCapableModels.data[0]),
        id: "claude-target",
        name: "claude-target",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
      },
    ],
  }
  setModelRedirectsForTest([
    {
      id: "google-native-redirect",
      sourceModel: "claude-source",
      sourceEffort: "all",
      targetModel: "claude-target",
      enabled: true,
    },
  ])
  fetchMock.mockImplementationOnce(() =>
    Response.json({
      id: "msg_google_redirected",
      type: "message",
      role: "assistant",
      model: "claude-target",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  )

  const response = await server.request(
    "/v1/models/claude-source:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Review." },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: "JVBERi0=",
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )
  const body = (await response.json()) as { modelVersion?: string }

  expect(response.status).toBe(200)
  expect(body.modelVersion).toBe("claude-source")
})

test("rejects unsupported Google root request fields instead of silently dropping them", async () => {
  const response = await server.request(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        cachedContent: "cached-content-id",
      }),
    },
  )

  expect(response.status).toBe(400)
  const body = await response.json()
  expect(body).toEqual({
    error: {
      code: 400,
      message: "Unsupported Google AI request field(s): cachedContent",
      status: "INVALID_ARGUMENT",
    },
  })
})

test("rejects unsupported Google code execution instead of dropping it", async () => {
  const response = await server.request(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Run code." }] }],
        tools: [{ codeExecution: {} }],
      }),
    },
  )

  expect(response.status).toBe(400)
  const body = await response.json()
  expect(body).toEqual({
    error: {
      code: 400,
      message: "Unsupported Google AI tool type(s): codeExecution",
      status: "INVALID_ARGUMENT",
    },
  })
})
