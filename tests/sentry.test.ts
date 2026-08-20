import * as Sentry from "@sentry/bun"
import { beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import {
  getAllModelSettings,
  modelSupportsAssistantPrefill,
  setModelSettingsForTest,
} from "../src/lib/model-settings"
import { runWithRoutingAffinity } from "../src/lib/routing-affinity"
import {
  applySentryRequestDiagnosticsToScope,
  createSentryInitOptions,
  createSentryChatSpanOptions,
  createSentryInvokeAgentSpanOptions,
  createSentryToolSpanOptions,
  getSentryConversationIdFromHeaders,
  getSentryConversationIdFromPayload,
  getSentryModelName,
  pseudonymizeSentryConversationId,
  scrubStatsigClientKeyData,
  setSentryConversationIdFromRequest,
} from "../src/lib/sentry"

const originalSentryAiRecordInputs = process.env.SENTRY_AI_RECORD_INPUTS

beforeEach(() => {
  setModelSettingsForTest([])
  if (originalSentryAiRecordInputs === undefined) {
    delete process.env.SENTRY_AI_RECORD_INPUTS
  } else {
    process.env.SENTRY_AI_RECORD_INPUTS = originalSentryAiRecordInputs
  }
})

test("uses configured Sentry model name without reasoning settings", async () => {
  setModelSettingsForTest([
    {
      model: "opus-4.7-internal",
      sentryModelName: "opus-4.7-haha",
    },
  ])

  expect(getSentryModelName("opus-4.7-internal")).toBe("opus-4.7-haha")
  expect(getSentryModelName("opus-4.7-internal:high")).toBe("opus-4.7-haha")

  const settings = await getAllModelSettings()
  expect(settings).toEqual([
    {
      model: "opus-4.7-internal",
      sentryModelName: "opus-4.7-haha",
    },
  ])
})

test("persists unsupported request parameter model settings", async () => {
  setModelSettingsForTest([
    {
      model: "no-temperature-model",
      unsupportedRequestParameters: ["temperature", "top_p", "invalid"],
    },
  ])

  const settings = await getAllModelSettings()
  expect(settings).toEqual([
    {
      model: "no-temperature-model",
      unsupportedRequestParameters: ["temperature", "top_p"],
    },
  ])
})

test("persists assistant prefill support model settings", async () => {
  setModelSettingsForTest([
    {
      model: "claude-no-prefill",
      supportsAssistantPrefill: false,
    },
    {
      model: "claude-default-prefill",
      supportsAssistantPrefill: "false",
    },
  ])

  const settings = await getAllModelSettings()
  expect(settings).toEqual([
    {
      model: "claude-no-prefill",
      supportsAssistantPrefill: false,
    },
  ])
  expect(modelSupportsAssistantPrefill("claude-no-prefill")).toBe(false)
  expect(modelSupportsAssistantPrefill("claude-default-prefill")).toBe(true)
  expect(modelSupportsAssistantPrefill("unset-model")).toBe(true)
})

test("defaults known no-prefill models while allowing settings override", () => {
  setModelSettingsForTest([])
  expect(modelSupportsAssistantPrefill("claude-opus-4.8")).toBe(false)

  setModelSettingsForTest([
    {
      model: "claude-opus-4.8",
      supportsAssistantPrefill: true,
    },
  ])
  expect(modelSupportsAssistantPrefill("claude-opus-4.8")).toBe(true)
})

test("falls back to built-in Sentry model names", () => {
  expect(getSentryModelName("claude-opus-4.6")).toBe("claude-opus-4-6")
  expect(getSentryModelName("claude-opus-4.6:high")).toBe("claude-opus-4-6")
})

test("creates current Sentry AI agent span attributes without request content", () => {
  process.env.SENTRY_AI_RECORD_INPUTS = "true"

  expect(
    createSentryInvokeAgentSpanOptions("claude-opus-4.6", "conv_abc"),
  ).toEqual({
    op: "gen_ai.invoke_agent",
    name: "invoke_agent copilot-proxy",
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "copilot-proxy",
      "gen_ai.request.model": "claude-opus-4-6",
      "gen_ai.conversation.id": "conv_abc",
    },
  })

  expect(
    createSentryChatSpanOptions({
      inputMessages: [{ role: "user", content: "quota" }],
      model: "claude-opus-4.6",
      streaming: true,
    }),
  ).toEqual({
    op: "gen_ai.chat",
    name: "chat claude-opus-4-6",
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": "copilot-proxy",
      "gen_ai.request.model": "claude-opus-4-6",
      "gen_ai.response.model": "claude-opus-4-6",
      "gen_ai.response.streaming": true,
    },
  })

  expect(
    createSentryToolSpanOptions({
      toolArguments: { query: "quota" },
      toolName: "web_search",
      toolResult: "result",
    }),
  ).toEqual({
    op: "gen_ai.execute_tool",
    name: "execute_tool web_search",
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "web_search",
      "gen_ai.tool.type": "function",
    },
  })
})

