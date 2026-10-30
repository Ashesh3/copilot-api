import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { getLlmDebugLog, listLlmDebugLogs } from "~/lib/llm-debug-log"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import {
  closeStorageRuntime,
  getStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"
import { createHistoryRuntime } from "~/lib/telemetry-writer"
import { tokenPool } from "~/lib/token-pool"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

type Transport = "HTTP JSON" | "HTTP SSE" | "WebSocket"
type Frame = Record<string, unknown>
interface ClientResponse {
  body: string
  frames: Array<Frame>
  response: Frame | undefined
  headers: Headers
  status: number
}

const transports: Array<Transport> = ["HTTP JSON", "HTTP SSE", "WebSocket"]
const sourceModel = "claude-opus-5.5"
const firstFallback = "claude-opus-5"
const rememberedModel = "claude-opus-4.8"
const unavailableModel = "claude-opus-4.7"
const targetModel = "claude-sonnet-5.5"
const ownerId = 17
const otherId = 23
const originalFetch = globalThis.fetch
const originalState = { ...state }
const calls: Array<{ body: Frame; authorization: string | null }> = []
const sockets: Array<{ data: ResponsesWebSocketData }> = []
let upstreamReply: (body: Frame, index: number) => Response

beforeEach(() => {
  calls.length = 0
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  configureChain([
    sourceModel,
    firstFallback,
    rememberedModel,
    unavailableModel,
    targetModel,
  ])
  Object.assign(state, {
    accountType: "individual",
    apiKeyAuth: PROTOCOL_GATEWAY_KEY,
    copilotToken: undefined,
    githubToken: undefined,
    isMultiToken: true,
    manualApprove: false,
  })
  installAccount(ownerId, [
    sourceModel,
    firstFallback,
    rememberedModel,
    targetModel,
  ])
  installAccount(otherId, [targetModel])
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  upstreamReply = (body, index) =>
    messageResponse(body, index, body.model !== targetModel)
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/v1/messages" || typeof init?.body !== "string")
      throw new Error("Unexpected upstream request")
    const body = JSON.parse(init.body) as Frame
    calls.push({
      body,
      authorization: new Headers(init.headers).get("authorization"),
    })
    return Promise.resolve(upstreamReply(body, calls.length))
  }) as typeof fetch
})

afterEach(() => {
  for (const socket of sockets.splice(0)) responsesWebSocket.close(socket)
  globalThis.fetch = originalFetch
  for (const account of tokenPool.getAllAccounts())
    tokenPool.deleteAccount(account.id)
  Object.assign(state, originalState)
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setConfigForTest(null)
})

