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

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { selectResponsesUpstreamEndpoint } from "~/routes/responses/handler"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const originalModels = state.models
let lastUpstreamPath: string | undefined
let lastUpstreamPayload: Record<string, unknown> | undefined

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
  lastUpstreamPath = new URL(rawUrl).pathname
  lastUpstreamPayload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined

  if (lastUpstreamPath === "/v1/messages") {
    return Response.json({
      id: "msg_route",
      type: "message",
      role: "assistant",
      model: "route-model",
      content: [{ type: "text", text: "routed" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        cache_read_input_tokens: 1,
      },
    })
  }

  if (lastUpstreamPath === "/chat/completions") {
    return Response.json({
      id: "chatcmpl_route",
      object: "chat.completion",
      created: 1,
      model: "route-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "routed" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }

  return Response.json({
    id: "resp_route",
    object: "response",
    created_at: 1,
    model: "route-model",
    output: [
      {
        id: "msg_route",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "routed", annotations: [] }],
      },
    ],
    output_text: "routed",
    status: "completed",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.models = originalModels
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  lastUpstreamPath = undefined
  lastUpstreamPayload = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test.each([
  {
    name: "keeps a Responses-only model on native Responses",
    endpoints: ["/responses"],
    expected: "/responses",
  },
  {
    name: "keeps native Responses ahead of advertised Messages and Chat",
    endpoints: ["/responses", "/v1/messages", "/chat/completions"],
    expected: "/responses",
  },
  {
    name: "uses Chat when endpoint metadata is missing",
    endpoints: undefined,
    expected: "/chat/completions",
  },
  {
    name: "uses Chat for a Chat-only model",
    endpoints: ["/chat/completions"],
    expected: "/chat/completions",
  },
  {
    name: "uses Messages for a Messages-only model",
    endpoints: ["/v1/messages"],
    expected: "/v1/messages",
  },
])("$name", async ({ endpoints, expected }) => {
  installModel({
    supported_endpoints: endpoints ? [...endpoints] : undefined,
  })

  const response = await postResponses({ input: "hello" })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe(expected)
})

test("prefers Messages over Chat for a PDF-capable fallback", async () => {
  installModel({ supported_endpoints: ["/v1/messages", "/chat/completions"] })

  const response = await postResponses({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Read this" },
          {
            type: "input_file",
            filename: "doc.pdf",
            file_data: "data:application/pdf;base64,AA==",
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(lastUpstreamPayload).toHaveProperty(
    "messages.0.content.1.source.data",
    "AA==",
  )
})

test("normalizes raw base64 attachments before Messages fallback", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "doc.pdf",
            file_data: "AA==",
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload).toHaveProperty(
    "messages.0.content.0.source.data",
    "AA==",
  )
})

test("applies the sanctioned apply_patch rewrite before Chat route selection", async () => {
  installModel({ supported_endpoints: ["/chat/completions"] })

  const response = await postResponses({
    input: "Edit the file.",
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ],
    tool_choice: "auto",
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
  expect(lastUpstreamPayload).toHaveProperty(
    "tools.0.function.name",
    "apply_patch",
  )
})

test.each(["web_search", "web_search_20250305", "web_search_preview"])(
  "applies the %s rewrite before Chat-only route selection",
  async (type) => {
    installModel({ supported_endpoints: ["/chat/completions"] })

    const response = await postResponses({
      input: "Search current information.",
      tools: [
        {
          type,
          external_web_access: true,
          filters: { allowed_domains: ["example.com"] },
        },
      ],
      tool_choice: "auto",
    })

    expect(response.status).toBe(200)
    expect(lastUpstreamPath).toBe("/chat/completions")
    expect(lastUpstreamPayload).toHaveProperty(
      "tools.0.function.name",
      "web_search",
    )
  },
)

test("keeps native Responses priority for hosted web search", async () => {
  installModel({
    supported_endpoints: ["/responses", "/chat/completions"],
  })

  const response = await postResponses({
    input: "Search current information.",
    tools: [{ type: "web_search", external_web_access: true }],
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).toHaveProperty("tools.0.type", "web_search")
})

test("normalizes Responses controls before Messages fallback conversion", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({
    input: "Return JSON.",
    max_output_tokens: 1,
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: { properties: { answer: { type: "string" } } },
      },
    },
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: null,
        strict: false,
      },
    ],
    tool_choice: "auto",
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload).toHaveProperty("max_tokens", 16)
  expect(lastUpstreamPayload).toHaveProperty("tools.0.input_schema", {
    type: "object",
    properties: {},
  })
  expect(lastUpstreamPayload).toHaveProperty(
    "output_config.format.schema.additionalProperties",
    false,
  )
})

test.each([
  {
    name: "temperature and effort",
    request: {
      temperature: 0.4,
      reasoning: { effort: "high", summary: "auto" },
    },
    wire: { temperature: 0.4, output_config: { effort: "high" } },
  },
  {
    name: "top_p and effort",
    request: {
      top_p: 0.8,
      reasoning: { effort: "high", summary: "auto" },
    },
    wire: { top_p: 0.8, output_config: { effort: "high" } },
  },
  {
    name: "integer reasoning",
    request: { reasoning: { effort: 2048, summary: "auto" } },
    wire: { thinking: { type: "enabled", budget_tokens: 2048 } },
  },
])(
  "preserves accepted $name on native Messages wire",
  async ({ request, wire }) => {
    installModel({ supported_endpoints: ["/v1/messages"] })

    const response = await postResponses({ input: "hello", ...request })

    expect(response.status).toBe(200)
    expect(lastUpstreamPayload).toMatchObject(wire)
  },
)

test("rejects incompatible Messages sampling without upstream dispatch", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({
    input: "hello",
    temperature: 0.4,
    top_p: 0.8,
  })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param: "sampling" },
  })
})

