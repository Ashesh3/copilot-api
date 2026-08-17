import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { setSsePreflushDeadlineForTest } from "../src/lib/sse-lifecycle"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch

let lastUpstreamPath: string | undefined
let lastUpstreamPayload: Record<string, unknown> | undefined
let delayBufferedWebSearchResponse = false
let delayedResponsesController:
  | ReadableStreamDefaultController<Uint8Array>
  | undefined

const responsesOnlyModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-5.5",
      name: "gpt-5.5",
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
    {
      id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
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

const responsesResult = {
  id: "resp_legacy",
  object: "response",
  created_at: 1,
  model: "gpt-5.5",
  output: [
    {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "encrypted-state",
      status: "completed",
    },
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "hello from responses",
          annotations: [],
        },
      ],
    },
  ],
  output_text: "hello from responses",
  status: "completed",
  usage: {
    input_tokens: 3,
    output_tokens: 4,
    total_tokens: 7,
    input_tokens_details: { cached_tokens: 1 },
    output_tokens_details: { reasoning_tokens: 2 },
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

const emptyOutputTextResponsesResult = {
  ...responsesResult,
  output: [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: '{"intent":"hybrid"}',
          annotations: [],
        },
      ],
    },
  ],
  output_text: "",
}

const responsesCreatedEvent = {
  type: "response.created",
  sequence_number: 0,
  response: {
    ...responsesResult,
    output: [],
    output_text: "",
    status: "in_progress",
    usage: null,
  },
}

const responsesTextDeltaEvent = {
  type: "response.output_text.delta",
  sequence_number: 1,
  item_id: "msg_1",
  output_index: 0,
  content_index: 0,
  delta: "hello streamed",
}

const responsesCompletedEvent = {
  type: "response.completed",
  sequence_number: 2,
  response: {
    ...responsesResult,
    output_text: "hello streamed",
    output: [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "hello streamed",
            annotations: [],
          },
        ],
      },
    ],
  },
}

function createResponsesSse(): Response {
  return new Response(
    [
      `event: response.created\ndata: ${JSON.stringify(responsesCreatedEvent)}`,
      `event: response.output_text.delta\ndata: ${JSON.stringify(responsesTextDeltaEvent)}`,
      `event: response.completed\ndata: ${JSON.stringify(responsesCompletedEvent)}`,
    ].join("\n\n") + "\n\n",
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

const fetchMock = mock((url: string, init?: RequestInit) => {
  lastUpstreamPath = new URL(url).pathname
  lastUpstreamPayload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined

  if (lastUpstreamPath.endsWith("/responses")) {
    if (
      delayBufferedWebSearchResponse
      && lastUpstreamPayload?.stream === false
    ) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            delayedResponsesController = controller
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    }
    if (lastUpstreamPayload?.stream === true) {
      return createResponsesSse()
    }

    return new Response(JSON.stringify(responsesResult), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  return new Response(
    JSON.stringify({
      id: "chatcmpl-direct",
      object: "chat.completion",
      created: 1,
      model: "gpt-5.5",
      choices: [],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )
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
  lastUpstreamPath = undefined
  lastUpstreamPayload = undefined
  delayBufferedWebSearchResponse = false
  delayedResponsesController = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = responsesOnlyModels
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

afterEach(() => {
  try {
    delayedResponsesController?.close()
  } catch {
    // The downstream may already have cancelled the request.
  }
  setSsePreflushDeadlineForTest()
})

test("routes legacy chat completions requests for responses-only models through /responses", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Say hello." },
      ],
      max_tokens: 32,
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.model).toBe("gpt-5.5")
  expect(lastUpstreamPayload?.instructions).toBe("Be concise.")
  expect(lastUpstreamPayload?.max_output_tokens).toBe(32)

  const body = (await response.json()) as {
    model: string
    choices: Array<{
      message: {
        content: string
        encrypted_content?: string
        reasoning_opaque?: string
        reasoning_text?: string
      }
    }>
    usage?: {
      completion_tokens: number
      completion_tokens_details?: { reasoning_tokens: number }
      prompt_tokens: number
      prompt_tokens_details?: { cached_tokens: number }
      total_tokens: number
    }
  }

  expect(body.model).toBe("gpt-5.5")
  expect(body.choices[0]?.message.content).toBe("hello from responses")
  expect(body.choices[0]?.message.reasoning_opaque).toBe("rs_1")
  expect(body.choices[0]?.message.reasoning_text).toBe("thinking")
  expect(body.choices[0]?.message.encrypted_content).toBe("encrypted-state")
  expect(body.usage).toEqual({
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
    prompt_tokens_details: { cached_tokens: 1 },
    completion_tokens_details: { reasoning_tokens: 2 },
  })
})

test("omits tool controls when a chat fallback request has no tools", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Reply without tools." }],
      tools: null,
      tool_choice: "auto",
      parallel_tool_calls: true,
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).not.toHaveProperty("tools")
  expect(lastUpstreamPayload).not.toHaveProperty("tool_choice")
  expect(lastUpstreamPayload).not.toHaveProperty("parallel_tool_calls")
})

test("preserves tool controls when a chat fallback request has tools", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Call the weather tool." }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Read the weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  const tools = lastUpstreamPayload?.tools as
    | Array<Record<string, unknown>>
    | undefined
  expect(tools).toHaveLength(1)
  expect(tools?.[0]).toMatchObject({
    type: "function",
    name: "get_weather",
    description: "Read the weather",
    parameters: { type: "object", properties: {} },
    strict: false,
  })
  expect(lastUpstreamPayload?.tool_choice).toBe("auto")
  expect(lastUpstreamPayload?.parallel_tool_calls).toBe(false)
})

test("normalizes deprecated Chat controls before Responses fallback translation", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Call the legacy lookup." }],
      functions: [
        {
          name: "legacy_lookup",
          description: "Legacy lookup",
          parameters: {},
        },
      ],
      function_call: { name: "legacy_lookup" },
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.tools).toEqual([
    {
      type: "function",
      name: "legacy_lookup",
      description: "Legacy lookup",
      parameters: { type: "object", properties: {} },
      strict: false,
      copilot_cache_control: { type: "ephemeral" },
    },
  ])
  expect(lastUpstreamPayload?.tool_choice).toEqual({
    type: "function",
    name: "legacy_lookup",
  })
  expect(lastUpstreamPayload).not.toHaveProperty("functions")
  expect(lastUpstreamPayload).not.toHaveProperty("function_call")
})