test.each(transports)(
  "%s skips a missing hop after a remembered refusal and preserves the owner on continuation",
  async (transport) => {
    let rememberedCalls = 0
    upstreamReply = (body, index) => {
      const refused =
        body.model === sourceModel
        || body.model === firstFallback
        || (body.model === rememberedModel && rememberedCalls++ > 0)
      return messageResponse(body, index, refused)
    }
    const client = await createClient(transport)
    const first = await client.send()
    expect(first.status).toBe(200)
    expect(first.response).toMatchObject({
      status: "completed",
      model: sourceModel,
    })
    expect(calls.map((call) => call.body.model)).toEqual([
      sourceModel,
      firstFallback,
      rememberedModel,
    ])
    expect(await storedTargets()).toEqual([rememberedModel])
    expect(await owners()).toEqual([ownerId])

    const fallback = await client.send(continuation(transport, first))
    expect(fallback.status).toBe(200)
    expect(fallback.response).toMatchObject({
      status: "completed",
      model: sourceModel,
      output_text: `answer from ${targetModel}`,
    })
    expect(fallback.body).not.toContain(unavailableModel)
    expect(fallback.body).not.toContain("refused answer")
    expect(fallback.headers.get("x-copilot-api-fallback-to")).toBe(targetModel)
    expect(fallback.headers.get("x-copilot-api-fallback-reason")).toBe(
      "refusal",
    )
    const entries = (await listLlmDebugLogs()).entries
    const served = entries.find((entry) => entry.model === targetModel)
    expect((await getLlmDebugLog(served?.id ?? ""))?.fallback).toMatchObject({
      reason: "refusal",
      fromModel: rememberedModel,
      targetModel,
    })
    expect(await storedTargets()).toEqual([targetModel])
    expect(await owners()).toEqual([ownerId])

    const next = await client.send(continuation(transport, fallback))
    expect(next.response).toMatchObject({
      status: "completed",
      model: sourceModel,
    })
    expect(next.headers.get("x-copilot-api-fallback-cached")).toBe("true")
    expect(next.headers.get("x-copilot-api-fallback-reason")).toBe("refusal")
    expect(JSON.stringify(calls.at(-1)?.body)).toContain(
      `${targetModel}-signature`,
    )
    const { config } = getStorageRuntime()
    await closeStorageRuntime()
    const runtime = await initializeStorageRuntime({ config })
    await createHistoryRuntime(runtime.storage, { autoFlush: false })
    const reopened = await createClient(transport)
    const restored = await reopened.send()
    expect(restored.response).toMatchObject({
      status: "completed",
      model: sourceModel,
    })
    expect(restored.headers.get("x-copilot-api-fallback-cached")).toBe("true")
    expect(restored.headers.get("x-copilot-api-fallback-reason")).toBe(
      "refusal",
    )
    expect(calls.map((call) => call.body.model)).toEqual([
      sourceModel,
      firstFallback,
      rememberedModel,
      rememberedModel,
      targetModel,
      targetModel,
      targetModel,
    ])
    expect(calls.map((call) => call.authorization)).toEqual(
      Array.from({ length: 7 }, () => "Bearer owner-17-copilot-token"),
    )
    // Only the Claude 5.5 hops are asked for progress updates.
    expect(
      calls.map((call) => (call.body.thinking as Frame | undefined)?.display),
    ).toEqual([
      "updates",
      undefined,
      undefined,
      undefined,
      "updates",
      "updates",
      "updates",
    ])
    expect(await owners()).toEqual([ownerId])
  },
)

test.each(transports)(
  "%s skips consecutive unavailable targets without dispatching them",
  async (transport) => {
    configureChain([
      sourceModel,
      "missing-first",
      unavailableModel,
      targetModel,
    ])
    const client = await createClient(transport)
    const response = await client.send()
    expect(response.status).toBe(200)
    expect(response.response).toMatchObject({
      status: "completed",
      model: sourceModel,
      output_text: `answer from ${targetModel}`,
    })
    expect(calls.map((call) => call.body.model)).toEqual([
      sourceModel,
      targetModel,
    ])
    expect(response.body).not.toContain("missing-first")
    expect(response.body).not.toContain(unavailableModel)
    expect(response.body).not.toContain("refused answer")
    expect(await storedTargets()).toEqual([targetModel])
    expect(await owners()).toEqual([ownerId])
  },
)

test.each(
  transports.flatMap((transport) =>
    ["refusal", "http_422"].map((reason) => ({ transport, reason })),
  ),
)(
  "$transport preserves the original $reason when every remaining target is unavailable",
  async ({ transport, reason }) => {
    configureChain([sourceModel, "missing-first", unavailableModel])
    upstreamReply = (body, index) =>
      reason === "refusal" ?
        messageResponse(body, index, true)
      : new Response("original upstream rejection", { status: 422 })
    const client = await createClient(transport)
    for (let turn = 0; turn < 2; turn++) {
      const response = await client.send()
      if (reason === "refusal") {
        expect(response.status).toBe(200)
        expect(response.response).toMatchObject({
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        })
        expect(response.body).toContain("refused answer")
      } else {
        expect(response.status).toBe(422)
        if (transport === "WebSocket") {
          const error = response.frames.at(-1)?.error as Frame
          expect(
            Buffer.from(error.upstream_body as Array<number>).toString("utf8"),
          ).toBe("original upstream rejection")
        } else expect(response.body).toContain("original upstream rejection")
      }
      expect(response.body).not.toContain("conversation_account_unavailable")
      expect(response.body).not.toContain(unavailableModel)
      expect(response.headers.get("x-copilot-api-fallback-to")).toBeNull()
    }
    expect(calls.map((call) => call.body.model)).toEqual([
      sourceModel,
      sourceModel,
    ])
    expect(await storedTargets()).toEqual([])
    expect(await owners()).toEqual([ownerId])
  },
)

