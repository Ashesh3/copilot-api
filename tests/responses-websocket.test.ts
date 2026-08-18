/* eslint-disable max-lines, max-lines-per-function */
import * as Sentry from "@sentry/bun"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type {
  ResponseInputItem,
  ResponsesPayload,
} from "../src/services/copilot/create-responses"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setConfigForTest } from "../src/lib/config"
import { isIpBlocked, resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { createRoutingTelemetryRequestState } from "../src/lib/request-session"
import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "../src/lib/routing-affinity"
import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
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
import {
  createResponsesWebSocketTurn,
  runWithWebSocketRequestContext,
} from "../src/routes/responses/websocket-lifecycle"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "../src/services/copilot/compaction-payload"
import {
  CAPI_RESPONSES_MAX_REQUEST_BYTES,
  RESPONSES_RECOVERY_MARGIN_BYTES,
} from "../src/services/copilot/responses-payload-recovery"

const originalApiKeyAuth = state.apiKeyAuth
const originalFetch = globalThis.fetch
const originalModels = state.models
const webSocketAccountIds = [23_001, 23_002]
const queuedResponses: Array<Response> = []
const queuedFetchHandlers: Array<
  (init?: RequestInit) => Promise<Response> | Response
> = []
let lastRequestBody: Record<string, unknown> | undefined
let capturedAffinity: RoutingAffinity | undefined
const capturedAuthorization: Array<string | null> = []

function authenticatedResponsesRequest(): Request {
  return new Request("http://localhost/responses", {
    headers: { authorization: "Bearer cli-secret" },
  })
}

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
  capturedAffinity = getRoutingAffinity()
  capturedAuthorization.push(new Headers(init?.headers).get("authorization"))
  lastRequestBody =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined
  const handler = queuedFetchHandlers.shift()
  return (
    handler?.(init)
    ?? queuedResponses.shift()
    ?? createResponsesSseResponse("resp_default")
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  for (const accountId of webSocketAccountIds)
    tokenPool.removeAccountForTest(accountId)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

afterEach(() => {
  fetchMock.mockClear()
  lastRequestBody = undefined
  capturedAffinity = undefined
  capturedAuthorization.length = 0
  queuedResponses.length = 0
  queuedFetchHandlers.length = 0
  state.apiKeyAuth = originalApiKeyAuth
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = originalModels
  setConfigForTest(null)
  resetIpSecurityForTest()
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
  test("matches /responses and /v1/responses upgrade paths", async () => {
    state.apiKeyAuth = "route-secret"
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
      await tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: {
            authorization: "Bearer route-secret",
            upgrade: "websocket",
            "x-client-request-id": "req-1",
          },
        }),
        server,
      ),
    ).toBe("upgraded")
    expect(
      await tryUpgradeResponsesWebSocket(
        new Request("http://localhost/v1/responses", {
          headers: {
            authorization: "Bearer route-secret",
            upgrade: "websocket",
          },
        }),
        server,
      ),
    ).toBe("upgraded")
    expect(
      await tryUpgradeResponsesWebSocket(
        new Request("http://localhost/v1/chat/completions", {
          headers: { upgrade: "websocket" },
        }),
        server,
      ),
    ).toBe("no_match")
    expect(upgraded[0]?.requestId).toBe("req-1")
    expect(upgraded[0]?.responseSnapshots).toBeInstanceOf(Map)
  })

  test("resolves every supported WebSocket upgrade affinity header", async () => {
    state.apiKeyAuth = "route-secret"
    for (const [header, key, source] of [
      ["x-claude-code-session-id", "claude", "claude_session"],
      ["x-client-session-id", "copilot", "copilot_session"],
      ["session-id", "codex", "codex_session"],
      ["thread-id", "thread", "codex_thread"],
    ] as const) {
      let upgraded: ResponsesWebSocketData | undefined
      await tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: {
            authorization: "Bearer route-secret",
            [header]: key,
          },
        }),
        {
          upgrade(_request, options): boolean {
            upgraded = (options as { data: ResponsesWebSocketData }).data
            return true
          },
        },
      )
      expect(upgraded?.affinity).toEqual({ key, source })
    }
  })

  test("uses upgrade affinity precedence and ignores request identifiers", async () => {
    state.apiKeyAuth = "route-secret"
    let upgraded: ResponsesWebSocketData | undefined
    const upgrade = async (headers: Record<string, string>) => {
      await tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: { authorization: "Bearer route-secret", ...headers },
        }),
        {
          upgrade(_request, options): boolean {
            upgraded = (options as { data: ResponsesWebSocketData }).data
            return true
          },
        },
      )
      return upgraded
    }

    expect(
      (
        await upgrade({
          "x-claude-code-session-id": "claude-wins",
          "x-client-session-id": "copilot-loses",
          "session-id": "session-loses",
          "thread-id": "thread-loses",
        })
      )?.affinity,
    ).toEqual({ key: "claude-wins", source: "claude_session" })
    expect(
      (
        await upgrade({
          "x-client-session-id": "copilot-wins",
          "session-id": "session-loses",
          "thread-id": "thread-loses",
        })
      )?.affinity,
    ).toEqual({ key: "copilot-wins", source: "copilot_session" })
    expect(
      (
        await upgrade({
          "session-id": "session-wins",
          "thread-id": "thread-loses",
        })
      )?.affinity,
    ).toEqual({ key: "session-wins", source: "codex_session" })
    expect((await upgrade({ "thread-id": "thread-wins" }))?.affinity).toEqual({
      key: "thread-wins",
      source: "codex_thread",
    })
    expect(
      (
        await upgrade({
          "x-request-id": "request-not-affinity",
          "x-client-request-id": "client-request-not-affinity",
        })
      )?.affinity,
    ).toBeUndefined()
  })

  test("enforces cli and config api keys before upgrade", async () => {
    const server = {
      upgrade(): boolean {
        return true
      },
    }

    state.apiKeyAuth = "cli-secret"
    expect(
      await tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: { upgrade: "websocket" },
        }),
        server,
      ),
    ).toBe("auth_failed")
    expect(
      await tryUpgradeResponsesWebSocket(
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
      await tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: { upgrade: "websocket", "x-api-key": "wrong" },
        }),
        server,
      ),
    ).toBe("auth_failed")
    expect(
      await tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: { upgrade: "websocket", "x-api-key": "config-secret" },
        }),
        server,
      ),
    ).toBe("upgraded")
  })

  test("records missing and invalid upgrade credentials", async () => {
    state.apiKeyAuth = "cli-secret"
    const clientIp = "198.51.100.91"
    const server = { upgrade: () => true }

    for (const apiKey of [undefined, undefined, "wrong-key"]) {
      const headers = new Headers({
        upgrade: "websocket",
        "x-copilot-peer-ip": clientIp,
      })
      if (apiKey) headers.set("x-api-key", apiKey)
      expect(
        await tryUpgradeResponsesWebSocket(
          new Request("http://localhost/responses", { headers }),
          server,
        ),
      ).toBe("auth_failed")
    }

    expect(isIpBlocked(clientIp)).toBe(true)
    expect(
      await tryUpgradeResponsesWebSocket(
        new Request("http://localhost/responses", {
          headers: {
            "x-api-key": "cli-secret",
            upgrade: "websocket",
            "x-copilot-peer-ip": clientIp,
          },
        }),
        server,
      ),
    ).toBe("auth_failed")
  })

  test("allows multiple connections for one authenticated principal", async () => {
    state.apiKeyAuth = "cli-secret"
    const server = { upgrade: () => true }
    for (let index = 0; index < 5; index += 1) {
      expect(
        await tryUpgradeResponsesWebSocket(
          authenticatedResponsesRequest(),
          server,
        ),
      ).toBe("upgraded")
    }
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

  test("closing a socket does not affect later upgrades", async () => {
    state.apiKeyAuth = "cli-secret"
    let upgraded: ResponsesWebSocketData | undefined
    const server = {
      upgrade(_request: Request, options?: object): boolean {
        upgraded = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    }
    expect(
      await tryUpgradeResponsesWebSocket(
        authenticatedResponsesRequest(),
        server,
      ),
    ).toBe("upgraded")
    if (!upgraded) throw new Error("Expected upgraded socket data")
    responsesWebSocket.close({ data: upgraded })
    responsesWebSocket.close({ data: upgraded })
    expect(
      await tryUpgradeResponsesWebSocket(
        authenticatedResponsesRequest(),
        server,
      ),
    ).toBe("upgraded")
  })

  test("accepts frames larger than the former local frame boundary", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "x".repeat(4 * 1024 * 1024 + 1),
        generate: false,
      }),
    )

    expect(
      ws.sent.some(
        (frame) =>
          (JSON.parse(frame) as { type?: string }).type
          === "response.completed",
      ),
    ).toBe(true)
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test("accepts a new turn while other turns are active", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    ws.data.nextTurnSequence = 5
    for (let index = 1; index <= 5; index += 1) {
      ws.data.activeTurns.set(index, {
        abortController: new AbortController(),
        finalized: false,
        inputLength: 0,
        routingState: {},
        telemetryState: createRoutingTelemetryRequestState(
          "Responses WebSocket",
        ),
        sequence: index,
        turnId: `test:${index}`,
      })
    }
    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        generate: false,
      }),
    )

    expect(
      ws.sent.some(
        (frame) =>
          (JSON.parse(frame) as { type?: string }).type
          === "response.completed",
      ),
    ).toBe(true)
    expect(ws.data.activeTurns.size).toBe(5)
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
      code: "server_error",
      message: "upstream failed",
      status: 502,
    })

    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "error",
      status: 502,
      error: {
        code: "server_error",
        message: "upstream failed",
        type: "websocket_error",
        request_id: "req-test",
      },
    })
  })

  test("preserves a structured session affinity error in the terminal frame", async () => {
    const modelId = "responses-websocket-session-affinity-error"
    const model = {
      ...responsesCapableModels.data[0],
      id: modelId,
      name: modelId,
    }
    state.models = { data: [model], object: "list" }
    for (const [id, token] of [
      [23_001, "websocket-bound-token"],
      [23_002, "websocket-alternate-token"],
    ] as const) {
      const account = tokenPool.addAccount(`github-${id}`, "individual", id)
      account.copilotToken = token
      account.healthy = true
      account.models = new Set([modelId])
      account.modelsData = [model]
    }
    tokenPool.rebuildModelIndex()
    state.isMultiToken = true
    const selected = tokenPool.getAccountForModelBySession(
      modelId,
      "session-test",
    )
    if (!selected) throw new TypeError("Expected selected WebSocket account")
    queuedResponses.push(
      new Response("Unauthorized", { status: 401 }),
      Response.json({
        expires_at: 1_900_000_000,
        refresh_in: 1800,
        token: "websocket-refreshed-token",
      }),
      Response.json({ data: [model], object: "list" }),
      new Response("Unauthorized", { status: 401 }),
    )
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        input: "continue",
        model: modelId,
        type: "response.create",
      }),
    )

    const errorFrame = JSON.parse(ws.sent[0] ?? "{}") as {
      error?: { code?: string; message?: string; type?: string }
      status?: number
      type?: string
    }
    expect(errorFrame).toMatchObject({
      type: "error",
      status: 409,
      error: {
        code: "bad_request",
        message:
          "The bound account rejected this conversation after successful account reinitialization; affinity was preserved and no cross-account retry was attempted.",
        type: "session_affinity_error",
      },
    })
    expect(ws.data.activeTurns.size).toBe(0)
    expect(capturedAuthorization).not.toContain(
      selected.id === 23_001 ?
        "Bearer websocket-alternate-token"
      : "Bearer websocket-bound-token",
    )
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
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test("uses per-frame metadata affinity and preserves handshake precedence", async () => {
    state.models = responsesCapableModels
    queuedResponses.push(
      createResponsesSseResponse("resp_frame_affinity"),
      createResponsesSseResponse("resp_handshake_affinity"),
      createResponsesSseResponse("resp_malformed_affinity"),
    )
    const metadataOnly = createTestWebSocket()
    metadataOnly.data.affinity = undefined
    await responsesWebSocket.message(
      metadataOnly,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "hello",
        client_metadata: { session_id: "frame-session" },
      }),
    )
    expect(capturedAffinity).toEqual({
      key: "frame-session",
      source: "codex_metadata",
    })

    const handshake = createTestWebSocket()
    handshake.data.affinity = {
      key: "handshake-session",
      source: "copilot_session",
    }
    await responsesWebSocket.message(
      handshake,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "hello",
        client_metadata: { session_id: "conflicting-frame-session" },
      }),
    )
    expect(capturedAffinity).toEqual(handshake.data.affinity)

    const malformed = createTestWebSocket()
    malformed.data.affinity = undefined
    await responsesWebSocket.message(
      malformed,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "hello",
        client_metadata: "not json",
      }),
    )
    expect(capturedAffinity).toBeUndefined()
  })

  test("inherits affinity from a completed continuation snapshot", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      createResponsesSseResponse("resp_affinity_parent"),
      createResponsesSseResponse("resp_affinity_child"),
    )
    const ws = createTestWebSocket()
    ws.data.affinity = undefined
    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "first",
        client_metadata: { session_id: "snapshot-session" },
      }),
    )
    expect(ws.data.responseSnapshots.has("resp_affinity_parent")).toBe(true)

    capturedAffinity = undefined as RoutingAffinity | undefined
    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "follow-up",
        previous_response_id: "resp_affinity_parent",
      }),
    )

    expect(capturedAffinity).toEqual({
      key: "snapshot-session",
      source: "codex_metadata",
    })
    expect(lastRequestBody?.previous_response_id).toBeUndefined()
  })

  test("isolates concurrent WebSocket turn affinity contexts", async () => {
    const firstWs = createTestWebSocket()
    const secondWs = createTestWebSocket()
    const firstTurn = createResponsesWebSocketTurn(firstWs.data, "first")
    const secondTurn = createResponsesWebSocketTurn(secondWs.data, "second")
    let releaseFirst: (() => void) | undefined
    let releaseSecond: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const observed: Array<string | undefined> = []

    const first = runWithWebSocketRequestContext(
      { key: "first-turn", source: "codex_metadata" },
      firstTurn,
      async () => {
        observed.push(getRoutingAffinity()?.key)
        await firstGate
        observed.push(getRoutingAffinity()?.key)
      },
    )
    const second = runWithWebSocketRequestContext(
      { key: "second-turn", source: "codex_metadata" },
      secondTurn,
      async () => {
        observed.push(getRoutingAffinity()?.key)
        await secondGate
        observed.push(getRoutingAffinity()?.key)
      },
    )

    releaseSecond?.()
    await second
    releaseFirst?.()
    await first
    expect(observed).toEqual([
      "first-turn",
      "second-turn",
      "second-turn",
      "first-turn",
    ])
    expect(getRoutingAffinity()).toBeUndefined()
  })

  test("streams the Chat Completions fallback with a per-turn abort signal", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        supported_endpoints: ["/chat/completions"],
      })),
    }
    let upstreamSignal: AbortSignal | null | undefined
    queuedFetchHandlers.push((init) => {
      upstreamSignal = init?.signal
      return createChatCompletionsSseResponse()
    })
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "Hello",
        tools: [],
      }),
    )

    expect(upstreamSignal).toBeInstanceOf(AbortSignal)
    expect(
      ws.sent.some(
        (frame) =>
          (JSON.parse(frame) as { type?: string }).type
          === "response.completed",
      ),
    ).toBe(true)
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test("routes a Messages-only WebSocket model through native Messages", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          ...model.capabilities,
          supports: { reasoning_effort: ["medium"] },
        },
      })),
    }
    queuedResponses.push(
      Response.json({
        id: "msg_ws_messages",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Hello from Messages" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    )
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "Hello",
      }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ws.sent.some((frame) => frame.includes("Hello from Messages"))).toBe(
      true,
    )
    expect(lastRequestBody).toMatchObject({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    })
  })

  test("returns a recoverable error when a WebSocket model has no endpoint", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        supported_endpoints: [],
      })),
    }
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "Hello",
      }),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ws.data.closed).toBe(false)
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "error",
      status: 400,
      error: { code: "endpoint_translation_unsupported" },
    })
  })

  test("rejects stateful and blocked-tool WebSocket turns before dispatch", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()

    for (const payload of [
      { model: "gpt-5.4", input: "Hello", store: true },
      {
        model: "gpt-5.4",
        input: "Hello",
        tools: [{ type: "code_interpreter" }],
      },
    ]) {
      await responsesWebSocket.message(
        ws,
        JSON.stringify({ type: "response.create", ...payload }),
      )
    }

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ws.data.closed).toBe(false)
    const errorFrames = ws.sent.map(
      (frame) =>
        JSON.parse(frame) as {
          error?: { param?: string }
          type?: string
        },
    )
    expect(errorFrames).toHaveLength(2)
    expect(errorFrames[0]?.type).toBe("error")
    expect(errorFrames[0]?.error?.param).toBe("store")
    expect(errorFrames[1]?.type).toBe("error")
    expect(errorFrames[1]?.error?.param).toBe("tools")
  })

  test("forwards safe translation errors before upstream and keeps the socket open", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        supported_endpoints: ["/chat/completions"],
      })),
    }
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: [
          {
            type: "reasoning",
            encrypted_content: "private-encrypted-state",
            summary: [],
          },
        ],
      }),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ws.data.closed).toBe(false)
    expect(ws.data.activeTurns.size).toBe(0)
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toEqual({
      type: "error",
      status: 400,
      error: {
        code: "endpoint_translation_unsupported",
        message:
          "The selected Copilot model cannot accept this request without losing required protocol data.",
        param: "opaque_reasoning",
        type: "invalid_request_error",
        request_id: "req-test",
      },
    })
  })

  test("fits rehydrated compaction turns on ChatCompletions fallback", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        supported_endpoints: ["/chat/completions"],
      })),
    }
    queuedResponses.push(createChatCompletionsSseResponse())
    const ws = createTestWebSocket()
    const oversizedOutput =
      "BEGIN-WS-FALLBACK\n"
      + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
      + "\nEND-WS-FALLBACK"

    recordResponseSnapshotFromFrame(
      ws.data.responseSnapshots,
      {
        model: "gpt-5.4",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_ws_fallback",
            name: "exec",
            input: "run ws fallback diagnostic",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_ws_fallback",
            output: oversizedOutput,
          },
        ],
        stream: true,
      },
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ws_fallback", output: [] },
      }),
    )

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        previous_response_id: "resp_ws_fallback",
        input: [],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
      }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(lastRequestBody)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      COMPACTION_PAYLOAD_MAX_BYTES,
    )
    expect(serialized).toContain("run ws fallback diagnostic")
    expect(serialized).toContain("call_ws_fallback")
    expect(serialized).toContain("BEGIN-WS-FALLBACK")
    expect(serialized).toContain("END-WS-FALLBACK")
    expect(serialized).toContain("UTF-8 bytes omitted during compaction")
  })

  test("tracks concurrent turns independently", async () => {
    state.models = responsesCapableModels
    const resolvers: Array<(response: Response) => void> = []
    const upstreamSignals: Array<AbortSignal | null | undefined> = []
    for (let index = 0; index < 2; index++) {
      queuedFetchHandlers.push(
        (init) =>
          new Promise<Response>((resolve) => {
            upstreamSignals.push(init?.signal)
            resolvers.push(resolve)
          }),
      )
    }
    const ws = createTestWebSocket()

    const first = responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "first",
        tools: [],
      }),
    )
    const second = responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "second",
        tools: [],
      }),
    )
    await waitFor(() => resolvers.length === 2)

    expect(ws.data.activeTurns.size).toBe(2)
    expect(upstreamSignals[0]).not.toBe(upstreamSignals[1])
    resolvers[1]?.(createResponsesSseResponse("resp_second"))
    resolvers[0]?.(createResponsesSseResponse("resp_first"))
    await Promise.all([first, second])

    expect(ws.data.activeTurns.size).toBe(0)
    expect(ws.data.responseSnapshots.has("resp_first")).toBe(true)
    expect(ws.data.responseSnapshots.has("resp_second")).toBe(true)
  })

  test("aborts and finalizes active turns exactly once when the socket closes", async () => {
    state.models = responsesCapableModels
    let upstreamSignal: AbortSignal | null | undefined
    queuedFetchHandlers.push(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("upstream fetch aborted")
            error.name = "AbortError"
            reject(error)
          })
        }),
    )
    const ws = createTestWebSocket()
    const infoLines: Array<string> = []
    const originalConsoleInfo = console.info
    console.info = (...args: Array<unknown>) => {
      infoLines.push(args.map(String).join(" "))
    }

    try {
      const pending = responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "keep streaming",
          tools: [],
        }),
      )
      await waitFor(() => upstreamSignal !== undefined)

      responsesWebSocket.close(ws)
      await pending

      expect(upstreamSignal?.aborted).toBe(true)
      expect(ws.data.closed).toBe(true)
      expect(ws.data.activeTurns.size).toBe(0)
      expect(infoLines.filter((line) => line.includes("STARTED"))).toHaveLength(
        1,
      )
      expect(infoLines.filter((line) => line.includes("ABORTED"))).toHaveLength(
        1,
      )
      expect(infoLines.some((line) => line.includes("499"))).toBe(true)
      expect(
        ws.sent.some(
          (frame) => (JSON.parse(frame) as { type?: string }).type === "error",
        ),
      ).toBe(false)
    } finally {
      // eslint-disable-next-line require-atomic-updates
      console.info = originalConsoleInfo
    }
  })

  test.each([
    { eventType: "response.failed", name: "response.failed" },
    { eventType: "response.incomplete", name: "response.incomplete" },
    { eventType: "response.completed", name: "failed response.completed" },
    { eventType: "error", name: "error" },
  ])(
    "sanitizes native $name terminal frames across clients and diagnostics",
    async ({ eventType }) => {
      state.copilotToken = "copilot-token"
      state.models = responsesCapableModels
      const privateMarker = `ws-${eventType}-private-marker`
      queuedResponses.push(
        createResponsesTerminalSseResponse(eventType, privateMarker),
      )
      const ws = createTestWebSocket()
      const infoSpy = spyOn(console, "info").mockImplementation(() => undefined)
      const errorSpy = spyOn(consola, "error")
      const breadcrumbSpy = spyOn(Sentry, "addBreadcrumb").mockImplementation(
        () => undefined,
      )
      const captureSpy = spyOn(Sentry, "captureException").mockImplementation(
        () => "event-id",
      )
      const sentryLogSpy = spyOn(Sentry.logger, "info")

      try {
        await responsesWebSocket.message(
          ws,
          JSON.stringify({
            type: "response.create",
            model: "gpt-5.4",
            input: "fail",
            tools: [],
          }),
        )

        const clientOutput = ws.sent.join("\n")
        expect(clientOutput).toContain("partial-output")
        expect(clientOutput).toContain("Upstream Responses stream failed.")
        expect(clientOutput).not.toContain(privateMarker)
        expect(clientOutput).not.toContain("[DONE]")

        const terminal = JSON.parse(ws.sent.at(-1) ?? "{}") as {
          code?: string
          message?: string
          param?: string | null
          response?: {
            error?: {
              code?: string
              message?: string
              param?: string | null
              status?: number
            }
            status?: string
          }
          status?: number
          type?: string
        }
        const terminalError = terminal.response?.error ?? terminal
        expect(terminalError.code).toBe("server_error")
        expect(terminalError.message).toBe("Upstream Responses stream failed.")
        expect(terminalError.param).toBe("input")
        expect(terminalError.status ?? terminal.status).toBe(502)

        const infoOutput = JSON.stringify(infoSpy.mock.calls)
        expect(infoOutput.match(/ERROR/g)).toHaveLength(1)
        expect(infoOutput).not.toContain("COMPLETE")
        const diagnostics = JSON.stringify({
          breadcrumbs: breadcrumbSpy.mock.calls,
          captured: captureSpy.mock.calls,
          consola: errorSpy.mock.calls,
          lifecycle: infoSpy.mock.calls,
          sentry: sentryLogSpy.mock.calls,
        })
        expect(diagnostics).not.toContain(privateMarker)
      } finally {
        sentryLogSpy.mockRestore()
        captureSpy.mockRestore()
        breadcrumbSpy.mockRestore()
        errorSpy.mockRestore()
        infoSpy.mockRestore()
      }
    },
  )

  test("uses the native terminal SSE event name when JSON type disagrees", async () => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    const privateMarker = "ws-mismatched-terminal-private-marker"
    queuedResponses.push(
      createResponsesTerminalSseResponse(
        "response.failed",
        privateMarker,
        "response.output_text.delta",
      ),
    )
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "fail",
        tools: [],
      }),
    )

    const terminal = JSON.parse(ws.sent.at(-1) ?? "{}") as {
      response?: Record<string, unknown>
      type?: string
    }
    expect(terminal.type).toBe("response.failed")
    expect(terminal.response).toEqual({
      id: "resp_terminal",
      object: "response",
      output: [],
      output_text: "",
      usage: null,
      error: {
        code: "server_error",
        message: "Upstream Responses stream failed.",
        param: "input",
        status: 502,
      },
      incomplete_details: null,
    })
    expect(ws.sent.join("\n")).not.toContain(privateMarker)
  })

  test.each([
    { data: "null", name: "null" },
    { data: '"ws-terminal-private-string"', name: "string" },
    { data: "17", name: "number" },
    { data: '["ws-terminal-private-array"]', name: "array" },
  ])("fails closed for native terminal $name JSON", async ({ data }) => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(createRawResponsesTerminalSseResponse(data))
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "fail",
        tools: [],
      }),
    )

    const output = ws.sent.join("\n")
    expect(output).toContain("partial-output")
    expect(output).not.toContain("ws-terminal-private")
    expect(output).not.toContain("[DONE]")
    expect(JSON.parse(ws.sent.at(-1) ?? "{}") as unknown).toEqual({
      type: "response.failed",
      sequence_number: 0,
      response: {
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
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test.each([
    { dataLine: "data:", eventType: "error" },
    { dataLine: undefined, eventType: "response.failed" },
    { dataLine: "data:", eventType: "response.incomplete" },
    { dataLine: undefined, eventType: "response.completed" },
  ])(
    "canonicalizes native $eventType with empty or missing data",
    async ({ dataLine, eventType }) => {
      state.copilotToken = "copilot-token"
      state.models = responsesCapableModels
      queuedResponses.push(
        createEmptyResponsesTerminalSseResponse(eventType, dataLine),
      )
      const ws = createTestWebSocket()

      await responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "fail",
          tools: [],
        }),
      )

      const terminal = JSON.parse(ws.sent.at(-1) ?? "{}") as { type?: string }
      expect(ws.sent.join("\n")).toContain("partial-output")
      expect(terminal.type).toBe(
        eventType === "response.completed" ? "response.failed" : eventType,
      )
      expect(ws.sent.join("\n")).toContain("Upstream Responses stream failed.")
      expect(ws.data.activeTurns.size).toBe(0)
    },
  )

  test("treats missing completed status as an error terminal", async () => {
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(
      createRawResponsesTerminalSseResponse(
        JSON.stringify({
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "resp_missing_status",
            object: "response",
            output: [],
            private: "ws-missing-status-private-marker",
          },
        }),
      ),
    )
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "fail",
        tools: [],
      }),
    )

    const terminal = JSON.parse(ws.sent.at(-1) ?? "{}") as {
      response?: { error?: { message?: string } }
      type?: string
    }
    expect(terminal.type).toBe("response.failed")
    expect(terminal.response?.error?.message).toBe(
      "Upstream Responses stream failed.",
    )
    expect(ws.sent.join("\n")).not.toContain("ws-missing-status-private-marker")
    expect(ws.data.activeTurns.size).toBe(0)
  })

  test("keeps a delivered completed frame COMPLETE when the socket closes", async () => {
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    const infoLines: Array<string> = []
    const originalConsoleInfo = console.info
    console.info = (...args: Array<unknown>) => {
      infoLines.push(args.map(String).join(" "))
    }
    queuedFetchHandlers.push(() =>
      createResponsesSseResponse("resp_close_after_complete"),
    )
    const originalSend = ws.send.bind(ws)
    ws.send = (data: string) => {
      originalSend(data)
      if (
        (JSON.parse(data) as { type?: string }).type === "response.completed"
      ) {
        queueMicrotask(() => responsesWebSocket.close(ws))
      }
    }

    try {
      await responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "finish",
          tools: [],
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        infoLines.filter((line) => line.includes("COMPLETE")),
      ).toHaveLength(1)
      expect(infoLines.some((line) => line.includes("ABORTED"))).toBe(false)
    } finally {
      // eslint-disable-next-line require-atomic-updates
      console.info = originalConsoleInfo
    }
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
  test(
    "recovers an oversized ordinary rehydrated continuation before forwarding",
    async () => {
      state.accountType = "individual"
      state.copilotToken = "copilot-token"
      state.models = responsesCapableModels
      queuedResponses.push(createResponsesSseResponse("resp_ordinary_fit"))
      const ws = createTestWebSocket()
      const preservedHistory =
        "BEGIN-ORDINARY-WS\n"
        + "x".repeat(26 * 1024 * 1024)
        + "\nEND-ORDINARY-WS"
      const inlineScreenshot = `data:image/png;base64,${"A".repeat(7 * 1024 * 1024)}`

      recordResponseSnapshotFromFrame(
        ws.data.responseSnapshots,
        {
          model: "gpt-5.4",
          input: [
            {
              type: "function_call_output",
              call_id: "call_ws_history",
              output: preservedHistory,
              internal_chat_message_metadata_passthrough: {
                turn_id: "turn_history",
              },
            },
          ],
          stream: true,
        },
        JSON.stringify({
          type: "response.completed",
          response: { id: "resp_before_ordinary", output: [] },
        }),
      )

      await responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          previous_response_id: "resp_before_ordinary",
          input: [
            {
              type: "function_call_output",
              call_id: "call_ws_current",
              output: [
                {
                  type: "computer_screenshot",
                  image_url: inlineScreenshot,
                },
              ],
              internal_chat_message_metadata_passthrough: {
                turn_id: "turn_current",
              },
            },
          ],
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              request_kind: "turn",
              turn_id: "turn_current",
            }),
          },
        }),
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const serialized = JSON.stringify(lastRequestBody)
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
        CAPI_RESPONSES_MAX_REQUEST_BYTES - RESPONSES_RECOVERY_MARGIN_BYTES,
      )
      expect(serialized).toContain("BEGIN-ORDINARY-WS")
      expect(serialized).toContain("END-ORDINARY-WS")
      expect(serialized).toContain("call_ws_current")
      expect(serialized).not.toContain(inlineScreenshot)
      expect(serialized).toContain(
        "omitted to fit the CAPI Responses request-size limit",
      )
      expect(lastRequestBody?.previous_response_id).toBeUndefined()
    },
    { timeout: 15_000 },
  )

  test("fits a rehydrated pre-compaction continuation before forwarding", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    queuedResponses.push(createResponsesSseResponse("resp_compaction_fit"))
    const ws = createTestWebSocket()
    const oversizedLength = COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024
    const originalLargeOutput =
      "BEGIN-WEBSOCKET\n" + "x".repeat(oversizedLength) + "\nEND-WEBSOCKET"

    recordResponseSnapshotFromFrame(
      ws.data.responseSnapshots,
      {
        model: "gpt-5.4",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_websocket",
            name: "exec",
            input: "run diagnostic",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_websocket",
            output: originalLargeOutput,
          },
        ],
        stream: true,
      },
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_before_compaction",
          output: [],
        },
      }),
    )

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        previous_response_id: "resp_before_compaction",
        input: [],
        tools: [],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
      }),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(lastRequestBody)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
      COMPACTION_PAYLOAD_MAX_BYTES,
    )
    expect(serialized).toContain("run diagnostic")
    expect(serialized).toContain("call_websocket")
    expect(serialized).toContain("BEGIN-WEBSOCKET")
    expect(serialized).toContain("END-WEBSOCKET")
    expect(serialized).toContain("UTF-8 bytes omitted during compaction")
    expect(originalLargeOutput).toHaveLength(
      oversizedLength + "BEGIN-WEBSOCKET\n".length + "\nEND-WEBSOCKET".length,
    )
  })

  test("rejects preserved-text-only compaction payloads locally", async () => {
    state.accountType = "individual"
    state.copilotToken = "copilot-token"
    state.models = responsesCapableModels
    const ws = createTestWebSocket()
    const preservedContent = "preserved-context-".repeat(
      Math.ceil((COMPACTION_PAYLOAD_MAX_BYTES + 1024) / 18),
    )

    recordResponseSnapshotFromFrame(
      ws.data.responseSnapshots,
      {
        model: "gpt-5.4",
        input: [
          {
            type: "message",
            role: "developer",
            content: preservedContent,
          },
        ],
        stream: true,
      },
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_preserved_only", output: [] },
      }),
    )

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        previous_response_id: "resp_preserved_only",
        input: [],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
      }),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    const errorFrame = JSON.parse(ws.sent[0] ?? "{}") as {
      error?: { code?: string; message?: string }
      status?: number
      type?: string
    }
    expect(errorFrame.type).toBe("error")
    expect(errorFrame.status).toBe(413)
    expect(errorFrame.error?.code).toBe("request_too_large")
    expect(errorFrame.error?.message).toContain(
      "safe compaction payload budget",
    )
  })

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

  test.each([
    {
      name: "stateful control",
      configure: () => {
        state.models = responsesCapableModels
      },
      payload: { store: true },
      code: "unsupported_value",
    },
    {
      name: "blocked tool",
      configure: () => {
        state.models = responsesCapableModels
      },
      payload: { tools: [{ type: "code_interpreter" }] },
      code: "unsupported_value",
    },
    {
      name: "missing endpoint",
      configure: () => {
        state.models = {
          ...responsesCapableModels,
          data: responsesCapableModels.data.map((model) => ({
            ...model,
            supported_endpoints: [],
          })),
        }
      },
      payload: {},
      code: "endpoint_translation_unsupported",
    },
  ])(
    "rejects warmup $name before success",
    async ({ configure, payload, code }) => {
      configure()
      const ws = createTestWebSocket()

      await responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "warmup",
          generate: false,
          ...payload,
        }),
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(ws.data.closed).toBe(false)
      expect(ws.sent).toHaveLength(1)
      expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
        type: "error",
        status: 400,
        error: { code },
      })
    },
  )

  test("selects a Messages-only warmup without dispatching upstream", async () => {
    state.models = {
      ...responsesCapableModels,
      data: responsesCapableModels.data.map((model) => ({
        ...model,
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
      })),
    }
    const ws = createTestWebSocket()

    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "warmup",
        generate: false,
        tools: [],
        tool_choice: "none",
        reasoning: { effort: "none" },
      }),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ws.sent.some((frame) => frame.includes("response.completed"))).toBe(
      true,
    )
    const snapshot = ws.data.responseSnapshots.values().next().value
    expect(snapshot).toMatchObject({ model: "gpt-5.4", stream: true })
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

  test("retains continuation snapshots without local eviction", () => {
    const snapshots = new Map<string, ResponsesPayload>()
    for (let index = 0; index < 34; index += 1) {
      recordResponseSnapshotFromFrame(
        snapshots,
        { input: `input-${index}`, model: "gpt-5.4" },
        JSON.stringify({
          type: "response.completed",
          response: { id: `resp_${index}`, output: [] },
        }),
      )
    }
    expect(snapshots).toHaveLength(34)
    expect(snapshots.has("resp_0")).toBe(true)
    expect(snapshots.has("resp_33")).toBe(true)
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
      activeTurns: new Map(),
      closed: false,
      nextTurnSequence: 0,
      type: "responses",
      requestId: "req-test",
      affinity: { key: "session-test", source: "claude_session" },
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

function createChatCompletionsSseResponse(): Response {
  const content = JSON.stringify({
    id: "chatcmpl_ws",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "Hello" },
        finish_reason: null,
      },
    ],
  })
  const done = JSON.stringify({
    id: "chatcmpl_ws",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.4",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })
  return new Response(`data: ${content}\n\ndata: ${done}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  })
}

function createResponsesTerminalSseResponse(
  type: string,
  message: string,
  jsonType = type,
): Response {
  const delta = {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_terminal",
    output_index: 0,
    content_index: 0,
    delta: "partial-output",
  }
  const responseStatus =
    type === "response.failed" || type === "response.completed" ?
      "failed"
    : "incomplete"
  const frame =
    type === "error" ?
      {
        type: jsonType,
        message,
        code: "server_error",
        param: "input",
        status: 502,
        sequence_number: 2,
      }
    : {
        type: jsonType,
        sequence_number: 2,
        response: {
          id: "resp_terminal",
          object: "response",
          status: responseStatus,
          output: [
            {
              id: "msg_terminal",
              type: "message",
              role: "assistant",
              status: "incomplete",
              content: [
                {
                  type: "output_text",
                  text: "partial-output",
                  annotations: [],
                },
              ],
            },
          ],
          error: {
            code: "server_error",
            message,
            param: "input",
            status: 502,
            private: message,
          },
          message,
          metadata: { private: message },
          incomplete_details: { private: message },
          prompt_cache_key: message,
        },
        private: message,
      }
  return new Response(
    `event: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\n`
      + `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    },
  )
}

function createRawResponsesTerminalSseResponse(data: string): Response {
  const delta = JSON.stringify({
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_terminal",
    output_index: 0,
    content_index: 0,
    delta: "partial-output",
  })
  return new Response(
    `event: response.output_text.delta\ndata: ${delta}\n\n`
      + `event: response.completed\ndata: ${data}\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

function createEmptyResponsesTerminalSseResponse(
  eventType: string,
  dataLine: string | undefined,
): Response {
  const delta = JSON.stringify({
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_terminal",
    output_index: 0,
    content_index: 0,
    delta: "partial-output",
  })
  const terminal = [
    `event: ${eventType}`,
    ...(dataLine === undefined ? [] : [dataLine]),
    "",
    "",
  ].join("\n")
  return new Response(
    `event: response.output_text.delta\ndata: ${delta}\n\n${terminal}`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for test condition")
}