test("rejects unsupported Messages reasoning effort without upstream dispatch", async () => {
  installModel({
    supported_endpoints: ["/v1/messages"],
    reasoning_effort: [],
  })

  const response = await postResponses({
    input: "hello",
    reasoning: { effort: "high", summary: "auto" },
  })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "reasoning_effort",
    },
  })
})

test.each(["concise", "detailed", "future_private_summary"])(
  "rejects Messages-only unmapped reasoning summary %s without upstream",
  async (summary) => {
    installModel({ supported_endpoints: ["/v1/messages"] })

    const response = await postResponses({
      input: "hello",
      reasoning: { effort: "high", summary },
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({
      error: {
        code: "endpoint_translation_unsupported",
        param: "reasoning_summary",
      },
    })
  },
)

test("returns a synthetic Responses stream for a Messages fallback", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({ input: "hello", stream: true })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/v1/messages")
  expect(lastUpstreamPayload?.stream).toBe(false)
  const body = await response.text()
  expect(body).toContain("event: response.created")
  expect(body).toContain("event: response.output_text.delta")
  expect(body).toContain("event: response.completed")
})

test("fails locally when the model advertises no supported inference endpoint", async () => {
  installModel({ supported_endpoints: [] })

  const response = await postResponses({ input: "hello" })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "request_shape",
    },
  })
})

test("rejects Messages-only opaque reasoning without upstream dispatch", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({
    input: [
      {
        type: "reasoning",
        encrypted_content: "private-state",
        summary: [],
      },
    ],
  })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "opaque_reasoning",
    },
  })
})

test.each([
  { name: "missing role", item: { type: "message", content: "hello" } },
  {
    name: "unknown role",
    item: { type: "message", role: "future_private_role", content: "hello" },
  },
  {
    name: "numeric role",
    item: { type: "message", role: 7, content: "hello" },
  },
])("rejects Messages-only explicit message with $name", async ({ item }) => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({ input: [item] })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param: "message_role" },
  })
})