test("a remembered target that loses all providers advances without sending another request to it", async () => {
  configureChain([sourceModel, rememberedModel, unavailableModel, targetModel])
  upstreamReply = (body, index) =>
    messageResponse(body, index, body.model === sourceModel)
  const client = await createClient("HTTP JSON")
  expect((await client.send()).response).toMatchObject({ status: "completed" })
  expect(await storedTargets()).toEqual([rememberedModel])
  const account = tokenPool
    .getAllAccounts()
    .find((entry) => entry.id === ownerId)
  if (!account) throw new Error("Missing owner fixture")
  account.models.delete(rememberedModel)
  account.modelsData = account.modelsData.filter(
    (entry) => entry.id !== rememberedModel,
  )
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  const response = await client.send()
  expect(response.status).toBe(200)
  expect(response.response).toMatchObject({
    status: "completed",
    output_text: `answer from ${targetModel}`,
  })
  expect(response.headers.get("x-copilot-api-fallback-cached")).toBe("true")
  expect(calls.map((call) => call.body.model)).toEqual([
    sourceModel,
    rememberedModel,
    targetModel,
  ])
  expect(await storedTargets()).toEqual([targetModel])
  expect(await owners()).toEqual([ownerId])
})

test("a fallback model switch reassigns the conversation to an account that serves it", async () => {
  configureChain([sourceModel, unavailableModel, targetModel])
  installAccount(otherId, [unavailableModel, targetModel])
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  upstreamReply = (body, index) =>
    messageResponse(body, index, index > 1 && body.model !== targetModel)
  const client = await createClient("HTTP JSON")
  expect((await client.send()).response).toMatchObject({ status: "completed" })
  expect(await owners()).toEqual([ownerId])
  expect(await storedTargets()).toEqual([])

  const response = await client.send()
  expect(response.status).toBe(200)
  expect(response.response).toMatchObject({
    status: "completed",
    model: sourceModel,
    output_text: `answer from ${targetModel}`,
  })
  expect(response.headers.get("x-copilot-api-fallback-to")).toBe(targetModel)
  expect(calls.map((call) => call.body.model)).toEqual([
    sourceModel,
    sourceModel,
    unavailableModel,
    targetModel,
  ])
  expect(calls.map((call) => call.authorization)).toEqual([
    "Bearer owner-17-copilot-token",
    "Bearer owner-17-copilot-token",
    "Bearer owner-23-copilot-token",
    "Bearer owner-23-copilot-token",
  ])
  expect(await storedTargets()).toEqual([targetModel])
  expect(await owners()).toEqual([otherId])
})

test("an unavailable redirect follows its resolved model's fallback with effort and verbosity intact", async () => {
  const nativeTarget = "gpt-5.4"
  const account = tokenPool
    .getAllAccounts()
    .find((entry) => entry.id === ownerId)
  if (!account) throw new Error("Missing owner fixture")
  account.models.add(nativeTarget)
  account.modelsData.push({
    ...model(nativeTarget),
    supported_endpoints: ["/responses"],
  })
  tokenPool.rebuildModelIndex()
  state.models = tokenPool.getAllModels()
  setModelFallbackConfigForTest({
    enabled: true,
    notifyClient: true,
    nativeClientNotice: false,
    rules: [
      {
        id: "configured",
        sourceModel,
        targetModel: "missing-alias",
        enabled: true,
      },
      {
        id: "resolved",
        sourceModel: unavailableModel,
        targetModel: nativeTarget,
        enabled: true,
      },
    ],
  })
  setModelRedirectsForTest([
    {
      id: "missing-redirect",
      sourceModel: "missing-alias",
      sourceEffort: "all",
      targetModel: unavailableModel,
      targetEffort: "high",
      targetVerbosity: "low",
      enabled: true,
    },
  ])
  const copilotFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/responses") return copilotFetch(input, init)
    if (typeof init?.body !== "string")
      throw new Error("Expected Responses body")
    calls.push({
      body: JSON.parse(init.body) as Frame,
      authorization: new Headers(init.headers).get("authorization"),
    })
    return Promise.resolve(
      Response.json({
        id: `resp_native_${calls.length}`,
        object: "response",
        model: nativeTarget,
        status: "completed",
        output: [],
        output_text: "native answer",
        usage: null,
      }),
    )
  }) as typeof fetch
  const client = await createClient("HTTP JSON")
  for (let turn = 0; turn < 2; turn++) {
    const response = await client.send({
      reasoning: { effort: "low" },
      text: { verbosity: "high" },
    })
    expect(response.status).toBe(200)
    expect(response.response).toMatchObject({
      status: "completed",
      model: sourceModel,
    })
    expect(calls.at(-1)?.body.reasoning).toMatchObject({ effort: "high" })
    expect(calls.at(-1)?.body.text).toMatchObject({ verbosity: "low" })
    expect(response.body).not.toContain(unavailableModel)
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    sourceModel,
    nativeTarget,
    nativeTarget,
  ])
  expect(await owners()).toEqual([ownerId])
})

