import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { selectMessagesUpstreamEndpoint } from "~/routes/messages/handler"
import {
  checkMessagesToChatTranslation,
  checkMessagesToResponsesTranslation,
} from "~/routes/messages/translation-fidelity"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const upstreamBodies: Array<Record<string, unknown>> = []
const upstreamHeaders: Array<Headers> = []
const upstreamPaths: Array<string> = []
const queuedMessagesResults: Array<Error | Response> = []
const TEST_ACCOUNT_IDS = [91_001, 91_002, 92_001, 92_002]

const fetchMock = mock(
  (url: string | URL | Request, init?: RequestInit): Response => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    const path = new URL(rawUrl).pathname
    upstreamPaths.push(path)
    upstreamHeaders.push(new Headers(init?.headers))
    upstreamBodies.push(
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {},
    )

    if (path === "/v1/messages") {
      const queued = queuedMessagesResults.shift()
      if (queued instanceof Error) throw queued
      if (queued) return queued
      return Response.json({
        id: "msg_route",
        type: "message",
        role: "assistant",
        model: "route-model",
        content: [{ type: "text", text: "native" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
    if (path === "/responses") {
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
            content: [{ type: "output_text", text: "responses" }],
          },
        ],
        output_text: "responses",
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
    }
    if (path === "/chat/completions") {
      return Response.json({
        id: "chat_route",
        object: "chat.completion",
        created: 1,
        model: "route-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "chat" },
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
    return new Response("unexpected upstream path", { status: 500 })
  },
)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  removeTestAccounts()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

afterEach(removeTestAccounts)

beforeEach(() => {
  fetchMock.mockClear()
  upstreamBodies.length = 0
  upstreamHeaders.length = 0
  upstreamPaths.length = 0
  queuedMessagesResults.length = 0
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = undefined
  state.sessionId = "messages-routing-test"
  removeTestAccounts()
})

test.each([
  {
    name: "dual Messages and Responses",
    endpoints: ["/responses", "/v1/messages"],
    expected: "/v1/messages",
  },
  {
    name: "Messages only",
    endpoints: ["/v1/messages"],
    expected: "/v1/messages",
  },
  {
    name: "Responses only",
    endpoints: ["/responses"],
    expected: "/responses",
  },
  {
    name: "Chat only",
    endpoints: ["/chat/completions"],
    expected: "/chat/completions",
  },
  {
    name: "missing endpoint metadata",
    endpoints: undefined,
    expected: "/chat/completions",
  },
])(
  "routes ordinary Messages through $name",
  async ({ endpoints, expected }) => {
    installModel({
      supported_endpoints: endpoints ? [...endpoints] : undefined,
    })

    const response = await postMessages({
      messages: [{ role: "user", content: "hello" }],
    })

    expect(response.status).toBe(200)
    expect(upstreamPaths).toEqual([expected])
  },
)

test("prefers native Messages and preserves signed thinking", async () => {
  installModel({ supported_endpoints: ["/responses", "/v1/messages"] })

  const response = await postMessages({
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "prior thought",
            signature: "valid-native-signature",
          },
        ],
      },
      { role: "user", content: "continue" },
    ],
  })

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages"])
  expect(JSON.stringify(upstreamBodies[0])).toContain("valid-native-signature")
})

test("recovers once from a deterministic native signature rejection", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    ),
    nativeSuccess("recovered"),
  )

  const response = await postMessages(
    {
      messages: signedThinkingHistory(),
      thinking: { type: "enabled" },
    },
    {
      "anthropic-beta": "beta-one, beta-two, beta-one",
      "anthropic-version": "2024-01-01",
      "x-model-provider-preference": "anthropic",
    },
  )

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages", "/v1/messages"])
  expect(JSON.stringify(upstreamBodies[0])).toContain("native-signature")
  expect(JSON.stringify(upstreamBodies[1])).not.toContain('"type":"thinking"')
  expect(upstreamBodies[1]).toHaveProperty("thinking", { type: "enabled" })
  for (const headers of upstreamHeaders) {
    expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
    expect(headers.get("anthropic-version")).toBe("2024-01-01")
    expect(headers.get("x-model-provider-preference")).toBe("anthropic")
  }
})