test("omits nested private markers from every ordinary Sentry helper", () => {
  const privateMarkers = [
    "sentry-prompt-private",
    "sentry-encrypted-private",
    "sentry-cache-private",
    "sentry-tool-private",
    "sentry-result-private",
    "sentry-url-private",
  ]
  const chat = createSentryChatSpanOptions({
    inputMessages: [
      {
        content: privateMarkers[0],
        encrypted_content: privateMarkers[1],
        prompt_cache_key: privateMarkers[2],
      },
    ],
    model: "gpt-current",
  })
  const tool = createSentryToolSpanOptions({
    toolArguments: {
      name: privateMarkers[3],
      url: `https://example.invalid/${privateMarkers[5]}`,
    },
    toolName: "lookup",
    toolResult: privateMarkers[4],
  })
  const output = JSON.stringify({ chat, tool })

  for (const marker of privateMarkers) expect(output).not.toContain(marker)
})

test("omits Sentry AI content attributes when recording is disabled", () => {
  process.env.SENTRY_AI_RECORD_INPUTS = "false"

  expect(
    createSentryChatSpanOptions({
      inputMessages: [{ role: "user", content: "quota" }],
      model: "claude-opus-4.6",
    }).attributes,
  ).not.toHaveProperty("gen_ai.input.messages")

  expect(
    createSentryToolSpanOptions({
      toolArguments: { query: "quota" },
      toolName: "web_search",
      toolResult: "result",
    }).attributes,
  ).not.toHaveProperty("gen_ai.tool.call.arguments")
})

test("extracts Sentry conversation ID from Responses payload", () => {
  expect(
    getSentryConversationIdFromPayload({
      conversation_id: "conv_abc",
      model: "gpt-5.3-codex",
    }),
  ).toBe("conv_abc")
})

test("extracts Sentry conversation ID from metadata", () => {
  expect(
    getSentryConversationIdFromPayload({
      metadata: {
        session_id: "session_abc",
      },
      model: "claude-sonnet-4.6",
    }),
  ).toBe("session_abc")
})

test("extracts Sentry conversation ID from Claude Code JSON user metadata", () => {
  expect(
    getSentryConversationIdFromPayload({
      metadata: {
        user_id: JSON.stringify({
          account_uuid: "account_abc",
          session_id: "session_json",
        }),
      },
      model: "claude-sonnet-4.6",
    }),
  ).toBe("session_json")
})

test("extracts Sentry conversation ID from legacy Claude Code user metadata", () => {
  expect(
    getSentryConversationIdFromPayload({
      metadata: {
        user_id: "user_abc_account_xyz_session_session_legacy",
      },
      model: "claude-sonnet-4.6",
    }),
  ).toBe("session_legacy")
})

test("extracts Sentry conversation ID from supported headers", () => {
  const headers = new Headers({
    "x-session-id": "session_header",
  })

  expect(getSentryConversationIdFromHeaders(headers)).toBe("session_header")
})

test("pseudonymizes Sentry conversation IDs stably without retaining raw input", () => {
  const raw = "routing-session-private-value"
  const first = pseudonymizeSentryConversationId(raw)
  const second = pseudonymizeSentryConversationId(raw)
  const different = pseudonymizeSentryConversationId("different-session")

  expect(first).toBe(second)
  expect(first).not.toBe(different)
  expect(first).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(first).not.toContain(raw)
})