test("missing and embedding-only hops advance to a custom chat alias and remember it", async () => {
  configureChain([
    sourceModel,
    "missing-first",
    "embedding-only",
    "custom-alias",
  ])
  setConfigForTest({
    customProviders: [
      {
        id: "fallback-custom",
        name: "Fallback custom",
        type: "openai-compatible",
        baseUrl: "https://custom-fallback.example/v1",
        apiKey: "custom-fixture-key",
        models: [
          { id: "embedding-only", kind: "embedding" },
          {
            id: "custom-target",
            aliases: ["custom-alias"],
            kind: "chat",
            supportsStreaming: false,
          },
        ],
      },
    ],
  })
  const copilotFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== "custom-fallback.example")
      return copilotFetch(input, init)
    if (
      url.pathname !== "/v1/chat/completions"
      || typeof init?.body !== "string"
    )
      throw new Error("Unexpected custom request")
    calls.push({
      body: JSON.parse(init.body) as Frame,
      authorization: new Headers(init.headers).get("authorization"),
    })
    return Promise.resolve(
      Response.json({
        id: `chat_custom_${calls.length}`,
        object: "chat.completion",
        created: 1,
        model: "custom-target",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "custom answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    )
  }) as typeof fetch
  const client = await createClient("HTTP JSON")
  for (let turn = 0; turn < 2; turn++) {
    const response = await client.send()
    expect(response.status).toBe(200)
    expect(response.response).toMatchObject({
      status: "completed",
      model: sourceModel,
      output_text: "custom answer",
    })
    expect(response.body).not.toContain("embedding-only")
    expect(calls.at(-1)?.authorization).toBe("Bearer custom-fixture-key")
  }
  expect(calls.map((call) => call.body.model)).toEqual([
    sourceModel,
    "custom-target",
    "custom-target",
  ])
  expect(await storedTargets()).toEqual(["custom-alias"])
  expect(await owners()).toEqual([ownerId])
})

function configureChain(models: Array<string>): void {
  setModelFallbackConfigForTest({
    enabled: true,
    notifyClient: true,
    nativeClientNotice: false,
    rules: models.slice(1).map((target, index) => ({
      id: `hop-${index}`,
      sourceModel: models[index],
      targetModel: target,
      enabled: true,
    })),
  })
}

function installAccount(id: number, models: Array<string>): void {
  const account = tokenPool.addAccount(
    `owner-${id}-github-token`,
    "individual",
    id,
  )
  account.copilotToken = `owner-${id}-copilot-token`
  account.healthy = true
  account.models = new Set(models)
  account.modelsData = models.map((id) => model(id))
}

