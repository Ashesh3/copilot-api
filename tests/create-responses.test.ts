/* eslint-disable max-lines -- integration coverage shares one server fixture */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

import { HTTPError } from "../src/lib/error"
import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "../src/lib/routing-affinity"
import {
  getRoutingTelemetrySnapshot,
  resetRoutingTelemetryForTest,
} from "../src/lib/routing-telemetry"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { normalizeResponsesReasoning } from "../src/routes/responses/handler"
import { server } from "../src/server"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "../src/services/copilot/compaction-payload"
import {
  createResponses,
  sanitizeResponsesStreamEvent,
  type ResponsesPayload,
} from "../src/services/copilot/create-responses"

test("sanitizes an unknown terminal shape through the direct event helper", () => {
  const privateMarker = "direct-terminal-private-marker"
  const sanitized = sanitizeResponsesStreamEvent({
    event: "response.failed",
    data: JSON.stringify({
      type: "response.output_text.delta",
      sequence_number: 9,
      response: {
        id: "resp_direct",
        object: "response",
        status: "failed",
        message: privateMarker,
        metadata: { private: privateMarker },
        error: { message: privateMarker, code: "custom_private_code" },
      },
      private: privateMarker,
    }),
  })

  expect(JSON.parse(sanitized.data ?? "{}") as unknown).toEqual({
    type: "response.failed",
    sequence_number: 9,
    response: {
      id: "resp_direct",
      object: "response",
      status: "failed",
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: null,
        status: 502,
      },
      incomplete_details: null,
    },
  })
  expect(sanitized.data).not.toContain(privateMarker)
})

test("leaves a well-formed completed terminal event unchanged", () => {
  const data = JSON.stringify({
    type: "response.completed",
    sequence_number: 3,
    response: {
      id: "resp_completed",
      object: "response",
      status: "completed",
      output: [],
      output_text: "done",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      error: null,
      incomplete_details: null,
    },
  })
  const event = { event: "response.completed", data }

  expect(sanitizeResponsesStreamEvent(event)).toEqual(event)
})

const originalFetch = globalThis.fetch
const originalModels = state.models
const originalIsMultiToken = state.isMultiToken
const addedAccountIds = [2201, 2202, 2211, 2212]
let lastRequestBody: Record<string, unknown> | undefined
let requestBodies: Array<Record<string, unknown>>
let queuedResponses: Array<Response>
let capturedAffinity: RoutingAffinity | undefined
const capturedAuthorization: Array<string | undefined> = []

const responsesCapableModels = {
  object: "list" as const,
  data: [
    {
      id: "gpt-4o",
      name: "gpt-4o",
      object: "model" as const,
      version: "test",
      vendor: "openai",
      preview: false,
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt-4o",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

function createSuccessResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "gpt-4o",
      output: [],
      output_text: "",
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )
}

function parseRequestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    return {}
  }

  return JSON.parse(init.body) as Record<string, unknown>
}

const fetchMock = mock((_url: string, init?: RequestInit) => {
  capturedAffinity = getRoutingAffinity()
  capturedAuthorization.push(
    new Headers(init?.headers).get("authorization") ?? undefined,
  )
  lastRequestBody = parseRequestBody(init)
  requestBodies.push(lastRequestBody)

  return queuedResponses.shift() ?? createSuccessResponse()
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  for (const accountId of addedAccountIds)
    tokenPool.removeAccountForTest(accountId)
  state.models = originalModels
  state.isMultiToken = originalIsMultiToken
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  lastRequestBody = undefined
  requestBodies = []
  queuedResponses = []
  capturedAffinity = undefined
  capturedAuthorization.length = 0
  state.models = originalModels
  state.isMultiToken = originalIsMultiToken
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  resetRoutingTelemetryForTest()
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test("routes repeated Responses metadata sessions to stable accounts", async () => {
  const modelId = "responses-metadata-routing-model"
  const model = {
    ...responsesCapableModels.data[0],
    id: modelId,
    name: modelId,
  }
  state.models = { object: "list", data: [model] }
  for (const [id, token] of [
    [2201, "responses-token-one"],
    [2202, "responses-token-two"],
  ] as const) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = token
    account.healthy = true
    account.models = new Set([modelId])
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true
  const keys: Array<string> = []
  for (let index = 0; index < 100 && keys.length < 2; index++) {
    const key = `responses-session-${index}`
    const accountId = tokenPool.getAccountForModelBySession(modelId, key)?.id
    if (
      accountId !== undefined
      && !keys.some(
        (existing) =>
          tokenPool.getAccountForModelBySession(modelId, existing)?.id
          === accountId,
      )
    ) {
      keys.push(key)
    }
  }
  expect(keys).toHaveLength(2)
  const request = (key: string) =>
    server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        input: "hello",
        client_metadata: { session_id: key },
      }),
    })

  await request(keys[0] ?? "")
  await request(keys[0] ?? "")
  await request(keys[1] ?? "")
  await request(keys[1] ?? "")

  const expected = keys.map(
    (key) =>
      `Bearer ${tokenPool.getAccountForModelBySession(modelId, key)?.copilotToken}`,
  )
  expect(capturedAuthorization).toEqual([
    expected[0],
    expected[0],
    expected[1],
    expected[1],
  ])
  expect(expected[0]).not.toBe(expected[1])
  const usage = getRoutingTelemetrySnapshot({
    accounts: tokenPool.getAllAccounts().map((account) => ({
      accountType: account.accountType,
      healthy: account.healthy,
      id: account.id,
    })),
    multiToken: true,
    window: "1h",
  })
  expect(usage.selectionModes.sticky).toBe(4)
})

