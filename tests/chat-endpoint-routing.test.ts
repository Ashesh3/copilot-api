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

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { selectChatUpstreamEndpoint } from "~/routes/chat-completions/handler"
import { server } from "~/server"

test.each([
  { name: "empty body", body: "" },
  {
    name: "malformed JSON",
    body: '{"model":"route-model","messages":[{"role":"user","content":"chat-json-private-marker"}]',
  },
])("returns a fixed 400 for Chat $name before routing", async ({ body }) => {
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  try {
    const response = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    const responseBody = await response.json()
    const diagnostics = JSON.stringify([
      responseBody,
      errorSpy.mock.calls,
      captureException.mock.calls,
    ])

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(diagnostics).not.toContain("chat-json-private-marker")
    expect(diagnostics).not.toContain("Unexpected end of JSON")
    expect(responseBody).toEqual({
      error: {
        code: "invalid_json",
        message: "The request body must contain valid JSON.",
        param: "body",
        type: "invalid_request_error",
      },
    })
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})

/* eslint-disable max-lines -- route matrix intentionally stays in one fixture-backed file */

const originalFetch = globalThis.fetch
let lastUpstreamPath: string | undefined
let lastUpstreamPayload: Record<string, unknown> | undefined

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
  lastUpstreamPath = new URL(rawUrl).pathname
  lastUpstreamPayload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined

  if (lastUpstreamPath === "/responses") {
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
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
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
    })
  }

  if (lastUpstreamPath === "/v1/messages") {
    return Response.json({
      id: "msg_route",
      type: "message",
      role: "assistant",
      model: "route-model",
      content: [{ type: "text", text: "routed" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  const body =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as { model?: string })
    : {}
  return Response.json({
    id: "chatcmpl_route",
    object: "chat.completion",
    created: 1,
    model: body.model ?? "route-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "routed" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
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

interface RouteCase {
  customGrammar?: boolean
  document?: boolean
  encryptedReasoning?: boolean
  endpoints: Array<string>
  expected: string
  fileId?: boolean
  name: string
  pdf?: boolean
  signedReasoning?: boolean
  thinkingBudget?: boolean
  webSearch?: boolean
}

const routeCases: Array<RouteCase> = [
  {
    name: "keeps an ordinary request on advertised Chat",
    endpoints: ["/chat/completions"],
    expected: "/chat/completions",
  },
  {
    name: "keeps an ordinary dual-capability request on Chat",
    endpoints: ["/chat/completions", "/responses"],
    expected: "/chat/completions",
  },
  {
    name: "uses Responses for a Responses-only model",
    endpoints: ["/responses"],
    expected: "/responses",
  },
  {
    name: "uses Messages for a Messages-only Claude model",
    endpoints: ["/v1/messages"],
    expected: "/v1/messages",
  },
  {
    name: "prefers Messages when Chat is unavailable and both bridges exist",
    endpoints: ["/v1/messages", "/responses"],
    expected: "/v1/messages",
  },
  {
    name: "prefers Messages for PDF content when Chat and Messages exist",
    endpoints: ["/chat/completions", "/v1/messages"],
    pdf: true,
    expected: "/v1/messages",
  },
  {
    name: "prefers Responses for hosted web search when available",
    endpoints: ["/chat/completions", "/responses"],
    webSearch: true,
    expected: "/responses",
  },
  {
    name: "prefers Messages for signed Anthropic reasoning",
    endpoints: ["/chat/completions", "/v1/messages", "/responses"],
    signedReasoning: true,
    expected: "/v1/messages",
  },
  {
    name: "prefers Messages for an Anthropic thinking budget",
    endpoints: ["/chat/completions", "/v1/messages", "/responses"],
    thinkingBudget: true,
    expected: "/v1/messages",
  },
  {
    name: "prefers Responses for encrypted OpenAI reasoning",
    endpoints: ["/chat/completions", "/v1/messages", "/responses"],
    encryptedReasoning: true,
    expected: "/responses",
  },
]

test.each(routeCases)(
  "$name",
  async ({
    customGrammar,
    document,
    encryptedReasoning,
    endpoints,
    expected,
    fileId,
    pdf,
    signedReasoning,
    thinkingBudget,
    webSearch,
  }) => {
    installModel({
      id: "route-model",
      supported_endpoints: [...endpoints],
    })

    const response = await postChatRoute({
      customGrammar,
      document,
      encryptedReasoning,
      fileId,
      pdf,
      signedReasoning,
      thinkingBudget,
      webSearch,
    })

    expect(response.status).toBe(200)
    expect(lastUpstreamPath).toBe(expected)
  },
)

test("emits one bounded Chat route event before dispatch", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })
  const debugSpy = spyOn(consola, "debug")

  try {
    const response = await postChatRoute({})

    expect(response.status).toBe(200)
    const routeEvents = debugSpy.mock.calls.filter(
      (call) =>
        call[0] === "[copilot-contract]"
        && (call[1] as { kind?: string; source?: string }).kind
          === "endpoint_route"
        && (call[1] as { kind?: string; source?: string }).source === "chat",
    )
    expect(routeEvents).toEqual([
      [
        "[copilot-contract]",
        {
          kind: "endpoint_route",
          source: "chat",
          target: "/chat/completions",
          translated: false,
          reason: "native",
        },
      ],
    ])
  } finally {
    debugSpy.mockRestore()
  }
})

test("rejects a Messages-only custom grammar without upstream dispatch", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/v1/messages"],
  })

  const response = await postChatRoute({ customGrammar: true })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toEqual({
    error: {
      code: "endpoint_translation_unsupported",
      message:
        "The selected Copilot model cannot accept this request without losing required protocol data.",
      param: "custom_tool_grammar",
      type: "invalid_request_error",
    },
  })
})

