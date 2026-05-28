import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  ResponseInputItem,
  ResponsesPayload,
} from "../src/services/copilot/create-responses"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setConfigForTest } from "../src/lib/config"
import { state } from "../src/lib/state"
import {
  extractResponsesPayload,
  isSyntheticWarmupRequest,
  recordResponseSnapshotFromFrame,
  rehydrateContinuationPayload,
  type ResponsesWebSocketData,
  responsesWebSocket,
  rehydrateWarmupPayload,
  sendWebSocketError,
  tryUpgradeResponsesWebSocket,
} from "../src/routes/responses/websocket"

const originalApiKeyAuth = state.apiKeyAuth
const originalFetch = globalThis.fetch
const originalModels = state.models
const queuedResponses: Array<Response> = []
let lastRequestBody: Record<string, unknown> | undefined

const responsesCapableModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

const fetchMock = mock((_url: string, init?: RequestInit) => {
  lastRequestBody =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined
  return queuedResponses.shift() ?? createResponsesSseResponse("resp_default")
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

afterEach(() => {
  fetchMock.mockClear()
  lastRequestBody = undefined
  queuedResponses.length = 0
  state.apiKeyAuth = originalApiKeyAuth
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = originalModels
  setConfigForTest(null)
})

describe("extractResponsesPayload", () => {
  test("merges top-level continuation fields with nested response payload", () => {
    const payload = extractResponsesPayload({
      type: "response.create",
      previous_response_id: "resp_prev",
      response: {
        model: "gpt-5.4",
        stream: true,
      },
    })

    expect(payload.model).toBe("gpt-5.4")
    expect(payload.stream).toBe(true)
    expect(payload.previous_response_id).toBe("resp_prev")
  })

  test("uses top-level payload when nested response object is absent", () => {
    const payload = extractResponsesPayload({
      type: "response.create",
      model: "gpt-5.4",
      input: "hello",
      stream: true,
    })

    expect(payload.model).toBe("gpt-5.4")
    expect(payload.input).toBe("hello")
    expect((payload as unknown as Record<string, unknown>).type).toBeUndefined()
  })

  test("prefers nested response values when keys overlap", () => {
    const payload = extractResponsesPayload({
      type: "response.create",
      model: "gpt-5-mini",
      response: {
        model: "gpt-5.4",
        input: "hello",
      },
    })

    expect(payload.model).toBe("gpt-5.4")
    expect(payload.input).toBe("hello")
  })
})

describe("responses websocket upgrade handling", () => {
  test("matches /responses and /v1/responses upgrade paths", () => {
    const upgraded: Array<ResponsesWebSocketData> = []
    const server = {
      upgrade(_req: Request, opts?: object): boolean {
        upgraded.push(
          (opts as { data: ResponsesWebSocketData } | undefined)?.data
            ?? ({} as ResponsesWebSocketData),
        )
        return true
      },
    }

    expect(
      tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: { upgrade: "websocket", "x-client-request-id": "req-1" },
        }),
        server,
      ),
    ).toBe("upgraded")
    expect(
      tryUpgradeResponsesWebSocket(
        new Request("http://localhost/v1/responses", {
          headers: { upgrade: "websocket" },
        }),
        server,
      ),
    ).toBe("upgraded")
    expect(
      tryUpgradeResponsesWebSocket(
        new Request("http://localhost/v1/chat/completions", {
          headers: { upgrade: "websocket" },
        }),
        server,
      ),
    ).toBe("no_match")
    expect(upgraded[0]?.requestId).toBe("req-1")
    expect(upgraded[0]?.responseSnapshots).toBeInstanceOf(Map)
  })

  test("enforces cli and config api keys before upgrade", () => {
    const server = {
      upgrade(): boolean {
        return true
      },
    }

    state.apiKeyAuth = "cli-secret"
    expect(
      tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: { upgrade: "websocket" },
        }),
        server,
      ),
    ).toBe("auth_failed")
    expect(
      tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: {
            authorization: "Bearer cli-secret",
            upgrade: "websocket",
          },
        }),
        server,
      ),
    ).toBe("upgraded")

    state.apiKeyAuth = undefined
    setConfigForTest({ auth: { apiKeys: ["config-secret"] } })
    expect(
      tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: { upgrade: "websocket", "x-api-key": "wrong" },
        }),
        server,
      ),
    ).toBe("auth_failed")
    expect(
      tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: { upgrade: "websocket", "x-api-key": "config-secret" },
        }),
        server,
      ),
    ).toBe("upgraded")
  })
})