test("returns a structured conflict when a bound Responses account still rejects the session", async () => {
  const modelId = "responses-session-account-rejected"
  const model = {
    ...responsesCapableModels.data[0],
    id: modelId,
    name: modelId,
  }
  state.models = { data: [model], object: "list" }
  for (const [id, token] of [
    [2211, "responses-bound-token"],
    [2212, "responses-alternate-token"],
  ] as const) {
    const account = tokenPool.addAccount(`github-${id}`, "individual", id)
    account.copilotToken = token
    account.healthy = true
    account.models = new Set([modelId])
    account.modelsData = [model]
  }
  tokenPool.rebuildModelIndex()
  state.isMultiToken = true
  const sessionId = Array.from(
    { length: 1000 },
    (_, index) => `responses-rejected-session-${index}`,
  ).find(
    (candidate) =>
      tokenPool.getAccountForModelBySession(modelId, candidate)?.id === 2211,
  )
  if (!sessionId) throw new TypeError("Expected affinity key for account 2211")
  queuedResponses.push(
    new Response("Unauthorized", { status: 401 }),
    Response.json({
      expires_at: 1_900_000_000,
      refresh_in: 1800,
      token: "responses-refreshed-bound-token",
    }),
    Response.json({ data: [model], object: "list" }),
    new Response("Unauthorized", { status: 401 }),
  )

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_metadata: { session_id: sessionId },
      input: "continue the conversation",
      model: modelId,
    }),
  })
  const body = (await response.json()) as Record<string, unknown>

  expect(response.status).toBe(409)
  expect(body).toMatchObject({
    error: {
      account_id: 2211,
      code: "session_account_rejected",
      type: "session_affinity_error",
    },
  })
  expect(JSON.stringify(body)).not.toContain(sessionId)
  expect(capturedAuthorization).not.toContain(
    "Bearer responses-alternate-token",
  )
})

test("installs Responses client metadata affinity before provider dispatch", async () => {
  state.models = responsesCapableModels
  for (const clientMetadata of [
    { session_id: "responses-object-session" },
    JSON.stringify({ session_id: "responses-string-session" }),
  ]) {
    const expectedKey =
      typeof clientMetadata === "string" ?
        "responses-string-session"
      : "responses-object-session"
    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "hello",
        client_metadata: clientMetadata,
      }),
    })
    expect(response.status).toBe(200)
    expect(capturedAffinity).toEqual({
      key: expectedKey,
      source: "codex_metadata",
    })
  }
})

test("keeps Responses header affinity over metadata and ignores malformed metadata", async () => {
  state.models = responsesCapableModels
  await server.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-session-id": "header-session",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      input: "hello",
      client_metadata: { session_id: "body-session" },
    }),
  })
  expect(capturedAffinity).toEqual({
    key: "header-session",
    source: "copilot_session",
  })

  await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      input: "hello",
      client_metadata: "not json",
    }),
  })
  expect(capturedAffinity).toBeUndefined()
})