test.each([
  {
    name: "unknown typed content",
    body: {
      messages: [
        {
          role: "user",
          content: [{ type: "future_private_content", secret: "do-not-log" }],
        },
      ],
    },
    param: "message_content_part",
  },
  {
    name: "unknown typed tool",
    body: {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "future_private_tool", secret: "do-not-log" }],
    },
    param: "tool_semantics",
  },
])(
  "rejects Messages-only $name without upstream dispatch",
  async ({ body, param }) => {
    installModel({
      id: "route-model",
      supported_endpoints: ["/v1/messages"],
    })

    const response = await server.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "route-model", stream: false, ...body }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({
      error: { code: "endpoint_translation_unsupported", param },
    })
  },
)

test("routes file_id through Responses instead of losing it on Messages", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/v1/messages", "/responses"],
  })

  const response = await postChatRoute({ fileId: true })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
  expect(lastUpstreamPayload).toHaveProperty(
    "input.0.content.1.file_id",
    "file_review_1",
  )
})

test("rejects custom tools on a Chat-only model before upstream dispatch", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({ customGrammar: true })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects file sources on a Chat-only model before upstream dispatch", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({ fileId: true })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects document content on a Chat-only model before upstream dispatch", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({ document: true })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  { name: "Messages+Responses", endpoints: ["/v1/messages", "/responses"] },
  { name: "Messages-only", endpoints: ["/v1/messages"] },
])(
  "preserves document content through Messages for a $name model",
  async ({ endpoints }) => {
    installModel({ id: "route-model", supported_endpoints: [...endpoints] })

    const response = await postChatRoute({ document: true })

    expect(response.status).toBe(200)
    expect(lastUpstreamPath).toBe("/v1/messages")
    expect(lastUpstreamPayload).toHaveProperty(
      "messages.0.content.1.source.data",
      "AA==",
    )
  },
)