test("sets and returns only a pseudonymous Sentry conversation ID", async () => {
  const raw = "payload-session-private-value"
  const setConversationId = spyOn(
    Sentry,
    "setConversationId",
  ).mockImplementation(() => undefined)
  const app = new Hono()
  let returned: string | undefined
  app.post("/", (c) => {
    returned = setSentryConversationIdFromRequest(c, {
      metadata: { session_id: raw },
    })
    return c.text("ok")
  })

  await app.request("/", { method: "POST" })

  expect(returned).toBe(pseudonymizeSentryConversationId(raw))
  expect(returned).not.toContain(raw)
  expect(setConversationId).toHaveBeenCalledWith(returned)
  setConversationId.mockRestore()
})

test("does not emit active routing affinity to Sentry", async () => {
  const affinityKey = "winning-header-affinity-private-value"
  const losingMetadataKey = "losing-metadata-affinity-private-value"
  const setConversationId = spyOn(
    Sentry,
    "setConversationId",
  ).mockImplementation(() => undefined)
  const app = new Hono()
  let returned: string | undefined
  app.post("/", (c) => {
    returned = runWithRoutingAffinity(
      { key: affinityKey, source: "copilot_session" },
      () =>
        setSentryConversationIdFromRequest(c, {
          metadata: {
            user_id: JSON.stringify({ session_id: losingMetadataKey }),
          },
        }),
    )
    return c.text("ok")
  })

  await app.request("/", { method: "POST" })

  expect(returned).toBeUndefined()
  expect(setConversationId).not.toHaveBeenCalled()
  setConversationId.mockRestore()
})

test("scrubs Statsig client keys from full URLs and breadcrumb data", () => {
  const event = {
    request: {
      url: "https://ab.chatgpt.com/v1/initialize?k=client-secret&foo=bar",
    },
    breadcrumbs: [
      {
        data: {
          url: "https://ab.chatgpt.com/v1/initialize?k=breadcrumb-secret",
        },
      },
      {
        data: {
          url: "https://example.com/?k=keep-me&foo=bar",
        },
      },
    ],
  }

  scrubStatsigClientKeyData(event)

  expect(event.request.url).toBe(
    "https://ab.chatgpt.com/v1/initialize?k=[Filtered]&foo=bar",
  )
  expect(event.breadcrumbs[0]?.data.url).toBe(
    "https://ab.chatgpt.com/v1/initialize?k=[Filtered]",
  )
  expect(event.breadcrumbs[1]?.data.url).toBe(
    "https://example.com/?k=keep-me&foo=bar",
  )
})

test("scrubs Statsig span data within local context without leaking to siblings", () => {
  const payload = {
    span: {
      description:
        "POST https://ab.chatgpt.com:443/v1/initialize?k=span-secret#fragment",
      data: {
        server: { address: "ab.chatgpt.com:443" },
        url: { query: "k=query-secret&foo=bar" },
      },
    },
    unrelated: {
      url: {
        query: "k=keep-me&foo=bar",
      },
    },
  }

  scrubStatsigClientKeyData(payload)

  expect(payload.span.description).toBe(
    "POST https://ab.chatgpt.com:443/v1/initialize?k=[Filtered]#fragment",
  )
  expect(payload.span.data.url.query).toBe("k=[Filtered]&foo=bar")
  expect(payload.unrelated.url.query).toBe("k=keep-me&foo=bar")
})