test("rejects previous_response_id for HTTP Responses API requests", async () => {
  const error = await createResponses(
    { model: "gpt-4o", input: "Hello", previous_response_id: "resp_previous" },
    { vision: false, initiator: "user" },
  ).catch((caught: unknown) => caught)
  expect(error).toMatchObject({
    response: { status: 400 },
    clientBody: {
      error: {
        code: "unsupported_value",
        param: "previous_response_id",
        type: "invalid_request_error",
      },
    },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  ["store", { store: true }],
  ["background", { background: true }],
  ["previous_response_id", { previous_response_id: "resp_previous" }],
  ["service_tier", { service_tier: "priority" }],
] as const)(
  "rejects stateful control %s before a chat-only Responses fallback",
  async (param, extra) => {
    state.models = {
      object: "list",
      data: [
        {
          ...responsesCapableModels.data[0],
          id: "chat-only-responses-model",
          name: "chat-only-responses-model",
          supported_endpoints: ["/chat/completions"],
        },
      ],
    }

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat-only-responses-model",
        input: "Hello",
        ...extra,
      }),
    })
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(400)
    expect(body).toMatchObject({
      error: {
        code: "unsupported_value",
        param,
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test("rejects omitted function output before chat fallback reaches upstream", async () => {
  const modelId = "chat-only-missing-function-output"
  state.models = {
    object: "list",
    data: [
      {
        ...responsesCapableModels.data[0],
        id: modelId,
        name: modelId,
        supported_endpoints: ["/chat/completions"],
      },
    ],
  }

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      input: [{ type: "function_call_output", call_id: "call_1" }],
    }),
  })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await response.json()).toEqual({
    error: {
      code: "endpoint_translation_unsupported",
      message:
        "The selected Copilot model cannot accept this request without losing required protocol data.",
      param: "content_type",
      type: "invalid_request_error",
    },
  })
})

test("preserves prompt and conversation_id when sending Responses API requests", async () => {
  const prompt = {
    id: "pmpt_123",
    variables: { task: "greeting" },
  }

  await createResponses(
    {
      model: "gpt-4o",
      prompt,
      conversation_id: "conv_abc",
    } as {
      model: string
      prompt: {
        id: string
        variables: { task: string }
      }
      conversation_id: string
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.prompt).toEqual(prompt)
  expect(lastRequestBody?.conversation_id).toBe("conv_abc")
})

test("fits explicitly marked compaction payloads at the transport boundary", async () => {
  const oversizedOutput =
    "BEGIN-TRANSPORT\n"
    + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
    + "\nEND-TRANSPORT"

  await createResponses(
    {
      model: "gpt-4o",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_transport",
          name: "exec",
          input: "run transport diagnostic",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_transport",
          output: oversizedOutput,
        },
      ],
    },
    {
      compaction: true,
      vision: false,
      initiator: "user",
    },
  )

  const serialized = JSON.stringify(lastRequestBody)
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    COMPACTION_PAYLOAD_MAX_BYTES,
  )
  expect(serialized).toContain("run transport diagnostic")
  expect(serialized).toContain("BEGIN-TRANSPORT")
  expect(serialized).toContain("END-TRANSPORT")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
  expect(oversizedOutput).toEndWith("END-TRANSPORT")
})

