/* eslint-disable max-lines -- route, fidelity, and recovery matrix share one transport harness */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
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
const TEST_ACCOUNT_IDS = [91_001, 91_002, 92_001, 92_002, 93_001, 93_002]

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
    if (path === "/mcp/readonly") {
      const requestBody = upstreamBodies.at(-1)
      if (requestBody?.method === "initialize") {
        return new Response(
          'data: {"jsonrpc":"2.0","id":"init","result":{}}\n\n',
          {
            headers: {
              "content-type": "text/event-stream",
              "Mcp-Session-Id": "route-session",
            },
          },
        )
      }
      return new Response(
        'data: {"jsonrpc":"2.0","id":"search","result":{"content":[{"type":"text","text":"current result"}]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
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

test("does not recover an unrelated 400 that merely contains invalid-signature words", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(
    Response.json(
      {
        error: {
          code: "different_error",
          message: "An unrelated validation mentions Invalid signature text",
        },
      },
      { status: 400 },
    ),
    nativeSuccess("must-not-send"),
  )

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(400)
  expect(upstreamPaths).toEqual(["/v1/messages"])
})

test.each([
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
  Response.json(
    {
      error: {
        code: "invalid_request_body",
        message: "Invalid `signature` in thinking block",
      },
    },
    { status: 400 },
  ),
])("recovers exact known native signature response %#", async (failure) => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  queuedMessagesResults.push(failure, nativeSuccess("recovered-exact"))

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual(["/v1/messages", "/v1/messages"])
})

test.each([
  new Response("{not-json", { status: 400 }),
  Response.json(
    { error: { code: "invalid_request_body", message: { private: true } } },
    { status: 400 },
  ),
])(
  "does not recover malformed or private signature body %#",
  async (failure) => {
    installModel({ supported_endpoints: ["/v1/messages"] })
    queuedMessagesResults.push(failure, nativeSuccess("must-not-send"))

    const response = await postMessages({ messages: signedThinkingHistory() })

    expect(response.status).toBe(400)
    expect(upstreamPaths).toEqual(["/v1/messages"])
  },
)

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