test("does not treat lookalike hosts as Statsig context", () => {
  const payload = {
    deceptiveUrl: {
      description:
        "POST https://ab.chatgpt.com.evil/v1/initialize?k=deceptive-secret",
      data: {
        url: { query: "k=deceptive-query&foo=bar" },
      },
    },
    prefixedHost: {
      description:
        "POST https://notab.chatgpt.com/v1/initialize?k=prefixed-secret",
      data: {
        url: { query: "k=prefixed-query&foo=bar" },
      },
    },
    lookalikeServer: {
      data: {
        server: { address: "ab.chatgpt.com.evil:443" },
        url: { query: "k=server-query&foo=bar" },
      },
    },
  }

  scrubStatsigClientKeyData(payload)

  expect(payload.deceptiveUrl.description).toBe(
    "POST https://ab.chatgpt.com.evil/v1/initialize?k=deceptive-secret",
  )
  expect(payload.deceptiveUrl.data.url.query).toBe("k=deceptive-query&foo=bar")
  expect(payload.prefixedHost.description).toBe(
    "POST https://notab.chatgpt.com/v1/initialize?k=prefixed-secret",
  )
  expect(payload.prefixedHost.data.url.query).toBe("k=prefixed-query&foo=bar")
  expect(payload.lookalikeServer.data.url.query).toBe("k=server-query&foo=bar")
})

test("scrubs inherited Statsig context in arrays and handles cycles", () => {
  const payload: {
    items: Array<{ request: { url: string } } | { url: { query: string } }>
    self?: unknown
    server: { address: string }
  } = {
    server: { address: "ab.chatgpt.com" },
    items: [
      { url: { query: "k=array-secret&foo=bar" } },
      {
        request: {
          url: "https://ab.chatgpt.com/v1/initialize?k=nested-secret",
        },
      },
    ],
  }
  payload.self = payload

  scrubStatsigClientKeyData(payload)

  expect(payload.items[0]).toEqual({
    url: { query: "k=[Filtered]&foo=bar" },
  })
  expect(payload.items[1]).toEqual({
    request: {
      url: "https://ab.chatgpt.com/v1/initialize?k=[Filtered]",
    },
  })
  expect(payload.self).toBe(payload)
})

test("registers Statsig redaction hooks for all Sentry send callbacks", () => {
  const options = createSentryInitOptions(
    "https://public@example.ingest.sentry.io/1",
  )

  expect(typeof options.beforeSend).toBe("function")
  expect(typeof options.beforeSendTransaction).toBe("function")
  expect(typeof options.beforeSendSpan).toBe("function")
  expect(typeof options.beforeSendLog).toBe("function")

  const beforeSendEvent = {
    request: {
      url: "https://ab.chatgpt.com/v1/initialize?k=event-secret&foo=bar",
    },
  }
  const beforeSendTransactionEvent = {
    contexts: { trace: { trace_id: "abc", span_id: "def" } },
    request: {
      url: "https://ab.chatgpt.com/v1/initialize?k=transaction-secret",
    },
  }
  const beforeSendSpanPayload = {
    description: "POST https://ab.chatgpt.com:8443/v1/initialize?k=span-secret",
    data: {
      url: { query: "k=span-query&foo=bar" },
    },
  }
  const beforeSendLogPayload = {
    attributes: {
      request: {
        url: "https://ab.chatgpt.com/v1/initialize?k=log-secret",
      },
    },
  }

  const beforeSend = options.beforeSend as
    | ((event: typeof beforeSendEvent) => typeof beforeSendEvent | null)
    | undefined
  const beforeSendTransaction = options.beforeSendTransaction as
    | ((
        event: typeof beforeSendTransactionEvent,
      ) => typeof beforeSendTransactionEvent | null)
    | undefined
  const beforeSendSpan = options.beforeSendSpan as
    | ((
        span: typeof beforeSendSpanPayload,
      ) => typeof beforeSendSpanPayload | null)
    | undefined
  const beforeSendLog = options.beforeSendLog as
    | ((log: typeof beforeSendLogPayload) => typeof beforeSendLogPayload | null)
    | undefined

  expect(beforeSend?.(beforeSendEvent)).toBe(beforeSendEvent)
  expect(beforeSendEvent.request.url).toBe(
    "https://ab.chatgpt.com/v1/initialize?k=[Filtered]&foo=bar",
  )

  expect(beforeSendTransaction?.(beforeSendTransactionEvent)).toBe(
    beforeSendTransactionEvent,
  )
  expect(beforeSendTransactionEvent.request.url).toBe(
    "https://ab.chatgpt.com/v1/initialize?k=[Filtered]",
  )

  expect(beforeSendSpan?.(beforeSendSpanPayload)).toBe(beforeSendSpanPayload)
  expect(beforeSendSpanPayload.description).toBe(
    "POST https://ab.chatgpt.com:8443/v1/initialize?k=[Filtered]",
  )
  expect(beforeSendSpanPayload.data.url.query).toBe("k=[Filtered]&foo=bar")

  expect(beforeSendLog?.(beforeSendLogPayload)).toBe(beforeSendLogPayload)
  expect(beforeSendLogPayload.attributes.request.url).toBe(
    "https://ab.chatgpt.com/v1/initialize?k=[Filtered]",
  )
})

