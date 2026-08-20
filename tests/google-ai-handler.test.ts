/* eslint-disable max-lines -- Google route variants share one upstream transport harness */
import * as Sentry from "@sentry/bun"
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

import type { ResponsesPayload } from "../src/services/copilot/create-responses"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { state } from "../src/lib/state"
import { selectGoogleUpstreamEndpoint } from "../src/routes/google-ai/handler"
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

  if (lastPath === "/v1/messages") {
    if ((lastBody as { stream?: unknown } | undefined)?.stream === true) {
      return new Response(
        [
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "message-placeholder",
              type: "message",
              role: "assistant",
              content: [],
              model: "route-model",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          })}`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hello" },
          })}`,
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          })}`,
          'event: message_stop\ndata: {"type":"message_stop"}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return Response.json({
      id: "message-placeholder",
      type: "message",
      role: "assistant",
      model: "route-model",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
  if (lastPath === "/chat/completions") {
    return Response.json({
      id: "chat-placeholder",
      object: "chat.completion",
      created: 1,
      model: "route-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    })
  }
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

test.each([
  {
    label: "countTokens",
    path: "/v1/models/gpt-4o-mini:countTokens",
    message: "Unsupported Google AI action",
  },
  {
    label: "futureAction",
    path: "/v1/models/gpt-4o-mini:futureAction",
    message: "Unsupported Google AI action",
  },
  {
    label: "private unknown suffix",
    path: "/v1/models/gpt-4o-mini:private-action-marker",
    message: "Unsupported Google AI action",
  },
  {
    label: "empty suffix",
    path: "/v1/models/gpt-4o-mini:",
    message: "Missing Google AI action suffix",
  },
  {
    label: "missing suffix",
    path: "/v1/models/gpt-4o-mini",
    message: "Missing Google AI action suffix",
  },
])(
  "rejects unsupported Google action $label without parsing or forwarding",
  async ({ message, path }) => {
    const response = await server.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({
      error: {
        code: 400,
        message,
        status: "INVALID_ARGUMENT",
      },
    })
  },
)

test("does not expose an unknown Google action suffix to diagnostics", async () => {
  const privateAction = "private-action-marker"
  const debugLog = spyOn(consola, "debug")
  const errorLog = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )
  try {
    const response = await server.request(
      `/v1/models/gpt-4o-mini:${privateAction}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      },
    )

    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(privateAction)
    expect(
      JSON.stringify([
        debugLog.mock.calls,
        errorLog.mock.calls,
        captureException.mock.calls,
      ]),
    ).not.toContain(privateAction)
  } finally {
    debugLog.mockRestore()
    errorLog.mockRestore()
    captureException.mockRestore()
  }
})

test.each([
  {
    name: "Chat before translated endpoints for ordinary text",
    endpoints: ["/chat/completions", "/v1/messages", "/responses"],
    expectedPath: "/chat/completions",
  },
  {
    name: "Responses before Messages when Chat is unavailable",
    endpoints: ["/v1/messages", "/responses"],
    expectedPath: "/responses",
  },
  {
    name: "Messages-only text",
    endpoints: ["/v1/messages"],
    expectedPath: "/v1/messages",
  },
  {
    name: "Chat-only text",
    endpoints: ["/chat/completions"],
    expectedPath: "/chat/completions",
  },
  {
    name: "legacy omitted endpoint metadata",
    endpoints: undefined,
    expectedPath: "/chat/completions",
  },
] as const)("routes Google $name", async ({ endpoints, expectedPath }) => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.name = "Route Model"
  model.vendor = expectedPath === "/v1/messages" ? "anthropic" : "openai"
  model.supported_endpoints = endpoints ? [...endpoints] : undefined
  state.models = { object: "list", data: [model] }

  const response = await server.request(
    "/v1/models/route-model:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastPath).toBe(expectedPath)
})

test("routes streaming Google text to an advertised Messages-only endpoint", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.name = "Route Model"
  model.vendor = "anthropic"
  model.supported_endpoints = ["/v1/messages"]
  state.models = { object: "list", data: [model] }

  const response = await server.request(
    "/v1/models/route-model:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastPath).toBe("/v1/messages")
  const body = await response.text()
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(body).toContain("hello")
})

test.each([
  {
    endpoints: ["/chat/completions", "/v1/messages", "/responses"],
    expectedPath: "/responses",
  },
  {
    endpoints: ["/chat/completions", "/responses"],
    expectedPath: "/responses",
  },
  {
    endpoints: ["/chat/completions", "/v1/messages"],
    expectedPath: "/v1/messages",
  },
])(
  "routes Google PDF content away from Chat for $endpoints",
  async ({ endpoints, expectedPath }) => {
    const model = structuredClone(responsesCapableModels.data[0])
    model.id = "route-model"
    model.name = "Route Model"
    model.vendor = "openai"
    model.supported_endpoints = [...endpoints]
    state.models = { object: "list", data: [model] }

    const response = await server.request(
      "/v1/models/route-model:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
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
          ],
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(lastPath).toBe(expectedPath)
  },
)

test("rejects Google PDF content when the model advertises only Chat", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.name = "Route Model"
  model.supported_endpoints = ["/chat/completions"]
  state.models = { object: "list", data: [model] }

  const response = await server.request(
    "/v1/models/route-model:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: "JVBERi0=",
                },
              },
            ],
          },
        ],
      }),
    },
  )

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "message_content_part:file",
    },
  })
})

test("rejects Google requests when the model advertises no compatible endpoint", async () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.name = "Route Model"
  model.supported_endpoints = []
  state.models = { object: "list", data: [model] }

  const response = await server.request(
    "/v1/models/route-model:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      }),
    },
  )

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toEqual({
    error: {
      code: "endpoint_translation_unsupported",
      message:
        "The selected Copilot model cannot accept this request without losing required protocol data.",
      param: "request_shape",
      type: "invalid_request_error",
    },
  })
})

test("skips an advertised Google Messages endpoint when translation is lossy", () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.supported_endpoints = ["/v1/messages", "/chat/completions"]

  expect(
    selectGoogleUpstreamEndpoint({
      selectedModel: model,
      payload: {
        model: "route-model",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        prediction: { type: "content", content: "expected" },
      },
    }),
  ).toMatchObject({ target: "/chat/completions", translated: false })
})

test("returns the Google translation blocker when every advertised endpoint is lossy", () => {
  const model = structuredClone(responsesCapableModels.data[0])
  model.id = "route-model"
  model.supported_endpoints = ["/v1/messages"]

  expect(
    selectGoogleUpstreamEndpoint({
      selectedModel: model,
      payload: {
        model: "route-model",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        prediction: { type: "content", content: "expected" },
      },
    }),
  ).toEqual({
    blockers: ["prediction"],
    code: "endpoint_translation_unsupported",
    source: "chat",
  })
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