test("streaming native web search keeps recovery inside the loop and emits Anthropic SSE", async () => {
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
    Response.json({
      id: "msg_search",
      type: "message",
      role: "assistant",
      model: "route-model",
      content: [
        {
          type: "tool_use",
          id: "toolu_search",
          name: "web_search",
          input: { query: "current facts" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    nativeSuccess("streamed-final"),
  )

  const response = await postMessages({
    messages: signedThinkingHistory(),
    stream: true,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
  })
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(body).toContain("event: message_start")
  expect(body).toContain("streamed-final")
  expect(body).toContain("event: message_stop")
  expect(body).not.toContain('"type":"tool_use"')
  expect(upstreamPaths.filter((path) => path === "/v1/messages")).toHaveLength(
    3,
  )
})

test("pins native web-search follow-up to the account selected by failover", async () => {
  installModel({ supported_endpoints: ["/v1/messages"] })
  state.isMultiToken = true
  registerAccount(93_001, "web-primary-token")
  registerAccount(93_002, "web-secondary-token")
  tokenPool.rebuildModelIndex()
  queuedMessagesResults.push(
    Response.json(
      { type: "error", error: { type: "overloaded_error" } },
      { status: 429, headers: { "retry-after": "0" } },
    ),
    Response.json(
      { type: "error", error: { type: "overloaded_error" } },
      { status: 429 },
    ),
    Response.json(
      {
        id: "msg_search",
        type: "message",
        role: "assistant",
        model: "route-model",
        content: [
          {
            type: "thinking",
            thinking: "searching",
            signature: "signed-on-secondary",
          },
          {
            type: "tool_use",
            id: "toolu_search",
            name: "web_search",
            input: { query: "current facts" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { status: 200 },
    ),
    nativeSuccess("done"),
  )

  const response = await postMessages({
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
  })

  expect(response.status).toBe(200)
  const messageAttempts = upstreamPaths.flatMap((path, index) =>
    path === "/v1/messages" ? [index] : [],
  )
  expect(
    messageAttempts.map((index) =>
      upstreamHeaders[index]?.get("authorization"),
    ),
  ).toEqual([
    "Bearer web-primary-token",
    "Bearer web-primary-token",
    "Bearer web-secondary-token",
    "Bearer web-secondary-token",
  ])
  expect(JSON.stringify(upstreamBodies[messageAttempts[3]])).toContain(
    "signed-on-secondary",
  )
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

test("allows a recovery transport retry as the third shared send", async () => {
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
    Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    nativeSuccess("recovered-after-transport"),
    nativeSuccess("fourth-send-must-not-happen"),
  )

  const response = await postMessages({ messages: signedThinkingHistory() })

  expect(response.status).toBe(200)
  expect(upstreamPaths).toEqual([
    "/v1/messages",
    "/v1/messages",
    "/v1/messages",
  ])
  expect(JSON.stringify(upstreamBodies[2])).not.toContain('"type":"thinking"')
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
    supported: false,
    blockers: ["stop_sequences", "temperature"],
  })
  expect(checkMessagesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: ["document"],
  })
})

test.each([
  {
    name: "stop sequences",
    extra: { stop_sequences: ["END"] },
    responses: ["stop_sequences"],
    chat: [],
  },
  {
    name: "temperature",
    extra: { temperature: 0.4 },
    responses: ["temperature"],
    chat: [],
  },
  {
    name: "top p",
    extra: { top_p: 0.8 },
    responses: [],
    chat: [],
  },
  {
    name: "top k",
    extra: { top_k: 20 },
    responses: ["top_k"],
    chat: ["top_k"],
  },
  {
    name: "service tier",
    extra: { service_tier: "standard_only" },
    responses: ["service_tier"],
    chat: ["service_tier"],
  },
  {
    name: "output format",
    extra: { output_config: { format: { type: "json_object" } } },
    responses: [],
    chat: [],
  },
  {
    name: "output effort",
    extra: { output_config: { effort: "high" } },
    responses: [],
    chat: [],
  },
  {
    name: "output task budget",
    extra: {
      output_config: {
        task_budget: { type: "tokens", total: 100, remaining: 80 },
      },
    },
    responses: [],
    chat: ["output_config.task_budget"],
  },
  {
    name: "unknown output config extension",
    extra: { output_config: { future_output_control: true } },
    responses: ["output_config.future_output_control"],
    chat: ["output_config.future_output_control"],
  },
  {
    name: "parallel tool control",
    extra: {
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    },
    responses: ["tool_choice.disable_parallel_tool_use"],
    chat: ["tool_choice.disable_parallel_tool_use"],
  },
  {
    name: "unknown root extension",
    extra: { future_native_field: { enabled: true } },
    responses: ["request_extension:future_native_field"],
    chat: ["request_extension:future_native_field"],
  },
])(
  "maps or blocks top-level Messages $name exactly",
  ({ extra, responses, chat }) => {
    const payload = {
      model: "route-model",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      ...extra,
    } as AnthropicMessagesPayload

    expect(checkMessagesToResponsesTranslation(payload).blockers).toEqual([
      ...responses,
    ])
    expect(checkMessagesToChatTranslation(payload).blockers).toEqual([...chat])
  },
)

test.each([
  {
    name: "text cache control",
    block: {
      type: "text",
      text: "hello",
      cache_control: { type: "ephemeral" },
    },
    blocker: "content_cache_control",
  },
  {
    name: "text extension",
    block: { type: "text", text: "hello", future_text_field: true },
    blocker: "content_extension:future_text_field",
  },
  {
    name: "message extension",
    messageExtra: { future_message_field: true },
    block: { type: "text", text: "hello" },
    blocker: "message_extension:future_message_field",
  },
  {
    name: "tool use extension",
    role: "assistant",
    block: {
      type: "tool_use",
      id: "toolu_1",
      name: "lookup",
      input: {},
      future_tool_use_field: true,
    },
    blocker: "content_extension:future_tool_use_field",
  },
  {
    name: "tool result extension",
    block: {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "done",
      future_tool_result_field: true,
    },
    blocker: "content_extension:future_tool_result_field",
  },
])(
  "fails closed for nested Messages $name",
  ({ blocker, block, messageExtra, role = "user" }) => {
    const payload = {
      model: "route-model",
      max_tokens: 64,
      messages: [{ role, content: [block], ...messageExtra }],
    } as unknown as AnthropicMessagesPayload

    expect(checkMessagesToResponsesTranslation(payload).blockers).toContain(
      blocker,
    )
    expect(checkMessagesToChatTranslation(payload).blockers).toContain(blocker)
  },
)

test("blocks thinking that the target converter cannot round-trip", () => {
  const unsigned = {
    model: "route-model",
    max_tokens: 64,
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "unsigned" }],
      },
    ],
  } as AnthropicMessagesPayload
  const responsesSigned = {
    ...unsigned,
    messages: [
      {
        role: "assistant" as const,
        content: [
          {
            type: "thinking" as const,
            thinking: "responses",
            signature: "encrypted@rs_1",
          },
        ],
      },
    ],
  }
  const chatSigned = {
    ...unsigned,
    messages: [
      {
        role: "assistant" as const,
        content: [
          {
            type: "thinking" as const,
            thinking: "chat",
            signature: "native-signature",
          },
        ],
      },
    ],
  }

  expect(checkMessagesToResponsesTranslation(unsigned).blockers).toEqual([
    "thinking_signature",
  ])
  expect(checkMessagesToChatTranslation(unsigned).blockers).toEqual([])
  expect(checkMessagesToResponsesTranslation(responsesSigned).blockers).toEqual(
    [],
  )
  expect(checkMessagesToChatTranslation(responsesSigned).blockers).toEqual([
    "thinking_signature",
  ])
  expect(checkMessagesToResponsesTranslation(chatSigned).blockers).toEqual([
    "thinking_signature",
  ])
  expect(checkMessagesToChatTranslation(chatSigned).blockers).toEqual([])
})

test("routes to the remaining endpoint only when its full conversion is lossless", () => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    stop_sequences: ["END"],
  } as AnthropicMessagesPayload
  const selectedModel = createModel({
    supported_endpoints: ["/responses", "/chat/completions"],
  })

  expect(selectMessagesUpstreamEndpoint({ payload, selectedModel })).toEqual({
    reason: "endpoint_unavailable",
    source: "messages",
    target: "/chat/completions",
    translated: true,
  })
})

