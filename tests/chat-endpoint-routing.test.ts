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
  customGrammar?: boolean
  document?: boolean
  encryptedReasoning?: boolean
  fileId?: boolean
  model?: string
  pdf?: boolean
  signedReasoning?: boolean
  thinkingBudget?: boolean
  webSearch?: boolean
}): Promise<Response> {
  let content: unknown = "hello"
  if (options.pdf || options.fileId) {
    content = [
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
  } else if (options.document) {
    content = [
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
  let tools: Array<Record<string, unknown>> | undefined
  if (options.customGrammar) {
    tools = [{ type: "custom", format: { type: "grammar", syntax: "lark" } }]
  } else if (options.webSearch) {
    tools = [
      {
        type: "web_search",
        function: {
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      },
    ]
  }
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
      ...(tools ? { tools } : {}),
      ...(options.thinkingBudget ? { thinking_budget: 1024 } : {}),
      stream: false,
    }),
  })
}