test.each([
  {
    name: "orphan tool result",
    input: [{ type: "function_call_output", call_id: "call_1", output: "x" }],
    param: "tool_result_pairing",
  },
  {
    name: "non-object function arguments",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "[]",
      },
    ],
    param: "function_arguments",
  },
  {
    name: "unsupported image source",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:text/plain;base64,AA==",
            detail: "auto",
          },
        ],
      },
    ],
    param: "input_image",
  },
])("rejects Messages-only $name without upstream", async ({ input, param }) => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  const response = await postResponses({ input })
  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param },
  })
})

test.each([
  {
    name: "partial tool results at EOF",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "first" },
    ],
  },
  {
    name: "tool calls without results at EOF",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
    ],
  },
  {
    name: "partial tool results interrupted by a message",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "first" },
      { type: "message", role: "user", content: "continue" },
    ],
  },
])("rejects Messages-only $name", async ({ input }) => {
  installModel({ supported_endpoints: ["/v1/messages"] })

  const response = await postResponses({ input })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "tool_result_pairing",
    },
  })
})

test("rejects a Messages image URL fetch failure instead of inserting omission text", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  fetchMock.mockImplementationOnce(() => Response.json({}, { status: 404 }))

  const response = await postResponses({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.invalid/private.png",
            detail: "auto",
          },
        ],
      },
    ],
  })

  expect(response.status).toBe(400)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(lastUpstreamPath).not.toBe("/v1/messages")
  expect(await response.json()).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "message_content_part",
    },
  })
})

test("routes Responses compaction through the existing Chat preservation path", async () => {
  installModel({ supported_endpoints: ["/v1/messages", "/chat/completions"] })

  const response = await postResponses({
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_compact",
        name: "exec",
        input: "run compact diagnostic",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_compact",
        output: "done",
      },
    ],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }),
    },
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
  expect(JSON.stringify(lastUpstreamPayload)).toContain("call_compact")
})

test("rejects an unsupported Responses translation before manual approval", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  state.manualApprove = true
  const promptSpy = spyOn(consola, "prompt").mockResolvedValue(true as never)

  try {
    const response = await postResponses({
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-state",
          summary: [],
        },
      ],
    })

    expect(response.status).toBe(400)
    expect(promptSpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    promptSpy.mockRestore()
    state.manualApprove = false
  }
})

test("selects Responses then Messages then Chat without mutating inputs", () => {
  const payload = { model: "route-model", input: "hello" }
  const model = createModel({
    supported_endpoints: ["/responses", "/v1/messages", "/chat/completions"],
  })
  const payloadSnapshot = structuredClone(payload)
  const modelSnapshot = structuredClone(model)

  expect(
    selectResponsesUpstreamEndpoint({ payload, selectedModel: model }),
  ).toEqual({
    reason: "native",
    source: "responses",
    target: "/responses",
    translated: false,
  })
  expect(payload).toEqual(payloadSnapshot)
  expect(model).toEqual(modelSnapshot)
})

function postResponses(extra: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(
    server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "route-model", ...extra }),
    }),
  )
}

function installModel(options: {
  reasoning_effort?: Array<string>
  supported_endpoints?: Array<string>
}): void {
  state.models = {
    object: "list",
    data: [createModel(options)],
  } satisfies ModelsResponse
}

function createModel(options: {
  reasoning_effort?: Array<string>
  supported_endpoints?: Array<string>
}): Model {
  return {
    id: "route-model",
    name: "Route Model",
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 1024 },
      object: "model_capabilities",
      supports: {
        reasoning_effort: options.reasoning_effort ?? [
          "low",
          "medium",
          "high",
          "max",
        ],
      },
      tokenizer: "cl100k_base",
      type: "chat",
    },
    ...(options.supported_endpoints ?
      { supported_endpoints: [...options.supported_endpoints] }
    : {}),
  }
}