test("keeps native signature recovery on the account used by the first send", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  state.isMultiToken = true
  registerAccount(91_001, "first-account-token")
  registerAccount(91_002, "alternate-account-token")
  tokenPool.rebuildModelIndex()
  queuedMessagesResults.push(
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    nativeSuccess("same-account-recovery"),
  )

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(200)
  expect(
    upstreamHeaders.map((headers) => headers.get("authorization")),
  ).toEqual(["Bearer first-account-token", "Bearer first-account-token"])
})

test.each([
  {
    name: "generic Bad Request",
    response: new Response("Bad Request", { status: 400 }),
  },
  {
    name: "unrelated invalid request",
    response: Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid max_tokens" },
      },
      { status: 400 },
    ),
  },
])("does not recover native thinking for $name", async ({ response }) => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(response, nativeSuccess("must-not-send"))

  const result = await postMessages({ messages: signedThinkingHistory() })

  expect(result.status).toBe(400)
  expect(upstreamPaths).toEqual(["/v1/messages"])
})

test("does not recover a streaming native signature rejection", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    nativeSuccess("must-not-send"),
  )

  const response = await postMessages({
    messages: signedThinkingHistory(),
    stream: true,
  })

  expect(response.status).toBe(400)
  expect(upstreamPaths).toEqual(["/v1/messages"])
})

test("suppresses signature recovery after transport retry exhausts the shared send budget", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  state.isMultiToken = true
  registerAccount(92_001, "budget-primary-token")
  registerAccount(92_002, "budget-secondary-token")
  tokenPool.rebuildModelIndex()
  queuedMessagesResults.push(
    Response.json(
      {
        type: "error",
        error: { type: "overloaded_error", message: "rate limited" },
      },
      { status: 429, headers: { "retry-after": "0" } },
    ),
    Response.json(
      {
        type: "error",
        error: { type: "overloaded_error", message: "still rate limited" },
      },
      { status: 429 },
    ),
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid signature in thinking block",
        },
      },
      { status: 400 },
    ),
    nativeSuccess("fourth-send-must-not-happen"),
  )

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(400)
  expect(upstreamPaths).toEqual([
    "/v1/messages",
    "/v1/messages",
    "/v1/messages",
  ])
  expect(JSON.stringify(upstreamBodies[2])).toContain("native-signature")
})

test.each([
  {
    name: "ToolSearch reference",
    extra: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_search",
              content: [{ type: "tool_reference", tool_name: "Bash" }],
            },
          ],
        },
      ],
    },
    param: "tool_reference",
  },
  {
    name: "unknown native tool without schema",
    extra: {
      tools: [{ type: "future_native_tool", name: "future_tool" }],
    },
    param: "native_tool:future_native_tool",
  },
])(
  "rejects a Responses-only $name before upstream dispatch",
  async ({ extra, param }) => {
    installModel({ supported_endpoints: ["/responses"] })

    const response = await postMessages(extra)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_translation_unsupported",
        message:
          "The selected Copilot model cannot accept this request without losing required protocol data.",
        param,
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test("rejects an explicit empty endpoint list before upstream dispatch", async () => {
  installModel({ supported_endpoints: [] })

  const response = await postMessages({})

  expect(response.status).toBe(400)
  expect(await response.json()).toHaveProperty(
    "error.code",
    "endpoint_translation_unsupported",
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

test("selects native then Responses then Chat without mutating inputs", () => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [{ role: "user" as const, content: "hello" }],
  }
  const model = createModel({
    supported_endpoints: ["/chat/completions", "/responses", "/v1/messages"],
  })
  const payloadSnapshot = structuredClone(payload)
  const modelSnapshot = structuredClone(model)

  expect(
    selectMessagesUpstreamEndpoint({ payload, selectedModel: model }),
  ).toEqual({
    reason: "native",
    source: "messages",
    target: "/v1/messages",
    translated: false,
  })
  expect(payload).toEqual(payloadSnapshot)
  expect(model).toEqual(modelSnapshot)
})

test("allows the mapped Messages translation subset", () => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "inspect" },
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png" as const,
              data: "AA==",
            },
          },
          {
            type: "document" as const,
            source: {
              type: "base64" as const,
              media_type: "application/pdf",
              data: "JVBERi0=",
            },
          },
        ],
      },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "calling" },
          {
            type: "tool_use" as const,
            id: "toolu_lookup",
            name: "lookup",
            input: { query: "value" },
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "toolu_lookup",
            content: "done",
          },
        ],
      },
    ],
    system: [{ type: "text" as const, text: "system" }],
    stop_sequences: ["END"],
    temperature: 0.4,
    top_p: 0.8,
    output_config: { effort: "high" as const },
    tools: [
      {
        name: "lookup",
        description: "Lookup a value",
        input_schema: { type: "object", properties: {} },
      },
    ],
    tool_choice: { type: "tool" as const, name: "lookup" },
  }

  expect(checkMessagesToResponsesTranslation(payload)).toEqual({
    supported: true,
    blockers: [],
  })
  expect(checkMessagesToChatTranslation(payload)).toEqual({
    supported: true,
    blockers: [],
  })
})