test.each([
  {
    name: "plain document",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
      title: "report.pdf",
    },
    responses: [],
    chat: ["document"],
  },
  {
    name: "document context",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
      context: "Read section two first.",
    },
    responses: ["document.context"],
    chat: ["document"],
  },
  {
    name: "document citations",
    document: {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
      citations: { enabled: true },
    },
    responses: ["document.citations"],
    chat: ["document"],
  },
])("maps or blocks $name without loss", ({ document, responses, chat }) => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [{ role: "user", content: [document] }],
  } as unknown as AnthropicMessagesPayload

  expect(checkMessagesToResponsesTranslation(payload).blockers).toEqual([
    ...responses,
  ])
  expect(checkMessagesToChatTranslation(payload).blockers).toEqual([...chat])
})

test.each([true, false])(
  "preserves or blocks meaningful tool_result.is_error=%s",
  (isError) => {
    const payload = {
      model: "route-model",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "result",
              is_error: isError,
            },
          ],
        },
      ],
    } as AnthropicMessagesPayload

    expect(checkMessagesToResponsesTranslation(payload).blockers).toEqual([])
    expect(checkMessagesToChatTranslation(payload).blockers).toEqual([
      "tool_result.is_error",
    ])
  },
)

test("routes document context away from lossy translated endpoints", () => {
  const payload = {
    model: "route-model",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0=",
            },
            context: "Preserve this context.",
          },
        ],
      },
    ],
  } as AnthropicMessagesPayload
  const selectedModel = createModel({
    supported_endpoints: ["/responses", "/chat/completions"],
  })

  expect(selectMessagesUpstreamEndpoint({ payload, selectedModel })).toEqual({
    blockers: ["document.context", "document"],
    code: "endpoint_translation_unsupported",
    source: "messages",
  })
})

test.each([
  {
    name: "Responses",
    endpoints: ["/responses"],
    extra: { future_native_field: { enabled: true } },
    param: "request_extension:future_native_field",
  },
  {
    name: "Chat",
    endpoints: ["/chat/completions"],
    extra: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello", future_text_field: true }],
        },
      ],
    },
    param: "content_extension:future_text_field",
  },
])(
  "rejects unknown native extensions before translated $name dispatch",
  async ({ endpoints, extra, param }) => {
    installModel({ supported_endpoints: [...endpoints] })

    const response = await postMessages(extra)

    expect(response.status).toBe(400)
    expect(await response.json()).toHaveProperty("error.param", param)
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

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