test("scrubs affinity headers from every Sentry send callback", () => {
  const options = createSentryInitOptions(
    "https://public@example.ingest.sentry.io/1",
  )
  const rawIds = [
    "sentry-conversation-private",
    "conversation-private",
    "x-thread-private",
    "x-session-private",
    "claude-sentry-private",
    "copilot-sentry-private",
    "session-sentry-private",
    "thread-sentry-private",
  ]
  const headers = {
    "X-SENTRY-CONVERSATION-ID": rawIds[0],
    "x-Conversation-Id": rawIds[1],
    "X-Thread-Id": rawIds[2],
    "x-SESSION-id": rawIds[3],
    "X-Claude-Code-Session-Id": rawIds[4],
    "x-CLIENT-session-ID": rawIds[5],
    "Session-Id": rawIds[6],
    "THREAD-ID": rawIds[7],
    "x-harmless": "visible",
  }
  const event = { request: { headers: { ...headers } } }
  const transaction = { request: { headers: { ...headers } } }
  const span = { data: { nested: { request: { headers: { ...headers } } } } }
  const log = { attributes: { request: { headers: { ...headers } } } }

  const beforeSend = options.beforeSend as
    | ((value: typeof event) => typeof event | null)
    | undefined
  const beforeSendTransaction = options.beforeSendTransaction as
    | ((value: typeof transaction) => typeof transaction | null)
    | undefined
  const beforeSendSpan = options.beforeSendSpan as
    | ((value: typeof span) => typeof span | null)
    | undefined
  const beforeSendLog = options.beforeSendLog as
    | ((value: typeof log) => typeof log | null)
    | undefined

  beforeSend?.(event)
  beforeSendTransaction?.(transaction)
  beforeSendSpan?.(span)
  beforeSendLog?.(log)

  const serialized = JSON.stringify({ event, transaction, span, log })
  for (const rawId of rawIds) expect(serialized).not.toContain(rawId)
  expect(serialized).toContain("[Filtered]")
  expect(serialized).toContain("visible")
})

test.each(["/v1beta/models", "/v1/models", "/models"])(
  "templates Google model/action data in Sentry events for %s",
  (prefix) => {
    const model = "sentry-private-model"
    const action = "sentry-private-action"
    const secrets = [
      "query-key-secret",
      "query-api-key-secret",
      "query-access-token-secret",
      "query-token-secret",
      "query-password-secret",
      "query-credential-secret",
    ]
    const path = `${prefix}/${model}:${action}/?key=${secrets[0]}&api_key=${secrets[1]}&alt=sse`
    const url = `https://gateway.example${prefix}/${model}:${action}/?access_token=${secrets[2]}&visible=1`
    const options = createSentryInitOptions(
      "https://public@example.ingest.sentry.io/1",
    )
    const makeEvent = () => ({
      type: "transaction" as const,
      transaction: `POST ${path}`,
      request: { method: "POST", url },
      extra: {
        model,
        requestedModel: model,
        metadata: { action, model, safe: "visible" },
      },
      contexts: {
        response: { status_code: 404 },
        trace: {
          trace_id: "a".repeat(32),
          span_id: "b".repeat(16),
          data: {
            "http.request.method": "POST",
            "http.route": path,
            "url.full": url,
            "url.path": path,
            "url.query": `token=${secrets[3]}&alt=sse`,
          },
        },
      },
      spans: [
        {
          trace_id: "a".repeat(32),
          span_id: "c".repeat(16),
          start_timestamp: 1,
          description: `POST ${prefix}/${model}:${action}/?password=${secrets[4]}&alt=sse`,
          data: {
            "http.request.method": "POST",
            "http.response.status_code": 404,
            "http.route": path,
            "url.full": url,
            "url.path": path,
            nested: {
              request: {
                url: `${prefix}/${model}:${action}/?credential=${secrets[5]}&alt=sse`,
              },
            },
          },
        },
      ],
    })
    const beforeSend = options.beforeSend as
      | ((event: ReturnType<typeof makeEvent>) => ReturnType<typeof makeEvent>)
      | undefined
    const beforeSendTransaction = options.beforeSendTransaction as
      | ((event: ReturnType<typeof makeEvent>) => ReturnType<typeof makeEvent>)
      | undefined

    for (const hook of [beforeSend, beforeSendTransaction]) {
      const event = makeEvent()
      expect(hook?.(event)).toBe(event)
      const serialized = JSON.stringify(event)

      expect(serialized).not.toContain(model)
      expect(serialized).not.toContain(action)
      for (const secret of secrets) expect(serialized).not.toContain(secret)
      expect(serialized).toContain(`${prefix}/:modelAction`)
      expect(serialized).toContain("POST")
      expect(serialized).toContain("404")
      expect(serialized).toContain("alt=sse")
      expect(serialized).toContain("visible")
    }
  },
)