function model(id: string): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: ["/v1/messages"],
    capabilities: {
      family: "claude",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function messageResponse(
  body: Frame,
  index: number,
  refused: boolean,
): Response {
  const modelId = String(body.model)
  // Under display updates thinking text is narration for the user. These
  // turns narrate nothing, so only their signed reasoning comes back.
  const thinking =
    (body.thinking as Frame | undefined)?.display === "updates" ?
      ""
    : `thought from ${modelId}`
  return Response.json({
    id: `msg_${index}`,
    type: "message",
    role: "assistant",
    model: modelId,
    content: [
      {
        type: "thinking",
        thinking,
        signature: `${modelId}-signature`,
      },
      {
        type: "text",
        text: refused ? "refused answer" : `answer from ${modelId}`,
      },
    ],
    stop_reason: refused ? "refusal" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 1 },
  })
}

async function owners(): Promise<Array<unknown>> {
  const rows = await getStorageRuntime().storage.read((session) =>
    session.query({
      sql: "SELECT account_id FROM capi_conversation_accounts",
      args: [],
    }),
  )
  return rows.map((row) => row.account_id)
}

async function storedTargets(): Promise<Array<unknown>> {
  const rows = await getStorageRuntime().storage.read((session) =>
    session.query({
      sql: "SELECT target_model FROM capi_conversation_models",
      args: [],
    }),
  )
  return rows.map((row) => row.target_model)
}

function continuation(transport: Transport, response: ClientResponse): Frame {
  if (transport === "WebSocket")
    return { previous_response_id: response.response?.id, input: "continue" }
  return {
    input: [
      ...(response.response?.output as Array<Frame>),
      { type: "message", role: "user", content: "continue" },
    ],
  }
}

function parseFrames(body: string): Array<Frame> {
  return body
    .split(/\r?\n\r?\n/u)
    .flatMap((frame) =>
      frame.split(/\r?\n/u).filter((line) => line.startsWith("data:")),
    )
    .map((line) => JSON.parse(line.slice(5).trimStart()) as Frame)
}

function frameHeaders(frames: Array<Frame>): Headers {
  const headers = new Headers()
  for (const frame of frames) {
    if (typeof frame.headers !== "object" || frame.headers === null) continue
    for (const [key, value] of Object.entries(frame.headers))
      if (typeof value === "string") headers.set(key, value)
  }
  return headers
}

async function createClient(transport: Transport) {
  const headers = {
    authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
    "session-id": "unavailable-fallback-session",
    "thread-id": "unavailable-fallback-thread",
  }
  await seedProtocolDatabase()
  if (transport !== "WebSocket") {
    return {
      async send(payload: Frame = {}): Promise<ClientResponse> {
        await seedProtocolDatabase()
        const response = await server.request("/v1/responses", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            model: sourceModel,
            input: "hello",
            stream: transport === "HTTP SSE",
            ...payload,
          }),
        })
        const body = await response.text()
        const streaming = response.headers
          .get("content-type")
          ?.includes("text/event-stream")
        const frames = streaming ? parseFrames(body) : []
        let result: Frame | undefined
        if (streaming) result = frames.at(-1)?.response as Frame | undefined
        else if (response.ok) result = JSON.parse(body) as Frame
        return {
          body,
          frames,
          response: result,
          headers: response.headers,
          status: response.status,
        }
      },
    }
  }
  let data: ResponsesWebSocketData | undefined
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/v1/responses", { headers }),
    {
      upgrade(_request, options) {
        data = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    },
  )
  if (!data) throw new Error("Expected authenticated WebSocket upgrade")
  const frames: Array<Frame> = []
  const socket = {
    data,
    send(frame: string) {
      frames.push(JSON.parse(frame) as Frame)
    },
    close() {},
  }
  sockets.push(socket)
  return {
    async send(payload: Frame = {}): Promise<ClientResponse> {
      const start = frames.length
      await responsesWebSocket.message(
        socket,
        JSON.stringify({
          type: "response.create",
          model: sourceModel,
          input: "hello",
          ...payload,
        }),
      )
      const received = frames.slice(start)
      const error = received.find((frame) => frame.type === "error")
      return {
        body: JSON.stringify(received),
        frames: received,
        response: received.at(-1)?.response as Frame | undefined,
        headers: frameHeaders(received),
        status: error ? Number(error.status) : 200,
      }
    },
  }
}