describe("responses websocket message handling", () => {
  test("accepts response.processed as a no-op", async () => {
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({ type: "response.processed", response_id: "resp_1" }),
    )

    expect(ws.sent).toEqual([])
  })

  test("sends terminal error frames for invalid client messages", async () => {
    const ws = createTestWebSocket()

    await responsesWebSocket.message(ws, new Uint8Array([1, 2, 3]))
    await responsesWebSocket.message(ws, "{")
    await responsesWebSocket.message(ws, JSON.stringify({ type: "unknown" }))

    const frames = ws.sent.map(
      (frame) =>
        JSON.parse(frame) as {
          error: { code: string; message: string; request_id: string }
          status: number
          type: string
        },
    )

    expect(frames).toHaveLength(3)
    expect(frames.every((frame) => frame.type === "error")).toBe(true)
    expect(frames.every((frame) => frame.status === 400)).toBe(true)
    expect(frames.every((frame) => frame.error.code === "bad_request")).toBe(
      true,
    )
    expect(frames.every((frame) => frame.error.request_id === "req-test")).toBe(
      true,
    )
    expect(frames[2]?.error.message).toContain("Unsupported message type")
  })

  test("sendWebSocketError emits CAPI-style error envelopes", () => {
    const ws = createTestWebSocket()

    sendWebSocketError(ws, {
      code: "rate_limited",
      message: "slow down",
      status: 429,
    })

    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "error",
      status: 429,
      error: {
        code: "rate_limited",
        message: "slow down",
        type: "websocket_error",
        request_id: "req-test",
      },
    })
  })

  test("streams native Responses SSE events as WebSocket JSON frames", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(createResponsesSseResponse("resp_ws"))
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello" }],
          },
        ],
        tools: [],
      }),
    )

    const eventTypes = ws.sent.map(
      (frame) => (JSON.parse(frame) as { type: string }).type,
    )
    expect(eventTypes).toEqual(["response.created", "response.completed"])
    expect(lastRequestBody?.previous_response_id).toBeUndefined()
    expect(ws.data.responseSnapshots.has("resp_ws")).toBe(true)
  })

  test("does not forward unknown previous_response_id upstream", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        previous_response_id: "missing",
        input: [],
        tools: [],
      }),
    )

    const errorFrame = JSON.parse(ws.sent[0] ?? "{}") as {
      error?: { code?: string; message?: string }
      status?: number
      type?: string
    }
    expect(errorFrame.type).toBe("error")
    expect(errorFrame.status).toBe(400)
    expect(errorFrame.error?.code).toBe("bad_request")
    expect(errorFrame.error?.message).toContain("Unknown previous_response_id")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("strips null previous_response_id before forwarding upstream", async () => {
    state.models = responsesCapableModels
    queuedResponses.push(createResponsesSseResponse("resp_null_prev"))
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        previous_response_id: null,
        input: [],
        tools: [],
      }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastRequestBody?.previous_response_id).toBeUndefined()
    expect(
      ws.sent.some(
        (frame) => (JSON.parse(frame) as { type: string }).type === "error",
      ),
    ).toBe(false)
  })
})

describe("responses websocket upstream handling", () => {
  test("strips encrypted reasoning from rehydrated continuation input before forwarding", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(createResponsesSseResponse("resp_continuation_clean"))
    const ws = createTestWebSocket()

    recordResponseSnapshotFromFrame(
      ws.data.responseSnapshots,
      {
        model: "gpt-5.4",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "First" }],
          },
        ],
        stream: true,
      },
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_with_reasoning",
          output: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "Thought" }],
              encrypted_content: "token-bound-secret",
            },
          ],
        },
      }),
    )

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        previous_response_id: "resp_with_reasoning",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Follow up" }],
          },
        ],
        tools: [],
      }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastRequestBody?.previous_response_id).toBeUndefined()
    expect(JSON.stringify(lastRequestBody?.input)).not.toContain(
      "encrypted_content",
    )
    expect(JSON.stringify(lastRequestBody?.input)).not.toContain(
      "token-bound-secret",
    )
  })

  test("turns deterministic upstream HTTP errors into terminal WebSocket error frames", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      new Response(
        JSON.stringify({ error: { message: "Too many requests" } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
    )
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: [],
        tools: [],
      }),
    )

    const errorFrame = JSON.parse(ws.sent[0] ?? "{}") as {
      error?: { code?: string }
      status?: number
      type?: string
    }
    expect(errorFrame.type).toBe("error")
    expect(errorFrame.status).toBe(400)
    expect(errorFrame.error?.code).toBe("bad_request")
  })
})