test.each([
  { method: "GET", path: "/v1/models/model-discovery-id" },
  { method: "POST", path: "/models/session" },
  { method: "POST", path: "/models/session/intent" },
] as const)(
  "does not relabel non-Google Sentry request diagnostics for $method $path",
  ({ method, path }) => {
    const scope = new Sentry.Scope()

    applySentryRequestDiagnosticsToScope(scope, {
      method,
      path,
      url: `https://gateway.example${path}`,
    })

    expect(scope.getScopeData().transactionName).toBeUndefined()
    expect(
      scope.getScopeData().sdkProcessingMetadata.normalizedRequest,
    ).toBeUndefined()
  },
)

test.each([
  { method: "GET", path: "/v1/models/model-discovery-id" },
  { method: "POST", path: "/models/session" },
] as const)(
  "preserves non-Google Sentry event routes for $method $path",
  ({ method, path }) => {
    const options = createSentryInitOptions(
      "https://public@example.ingest.sentry.io/1",
    )
    const event = {
      type: "transaction" as const,
      transaction: `${method} ${path}`,
      request: { method, url: `https://gateway.example${path}` },
      contexts: {
        trace: {
          data: { "http.request.method": method, "http.route": path },
        },
      },
    }
    const beforeSendTransaction = options.beforeSendTransaction as
      | ((value: typeof event) => typeof event | null)
      | undefined

    beforeSendTransaction?.(event)

    expect(event.transaction).toBe(`${method} ${path}`)
    expect(event.request.url).toBe(`https://gateway.example${path}`)
    expect(event.contexts.trace.data["http.route"]).toBe(path)
  },
)

test.each(["/v1beta/models", "/v1/models", "/models"])(
  "templates Google request diagnostics stored on a Sentry scope for %s",
  (prefix) => {
    const scope = new Sentry.Scope()
    const model = "scope-private-model"
    const action = "scope-private-action"
    const path = `${prefix}/${model}:${action}/?key=scope-query-secret&alt=sse`
    const url = `https://gateway.example${prefix}/${model}:${action}/?access_token=scope-access-secret&alt=sse`

    applySentryRequestDiagnosticsToScope(scope, {
      method: "POST",
      path,
      url,
    })

    const scopeData = scope.getScopeData()
    const serialized = JSON.stringify(scopeData)
    expect(scopeData.transactionName).toBe(`POST ${prefix}/:modelAction`)
    expect(scopeData.sdkProcessingMetadata.normalizedRequest).toMatchObject({
      method: "POST",
      url: `https://gateway.example${prefix}/:modelAction?access_token=[REDACTED]&alt=sse`,
    })
    expect(serialized).not.toContain(model)
    expect(serialized).not.toContain(action)
    expect(serialized).not.toContain("scope-query-secret")
    expect(serialized).not.toContain("scope-access-secret")
    expect(serialized).toContain("alt=sse")
  },
)