test.each([
  {
    name: "native cache and context controls",
    extra: {
      cache_control: { type: "ephemeral" },
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      fallback_credit_token: "opaque-credit",
      stop_details: { reason: "native" },
    },
    responses: [
      "fallback_credit_token",
      "stop_details",
      "context_management",
      "cache_control",
    ],
    chat: [
      "fallback_credit_token",
      "stop_details",
      "context_management",
      "cache_control",
    ],
  },
  {
    name: "endpoint-specific reasoning signatures",
    extra: {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "responses state",
              signature: "encrypted@rs_1",
            },
            {
              type: "thinking",
              thinking: "native state",
              signature: "native-signature",
            },
          ],
        },
      ],
    },
    responses: ["thinking_signature"],
    chat: ["thinking_signature"],
  },
])("reports pure blockers for $name", ({ extra, responses, chat }) => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    ...extra,
  }
  const snapshot = structuredClone(payload)

  expect(
    checkMessagesToResponsesTranslation(payload as never).blockers,
  ).toEqual([...responses])
  expect(checkMessagesToChatTranslation(payload as never).blockers).toEqual([
    ...chat,
  ])
  expect(payload).toEqual(snapshot)
})

function postMessages(
  extra: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    server.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: "route-model",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        ...extra,
      }),
    }),
  )
}

function signedThinkingHistory(): Array<Record<string, unknown>> {
  return [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "prior thought",
          signature: "native-signature",
        },
        { type: "text", text: "answer" },
      ],
    },
    { role: "user", content: "continue" },
  ]
}

function nativeSuccess(text: string): Response {
  return Response.json({
    id: `msg_${text}`,
    type: "message",
    role: "assistant",
    model: "route-model",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

function installModel(options: { supported_endpoints?: Array<string> }): void {
  state.models = {
    object: "list",
    data: [createModel(options)],
  } satisfies ModelsResponse
}

function registerAccount(id: number, copilotToken: string): void {
  const account = tokenPool.addAccount(`github-${id}`, "individual", id)
  account.copilotToken = copilotToken
  account.models = new Set(["route-model"])
  account.modelsData = [createModel({ supported_endpoints: ["/v1/messages"] })]
  account.healthy = true
}

function removeTestAccounts(): void {
  for (const accountId of TEST_ACCOUNT_IDS) {
    tokenPool.removeAccountForTest(accountId)
  }
  tokenPool.rebuildModelIndex()
}

function createModel(options: { supported_endpoints?: Array<string> }): Model {
  return {
    id: "route-model",
    name: "route-model",
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    ...(options.supported_endpoints === undefined ?
      {}
    : { supported_endpoints: options.supported_endpoints }),
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 1024 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}