describe("responses websocket warmup handling", () => {
  test("detects generate=false Codex prewarm requests", () => {
    expect(
      isSyntheticWarmupRequest({
        model: "gpt-5.4",
        instructions: "You are Codex.",
        input: [],
        tools: [],
        generate: false,
        stream: true,
      }),
    ).toBe(true)

    expect(
      isSyntheticWarmupRequest({
        model: "gpt-5.4",
        instructions: "You are Codex.",
        input: [],
        tools: [],
        stream: true,
      }),
    ).toBe(false)
  })

  test("rehydrates follow-up requests that reference a synthetic warmup", () => {
    const warmupPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the failing tests." }],
        },
      ],
      tools: [],
      generate: false,
      stream: true,
    }

    const followUpPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      previous_response_id: "warmup_123",
      input: [],
      tools: [],
      stream: true,
    }

    const rehydratedWarmup = rehydrateWarmupPayload(
      warmupPayload,
      followUpPayload,
    )

    expect(rehydratedWarmup).toMatchObject({
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: warmupPayload.input,
      tools: [],
      stream: true,
    })
    expect(rehydratedWarmup.generate).toBeUndefined()

    const startupWarmup: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: [],
      tools: [],
      generate: false,
      stream: true,
    }
    const firstTurnPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      previous_response_id: "warmup_456",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
      tools: [],
      stream: true,
    }

    const rehydratedStartupWarmup = rehydrateWarmupPayload(
      startupWarmup,
      firstTurnPayload,
    )

    expect(rehydratedStartupWarmup).toMatchObject({
      input: firstTurnPayload.input,
      stream: true,
    })
    expect(rehydratedStartupWarmup.generate).toBeUndefined()
  })
})

describe("responses websocket continuation handling", () => {
  test("rehydrates arbitrary completed response continuations", () => {
    const snapshots = new Map<string, ResponsesPayload>()
    const priorPayload: ResponsesPayload = {
      model: "gpt-5.4",
      instructions: "You are Codex.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "First" }],
        },
      ],
      tools: [{ type: "function", name: "shell", parameters: {} }],
      stream: true,
    }

    recordResponseSnapshotFromFrame(
      snapshots,
      priorPayload,
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_done",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done" }],
            },
          ],
        },
      }),
    )

    const followUpPayload: ResponsesPayload = {
      model: "gpt-5.4",
      previous_response_id: "resp_done",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "ok",
        },
      ],
      stream: true,
    }

    const rehydrated = rehydrateContinuationPayload(snapshots, followUpPayload)

    expect(rehydrated?.previous_response_id).toBeUndefined()
    expect(rehydrated?.instructions).toBe("You are Codex.")
    expect(rehydrated?.tools).toEqual(priorPayload.tools)
    expect(rehydrated?.input).toEqual([
      ...(priorPayload.input as Array<ResponseInputItem>),
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done" }],
      },
      ...(followUpPayload.input as Array<ResponseInputItem>),
    ])
  })

  test("returns undefined for unknown previous_response_id", () => {
    expect(
      rehydrateContinuationPayload(new Map(), {
        model: "gpt-5.4",
        previous_response_id: "missing",
        input: [],
      }),
    ).toBeUndefined()
  })
})

function createTestWebSocket(): {
  close: () => void
  data: ResponsesWebSocketData
  sent: Array<string>
  send: (data: string) => void
} {
  const sent: Array<string> = []
  return {
    data: {
      type: "responses",
      requestId: "req-test",
      sessionId: "session-test",
      responseSnapshots: new Map(),
    },
    sent,
    send(data: string): void {
      sent.push(data)
    },
    close(): void {},
  }
}

function createResponsesSseResponse(responseId: string): Response {
  const created = JSON.stringify({
    type: "response.created",
    sequence_number: 0,
    response: {
      id: responseId,
      object: "response",
      created_at: 1,
      model: "gpt-5.4",
      output: [],
      output_text: "",
      status: "in_progress",
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
    },
  })
  const completed = JSON.stringify({
    type: "response.completed",
    sequence_number: 1,
    response: {
      id: responseId,
      object: "response",
      created_at: 1,
      model: "gpt-5.4",
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
    },
  })

  return new Response(
    `event: response.created\ndata: ${created}\n\n`
      + `event: response.completed\ndata: ${completed}\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}