test("injects runtime-style default reasoning settings for direct Responses requests", async () => {
  await createResponses(
    {
      model: "gpt-4o",
      input: "Hello",
    } as {
      model: string
      input: string
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.store).toBe(false)
  expect(lastRequestBody?.reasoning).toEqual({
    effort: "medium",
    summary: "auto",
  })
  expect(lastRequestBody?.include).toEqual(["reasoning.encrypted_content"])
})

test("clamps Responses max_output_tokens to Copilot's minimum", async () => {
  await createResponses(
    {
      model: "gpt-5.5",
      input: "Probe the selected model.",
      max_output_tokens: 1,
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.max_output_tokens).toBe(16)
})

test("normalizes direct Responses max reasoning aliases", () => {
  const payload = {
    model: "claude-opus-4.8",
    input: "Hello",
    reasoning_effort: "max",
  } as ResponsesPayload

  const effort = normalizeResponsesReasoning(payload)

  expect(effort).toBe("max")
  expect(payload.reasoning?.effort).toBe("max")
  expect((payload as Record<string, unknown>).reasoning_effort).toBeUndefined()
})

test("preserves explicit string effort for implicit-default Responses models", async () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  await createResponses(
    {
      model: "claude-implicit-medium",
      input: "Hello",
      reasoning: { effort: "high" },
    } as {
      model: string
      input: string
      reasoning: { effort: "high" }
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.reasoning).toEqual({
    effort: "high",
    summary: "auto",
  })
})

test("preserves explicit none for implicit-default Responses models", async () => {
  const model = {
    ...responsesCapableModels.data[0],
    id: "gpt-5.6-implicit-medium",
    name: "gpt-5.6-implicit-medium",
  }
  state.models = { object: "list", data: [model] }
  setModelSettingsForTest([
    {
      model: model.id,
      supportedReasoningEfforts: ["none", "medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      input: "Hello",
      reasoning: { effort: "none" },
      temperature: 0.3,
      top_p: 0.8,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastRequestBody?.reasoning).toEqual({ effort: "none" })
  expect(lastRequestBody?.include ?? []).not.toContain(
    "reasoning.encrypted_content",
  )
  expect(lastRequestBody?.temperature).toBe(0.3)
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("keeps numeric Responses redirects model-only across the HTTP route", async () => {
  const sourceModel = {
    ...responsesCapableModels.data[0],
    id: "numeric-route-source",
    name: "numeric-route-source",
  }
  const middleModel = {
    ...responsesCapableModels.data[0],
    id: "numeric-route-middle",
    name: "numeric-route-middle",
  }
  const finalModel = {
    ...responsesCapableModels.data[0],
    id: "numeric-route-final",
    name: "numeric-route-final",
  }
  state.models = {
    object: "list",
    data: [sourceModel, middleModel, finalModel],
  }
  setModelRedirectsForTest([
    {
      id: "numeric-route-source-to-middle",
      sourceModel: sourceModel.id,
      sourceEffort: "default",
      targetModel: middleModel.id,
      targetEffort: "high",
      enabled: true,
    },
    {
      id: "numeric-route-middle-high-to-wrong",
      sourceModel: middleModel.id,
      sourceEffort: "high",
      targetModel: "wrong-named-route-target",
      targetEffort: "max",
      enabled: true,
    },
    {
      id: "numeric-route-middle-default-to-final",
      sourceModel: middleModel.id,
      sourceEffort: "default",
      targetModel: finalModel.id,
      targetEffort: "xhigh",
      enabled: true,
    },
  ])
  const infoSpy = spyOn(console, "info")

  try {
    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: sourceModel.id,
        input: "Hello",
        reasoning: { effort: 2048 },
      }),
    })

    expect(response.status).toBe(200)
    expect(lastRequestBody?.model).toBe(finalModel.id)
    expect(lastRequestBody?.reasoning).toEqual({
      effort: 2048,
      summary: "auto",
    })
    const redirectTelemetry = infoSpy.mock.calls
      .flat()
      .filter(
        (value): value is string =>
          typeof value === "string" && value.includes("model_redirect"),
      )
      .join("\n")
    expect(redirectTelemetry).toContain(
      `${sourceModel.id} -> ${middleModel.id} -> ${finalModel.id}`,
    )
    expect(redirectTelemetry).not.toContain(":high")
    expect(redirectTelemetry).not.toContain(":max")
    expect(redirectTelemetry).not.toContain(":xhigh")
  } finally {
    infoSpy.mockRestore()
  }
})

test("dispatches zero from the top-level Responses reasoning alias", async () => {
  state.models = responsesCapableModels

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      input: "Hello",
      reasoning_effort: 0,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastRequestBody?.reasoning).toEqual({ effort: 0, summary: "auto" })
})

for (const model of ["gpt-5.4-mini", "gpt-5.5"]) {
  test(`omits built-in unsupported request parameters for ${model} Responses models`, async () => {
    await createResponses(
      {
        model,
        input: "Hello",
        temperature: 0.3,
        top_p: 0.8,
      },
      {
        vision: false,
        initiator: "user",
      },
    )

    expect(lastRequestBody).not.toHaveProperty("temperature")
    expect(lastRequestBody).not.toHaveProperty("top_p")
  })
}

test("keeps supported request parameters for other Responses models", async () => {
  await createResponses(
    {
      model: "gpt-4o",
      input: "Hello",
      temperature: 0.3,
      top_p: 0.8,
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.temperature).toBe(0.3)
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("omits configured unsupported request parameters for Responses models", async () => {
  setModelSettingsForTest([
    {
      model: "no-temperature-model",
      unsupportedRequestParameters: ["temperature"],
    },
  ])

  await createResponses(
    {
      model: "no-temperature-model",
      input: "Hello",
      temperature: 0.3,
      top_p: 0.8,
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody).not.toHaveProperty("temperature")
  expect(lastRequestBody?.top_p).toBe(0.8)
})

test("normalizes Responses function tool parameter schemas before forwarding", async () => {
  const payload: ResponsesPayload = {
    model: "gpt-4o",
    input: "Hello",
    tools: [
      {
        type: "function",
        name: "mcp__pencil__get_style_guide_tags",
        description: "Fetch style guide tags",
        parameters: {},
        strict: false,
      },
      {
        type: "function",
        name: "mcp__pencil__get_style_guide",
        parameters: { type: "object" },
        strict: false,
      },
    ],
  }

  await createResponses(payload, {
    vision: false,
    initiator: "user",
  })

  expect(lastRequestBody?.tools).toEqual([
    {
      type: "function",
      name: "mcp__pencil__get_style_guide_tags",
      description: "Fetch style guide tags",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
    {
      type: "function",
      name: "mcp__pencil__get_style_guide",
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ])
})

test("normalizes json_schema response format object schemas before forwarding", async () => {
  await createResponses(
    {
      model: "gpt-4o",
      input: "Extract entities.",
      text: {
        format: {
          type: "json_schema",
          name: "ExtractedEntities",
          schema: {
            type: "object",
            properties: {
              episode_indices: {
                type: "array",
                items: { type: "number" },
              },
              entities: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                  },
                  required: ["name", "type"],
                },
              },
            },
            required: ["entities"],
          },
        },
      },
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.text).toEqual({
    format: {
      type: "json_schema",
      name: "ExtractedEntities",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          episode_indices: {
            type: "array",
            items: { type: "number" },
          },
          entities: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                type: { type: "string" },
              },
              required: ["name", "type"],
            },
          },
        },
        required: ["entities", "episode_indices"],
      },
    },
  })
})

test("adds JSON mode input instruction when input lacks json", async () => {
  await createResponses(
    {
      model: "gpt-4o",
      input: "Extract entities.",
      instructions: "Return only JSON.",
      text: {
        format: { type: "json_object" },
      },
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.input).toEqual([
    {
      type: "message",
      role: "developer",
      content: "Respond with JSON.",
    },
    {
      type: "message",
      role: "user",
      content: "Extract entities.",
    },
  ])
  expect(lastRequestBody?.instructions).toBe("Return only JSON.")
})

test("does not add JSON mode input instruction when input already mentions json", async () => {
  await createResponses(
    {
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "user",
          content: "Return JSON.",
        },
      ],
      text: {
        format: { type: "json_object" },
      },
    },
    {
      vision: false,
      initiator: "user",
    },
  )

  expect(lastRequestBody?.input).toEqual([
    {
      type: "message",
      role: "user",
      content: "Return JSON.",
    },
  ])
})