test("rejects unsupported document sources on a Messages-only model", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/v1/messages"],
  })

  const response = await postChatRoute({
    content: [
      {
        type: "document",
        source: { type: "url", url: "https://example.com/private.pdf" },
      },
    ],
  })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  { name: "primitive content", content: [7] },
  { name: "typeless content", content: [{ text: "hello" }] },
])("rejects $name on a Chat-only model", async ({ content }) => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({ content })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  { name: "numeric scalar", content: 7 },
  { name: "object scalar", content: { text: "hello" } },
])(
  "rejects $name message content on a Chat-only model",
  async ({ content }) => {
    installModel({
      id: "route-model",
      supported_endpoints: ["/chat/completions"],
    })

    const response = await postChatRoute({ content })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test.each([
  { name: "Responses", endpoints: ["/chat/completions", "/responses"] },
  { name: "Messages", endpoints: ["/chat/completions", "/v1/messages"] },
])(
  "rejects scalar message content before Chat can fall back to $name",
  async ({ endpoints }) => {
    installModel({ id: "route-model", supported_endpoints: [...endpoints] })

    const response = await postChatRoute({ content: { text: "hello" } })

    await expectSafeChatContractError(response, "messages")
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test.each([
  { name: "string", content: "hello" },
  { name: "null", content: null },
  { name: "validated array", content: [{ type: "text", text: "hello" }] },
])("accepts $name message content on Chat", async ({ content }) => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({ content, hasContent: true })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
})

test.each([
  { name: "object", tools: { type: "function" } },
  { name: "string", tools: "private-tools" },
])("rejects non-array $name tools on a Chat-only model", async ({ tools }) => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({ tools })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  { name: "Responses", endpoints: ["/chat/completions", "/responses"] },
  { name: "Messages", endpoints: ["/chat/completions", "/v1/messages"] },
])(
  "rejects non-array tools before Chat can fall back to $name",
  async ({ endpoints }) => {
    installModel({ id: "route-model", supported_endpoints: [...endpoints] })

    const response = await postChatRoute({ tools: { type: "function" } })

    await expectSafeChatContractError(response, "tools")
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test.each([
  { name: "null", tools: null },
  { name: "empty array", tools: [] },
])("accepts $name tools with no forced choice", async ({ tools }) => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({ tools })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
})

test.each([
  { name: "Responses", endpoints: ["/responses"] },
  { name: "Messages", endpoints: ["/v1/messages"] },
])(
  "serializes explicit null tools through the $name route",
  async ({ endpoints }) => {
    installModel({ id: "route-model", supported_endpoints: [...endpoints] })

    const response = await postChatRoute({ tools: null, hasTools: true })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastUpstreamPayload).not.toHaveProperty("tools")
  },
)

test.each([
  { name: "required", toolChoice: "required" },
  { name: "auto", toolChoice: "auto" },
  {
    name: "named function",
    toolChoice: { type: "function", function: { name: "lookup" } },
  },
])("rejects $name choice when no tools exist", async ({ toolChoice }) => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({ tools: [], toolChoice })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  {
    name: "Responses auto",
    endpoints: ["/chat/completions", "/responses"],
    toolChoice: "auto",
  },
  {
    name: "Responses required",
    endpoints: ["/chat/completions", "/responses"],
    toolChoice: "required",
  },
  {
    name: "Responses named function",
    endpoints: ["/chat/completions", "/responses"],
    toolChoice: { type: "function", function: { name: "lookup" } },
  },
  {
    name: "Messages auto",
    endpoints: ["/chat/completions", "/v1/messages"],
    toolChoice: "auto",
  },
  {
    name: "Messages required",
    endpoints: ["/chat/completions", "/v1/messages"],
    toolChoice: "required",
  },
  {
    name: "Messages named function",
    endpoints: ["/chat/completions", "/v1/messages"],
    toolChoice: { type: "function", function: { name: "lookup" } },
  },
])(
  "rejects $name without usable tools before endpoint selection",
  async ({ endpoints, toolChoice }) => {
    installModel({ id: "route-model", supported_endpoints: [...endpoints] })

    const response = await postChatRoute({
      tools: [],
      toolChoice,
    })

    await expectSafeChatContractError(response, "tool_choice")
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test.each([
  { name: "absent", toolChoice: undefined },
  { name: "null", toolChoice: null },
  { name: "none", toolChoice: "none" },
])("accepts $name choice when no tools exist", async ({ toolChoice }) => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({
    tools: [],
    ...(toolChoice !== undefined ? { toolChoice } : {}),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
})

test.each([
  {
    name: "null function",
    tools: [{ type: "function", function: null }],
  },
  {
    name: "blank function name",
    tools: [{ type: "function", function: { name: "", parameters: {} } }],
  },
])("rejects a $name tool on a Chat-only model", async ({ tools }) => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({ tools: [...tools] })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("rejects a malformed native tool choice on a Chat-only model", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({
    toolChoice: { type: "web_search", function: null },
  })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("keeps valid text function tools and choices on Chat", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    toolChoice: { type: "function", function: { name: "lookup" } },
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
})

test.each([
  { name: "Responses", endpoints: ["/responses"] },
  { name: "Messages", endpoints: ["/v1/messages"] },
])(
  "preserves a matching named function choice through the $name route",
  async ({ endpoints }) => {
    installModel({ id: "route-model", supported_endpoints: [...endpoints] })

    const response = await postChatRoute({
      tools: [createFunctionTool("lookup")],
      toolChoice: { type: "function", function: { name: "lookup" } },
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastUpstreamPayload).toHaveProperty(
      "tool_choice",
      endpoints[0] === "/responses" ?
        { type: "function", name: "lookup" }
      : { type: "tool", name: "lookup" },
    )
  },
)

test.each([
  { name: "Responses", endpoints: ["/chat/completions", "/responses"] },
  { name: "Messages", endpoints: ["/chat/completions", "/v1/messages"] },
])(
  "rejects a missing named function before Chat can fall back to $name",
  async ({ endpoints }) => {
    installModel({ id: "route-model", supported_endpoints: [...endpoints] })

    const response = await postChatRoute({
      tools: [createFunctionTool("lookup")],
      toolChoice: { type: "function", function: { name: "missing" } },
    })

    await expectSafeChatContractError(response, "tool_choice")
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test("prefers Responses for non-Anthropic models when Chat is unavailable", async () => {
  installModel({
    id: "claude-looking-openai-model",
    vendor: "openai",
    family: "gpt",
    supported_endpoints: ["/v1/messages", "/responses"],
  })

  const response = await postChatRoute({ model: "claude-looking-openai-model" })

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/responses")
})

test("reports only the advertised Responses blocker", () => {
  const decision = selectChatUpstreamEndpoint({
    payload: {
      model: "route-model",
      messages: [{ role: "user", content: "hello" }],
      thinking_budget: 1024,
      tools: [
        { type: "custom", format: { type: "grammar", syntax: "lark" } },
      ] as never,
    },
    selectedModel: createModel({
      id: "route-model",
      supported_endpoints: ["/responses"],
    }),
  })

  expect(decision).toEqual({
    blockers: ["thinking_budget"],
    code: "endpoint_translation_unsupported",
    source: "chat",
  })
})

test("rejects an unsupported translation before manual approval", async () => {
  installModel({
    id: "route-model",
    supported_endpoints: ["/v1/messages"],
  })
  state.manualApprove = true
  const promptSpy = spyOn(consola, "prompt").mockResolvedValue(true as never)

  try {
    const response = await postChatRoute({ customGrammar: true })

    expect(response.status).toBe(400)
    expect(promptSpy).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    promptSpy.mockRestore()
    state.manualApprove = false
  }
})

test("treats missing endpoint metadata as Chat-only", async () => {
  installModel({ id: "route-model" })

  const response = await postChatRoute({})

  expect(response.status).toBe(200)
  expect(lastUpstreamPath).toBe("/chat/completions")
})

test("rejects an unknown model before upstream dispatch", async () => {
  installModel({
    id: "different-model",
    supported_endpoints: ["/chat/completions"],
  })

  const response = await postChatRoute({})

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toHaveProperty(
    "error.code",
    "endpoint_translation_unsupported",
  )
})

test("rejects explicit empty endpoint metadata before upstream dispatch", async () => {
  installModel({ id: "route-model", supported_endpoints: [] })

  const response = await postChatRoute({})

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("selects a route without mutating the payload or model metadata", () => {
  const payload = {
    model: "route-model",
    messages: [{ role: "user" as const, content: "hello" }],
  }
  const selectedModel = createModel({
    id: "route-model",
    supported_endpoints: ["/chat/completions", "/responses"],
  })
  const originalPayload = structuredClone(payload)
  const originalModel = structuredClone(selectedModel)

  expect(selectChatUpstreamEndpoint({ payload, selectedModel })).toEqual({
    reason: "native",
    source: "chat",
    target: "/chat/completions",
    translated: false,
  })
  expect(payload).toEqual(originalPayload)
  expect(selectedModel).toEqual(originalModel)
})

test("selects the remaining lossless advertised translation", () => {
  const decision = selectChatUpstreamEndpoint({
    payload: {
      model: "route-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        { type: "custom", format: { type: "grammar", syntax: "lark" } },
      ] as never,
    },
    selectedModel: createModel({
      id: "route-model",
      supported_endpoints: ["/v1/messages", "/responses"],
    }),
  })

  expect(decision).toEqual({
    reason: "payload_requirement",
    source: "chat",
    target: "/responses",
    translated: true,
  })
})

function installModel(options: {
  family?: string
  id: string
  supported_endpoints?: Array<string>
  vendor?: string
}): void {
  state.models = {
    object: "list",
    data: [createModel(options)],
  } satisfies ModelsResponse
}

function createModel(options: {
  family?: string
  id: string
  supported_endpoints?: Array<string>
  vendor?: string
}): Model {
  return {
    id: options.id,
    name: options.id,
    object: "model",
    preview: false,
    vendor: options.vendor ?? "anthropic",
    version: "1",
    model_picker_enabled: true,
    ...(options.supported_endpoints ?
      { supported_endpoints: options.supported_endpoints }
    : {}),
    capabilities: {
      family: options.family ?? "claude",
      limits: { max_output_tokens: 1024 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

async function postChatRoute(options: {
  content?: unknown
  customGrammar?: boolean
  document?: boolean
  encryptedReasoning?: boolean
  fileId?: boolean
  hasContent?: boolean
  hasTools?: boolean
  model?: string
  pdf?: boolean
  signedReasoning?: boolean
  thinkingBudget?: boolean
  toolChoice?: unknown
  tools?: unknown
  webSearch?: boolean
}): Promise<Response> {
  const content = createRouteContent(options)
  const tools = createRouteTools(options)
  const messages = [
    ...(options.signedReasoning || options.encryptedReasoning ?
      [
        {
          role: "assistant",
          content: null,
          reasoning_text: "thinking",
          reasoning_opaque:
            options.encryptedReasoning ? "rs_openai" : "native-signature",
          ...(options.encryptedReasoning ?
            { encrypted_content: "encrypted-state" }
          : {}),
        },
      ]
    : []),
    { role: "user", content },
  ]

  return await server.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model ?? "route-model",
      messages,
      ...(options.hasTools || tools !== undefined ? { tools } : {}),
      ...(options.toolChoice !== undefined ?
        { tool_choice: options.toolChoice }
      : {}),
      ...(options.thinkingBudget ? { thinking_budget: 1024 } : {}),
      stream: false,
    }),
  })
}

function createRouteContent(options: {
  content?: unknown
  document?: boolean
  fileId?: boolean
  hasContent?: boolean
  pdf?: boolean
}): unknown {
  if (options.hasContent || options.content !== undefined)
    return options.content
  if (options.pdf || options.fileId) {
    return [
      { type: "text", text: "Read the PDF." },
      {
        type: "file",
        file: {
          filename: "brief.pdf",
          ...(options.fileId ?
            { file_id: "file_review_1" }
          : { file_data: "data:application/pdf;base64,AA==" }),
        },
      },
    ]
  }
  if (options.document) {
    return [
      { type: "text", text: "Read the document." },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "AA==",
        },
      },
    ]
  }
  return "hello"
}

function createRouteTools(options: {
  customGrammar?: boolean
  tools?: unknown
  webSearch?: boolean
}): unknown {
  if (options.tools !== undefined) return options.tools
  if (options.customGrammar) {
    return [{ type: "custom", format: { type: "grammar", syntax: "lark" } }]
  }
  if (options.webSearch) {
    return [
      {
        type: "web_search",
        function: {
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      },
    ]
  }
  return undefined
}

function createFunctionTool(name: string): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name,
      parameters: { type: "object", properties: {} },
    },
  }
}

async function expectSafeChatContractError(
  response: Response,
  param: string,
): Promise<void> {
  expect(response.status).toBe(400)
  const body: unknown = await response.json()
  expect(body).toMatchObject({
    error: {
      param,
      type: "invalid_request_error",
    },
  })
}