test("omits unsupported sampling parameters for responses-only fallback models", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Return JSON." }],
      temperature: 0.3,
      top_p: 0.8,
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).not.toHaveProperty("temperature")
  expect(lastUpstreamPayload).not.toHaveProperty("top_p")
})

test("omits unsupported temperature for gpt-5.4-mini chat fallback", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "user",
          content:
            'Rewrite this memory recall query into up to 3 concise search queries. Return JSON only: {"queries":[...]}.',
        },
      ],
      temperature: 0,
      max_tokens: 512,
      response_format: { type: "json_object" },
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.model).toBe("gpt-5.4-mini")
  expect(lastUpstreamPayload?.max_output_tokens).toBe(512)
  expect(lastUpstreamPayload?.text).toEqual({
    format: { type: "json_object" },
  })
  expect(lastUpstreamPayload?.instructions).toContain("valid JSON only")
  expect(lastUpstreamPayload).not.toHaveProperty("temperature")
})

test("routes chat json_schema as json_object with schema instruction for responses fallback", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "Return only JSON." },
        { role: "user", content: "Classify this." },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "RouteDecision",
          schema: {
            type: "object",
            properties: {
              intent: { type: "string" },
            },
            required: ["intent"],
          },
        },
      },
      stream: false,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.text).toEqual({
    format: { type: "json_object" },
  })
  expect(lastUpstreamPayload?.input).toEqual([
    {
      type: "message",
      role: "developer",
      content: "Respond with JSON.",
    },
    {
      type: "message",
      role: "user",
      content: "Classify this.",
    },
  ])
  expect(lastUpstreamPayload?.instructions).toContain("Return only JSON.")
  expect(lastUpstreamPayload?.instructions).toContain(
    "You MUST conform to this JSON schema",
  )
  expect(lastUpstreamPayload?.instructions).toContain('"intent"')
})

test("uses Responses output message text when output_text is empty", async () => {
  const originalResponsesResult = { ...responsesResult }
  Object.assign(responsesResult, emptyOutputTextResponsesResult)

  try {
    const response = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Return JSON." }],
        stream: false,
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0]?.message.content).toBe('{"intent":"hybrid"}')
  } finally {
    Object.assign(responsesResult, originalResponsesResult)
  }
})

test("streams responses-only models back as chat completion chunks", async () => {
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Say hello." }],
      stream: true,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload?.stream).toBe(true)

  const text = await response.text()
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))

  expect(dataLines.at(-1)).toBe("[DONE]")
  const chunks = dataLines
    .filter((line) => line !== "[DONE]")
    .map(
      (line) =>
        JSON.parse(line) as {
          model: string
          choices: Array<{
            delta: { content?: string; role?: string }
            finish_reason: string | null
          }>
          usage?: unknown
        },
    )

  expect(chunks[0]?.model).toBe("gpt-5.5")
  expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant")
  expect(
    chunks.some(
      (chunk) => chunk.choices[0]?.delta.content === "hello streamed",
    ),
  ).toBe(true)
  expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop")
  expect(chunks.at(-1)?.usage).toEqual({
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
    prompt_tokens_details: { cached_tokens: 1 },
    completion_tokens_details: {
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
      reasoning_tokens: 2,
    },
  })
})

test("commits a keepalive while the buffered web-search fallback is pending", async () => {
  setSsePreflushDeadlineForTest(20)
  delayBufferedWebSearchResponse = true
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Search current news." }],
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            parameters: {
              type: "object",
              properties: {
                blocked_domains: {
                  type: "array",
                  items: { type: "string" },
                  default: ["example.com"],
                },
              },
            },
          },
        },
      ],
      stream: true,
    }),
  })
  const body = response.body
  if (!body) throw new Error("Expected an SSE response body")
  const reader = body.getReader()
  const first = await reader.read()

  expect(lastUpstreamPayload?.stream).toBe(false)
  expect(first.done).toBe(false)
  const firstBytes: unknown = first.value
  if (!(firstBytes instanceof Uint8Array)) {
    throw new TypeError("Expected the initial keepalive bytes")
  }
  expect(new TextDecoder().decode(firstBytes)).toBe(": keepalive\n\n")
  await reader.cancel()
})