test("does not mutate and retry a changed-ceiling upstream 413", async () => {
  queuedResponses.push(
    new Response("payload too large", {
      status: 413,
      headers: { "content-type": "text/plain" },
    }),
    createSuccessResponse(),
  )

  const error = await createResponses(
    {
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe this image" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc",
              detail: "high",
            },
          ],
        },
      ],
    } as {
      model: string
      input: Array<{
        role: string
        content: Array<
          | { type: "input_text"; text: string }
          | { type: "input_image"; image_url: string; detail: string }
        >
      }>
    },
    {
      vision: true,
      initiator: "user",
    },
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).response.status).toBe(413)
  expect(requestBodies).toHaveLength(1)
  expect(requestBodies[0]?.input).toEqual([
    {
      role: "user",
      content: [
        { type: "input_text", text: "Describe this image" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,abc",
          detail: "high",
        },
      ],
    },
  ])
  const usage = getRoutingTelemetrySnapshot({
    accounts: [],
    multiToken: false,
    window: "1h",
  })
  expect(usage.totals).toMatchObject({
    retries: 0,
    upstreamCalls: 1,
  })
  expect(
    usage.selectionModes.sticky
      + usage.selectionModes.default
      + usage.selectionModes.single,
  ).toBe(1)
})

test("does not retry changed-ceiling 413 Responses requests with image-only input", async () => {
  queuedResponses.push(
    new Response("payload too large", {
      status: 413,
      headers: { "content-type": "text/plain" },
    }),
    createSuccessResponse(),
  )

  const error = await createResponses(
    {
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc",
              detail: "high",
            },
          ],
        },
      ],
    } as {
      model: string
      input: Array<{
        role: string
        content: Array<{
          type: "input_image"
          image_url: string
          detail: string
        }>
      }>
    },
    {
      vision: true,
      initiator: "user",
    },
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as HTTPError).response.status).toBe(413)
  expect(requestBodies).toHaveLength(1)
})
