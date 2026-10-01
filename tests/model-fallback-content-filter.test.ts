import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { getLlmDebugLog, listLlmDebugLogs } from "~/lib/llm-debug-log"
import {
  getLoadedModelFallbackConfig,
  setModelFallbackConfigForTest,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import {
  closeStorageRuntime,
  getStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"
import { createHistoryRuntime } from "~/lib/telemetry-writer"
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

type Transport = "HTTP" | "WebSocket"
const transports: Array<Transport> = ["HTTP", "WebSocket"]
type Frame = Record<string, unknown>
type UpstreamReply = (
  body: Record<string, unknown>,
  index: number,
  signal: AbortSignal | undefined,
) => Response | Promise<Response>

const sourceModel = "claude-opus-5.5"
const middleModel = "claude-sonnet-4.5"
const targetModel = "claude-opus-5"
const originalFetch = globalThis.fetch
const originalState = { ...state }
const calls: Array<Record<string, unknown>> = []
const paths: Array<string> = []
const sockets: Array<{ data: ResponsesWebSocketData }> = []
let upstreamReply: UpstreamReply

beforeEach(() => {
  calls.length = 0
  paths.length = 0
  setConfigForTest({})
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest({
    enabled: true,
    notifyClient: true,
    nativeClientNotice: false,
    rules: [{ id: "refusal", sourceModel, targetModel, enabled: true }],
  })
  Object.assign(state, {
    accountType: "individual",
    apiKeyAuth: PROTOCOL_GATEWAY_KEY,
    copilotToken: "refusal-test-copilot-token",
    githubToken: "refusal-test-github-token",
    isMultiToken: false,
    manualApprove: false,
    models: {
      object: "list",
      data: [sourceModel, middleModel, targetModel].map((id) => model(id)),
    },
  })
  upstreamReply = (body, index) =>
    body.model === sourceModel ?
      refusedResponse(sourceModel, index)
    : completedResponse(String(body.model), index)
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/v1/messages" || typeof init?.body !== "string")
      throw new Error("Unexpected upstream request")
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push(body)
    paths.push(url.pathname)
    return Promise.resolve(
      upstreamReply(body, calls.length, init.signal ?? undefined),
    )
  }) as typeof fetch
})

afterEach(() => {
  for (const socket of sockets.splice(0)) responsesWebSocket.close(socket)
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test.each(
  transports.flatMap((transport) =>
    [false, true].map((withContent) => ({ transport, withContent })),
  ),
)(
  "$transport retries an Opus refusal with buffered content=$withContent before emitting Responses output",
  async ({ transport, withContent }) => {
    upstreamReply = (body, index) =>
      body.model === sourceModel ?
        refusedResponse(sourceModel, index, withContent)
      : completedResponse(String(body.model), index)
    const client = await createClient(transport, childHeaders)
    const response = await client.send({ input: reasoningInput() })
    expect(calls.map((call) => call.model)).toEqual([sourceModel, targetModel])
    expect(paths).toEqual(["/v1/messages", "/v1/messages"])
    for (const call of calls) {
      expect(call.stream).toBe(false)
      expect(Array.isArray(call.messages)).toBe(true)
      expect(call.max_tokens).toBeGreaterThan(0)
    }
    expect(response.frames[0]?.type).toBe("response.created")
    expect(response.frames.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        model: sourceModel,
        status: "completed",
        output_text: "fallback answer",
      },
    })
    expect(
      response.frames.filter((frame) => frame.type === "response.created"),
    ).toHaveLength(1)
    expect(response.body).not.toContain("msg_rejected_")
    expect(response.body).not.toContain("source refusal")
    expect(response.body).not.toContain("response.incomplete")
    expect(JSON.stringify(calls[0])).toContain("source-history-signature")
    expect(JSON.stringify(calls[1])).not.toContain("source history thought")
    expect(JSON.stringify(calls[1])).not.toContain("source-history-signature")
    expect(response.headers.get("x-copilot-api-fallback-reason")).toBe(
      "refusal",
    )
    const entries = (await listLlmDebugLogs()).entries
    const rejected = entries.find((entry) => entry.model === sourceModel)
    const accepted = entries.find((entry) => entry.model === targetModel)
    expect(accepted?.fallback).toMatchObject({
      reason: "refusal",
      sourceModel,
      targetModel,
      cached: false,
      hop: 1,
    })
    expect(rejected).toMatchObject({ responseStatus: 200 })
    expect(
      (await getLlmDebugLog(rejected?.id ?? ""))?.response?.body,
    ).toContain('"stop_reason":"refusal"')
  },
)

test.each(transports)(
  "%s preserves the stored refusal reason and target thinking after reopening SQLite",
  async (transport) => {
    const first = await createClient(transport)
    const original = await first.send({ input: reasoningInput() })
    expect(original.frames.at(-1)?.type).toBe("response.completed")
    const output = (original.frames.at(-1)?.response as Frame)
      .output as Array<Frame>
    const { config } = getStorageRuntime()
    await closeStorageRuntime()
    const runtime = await initializeStorageRuntime({ config })
    await createHistoryRuntime(runtime.storage, { autoFlush: false })
    const resumed = await createClient(transport)
    const response = await resumed.send({
      input: [
        ...reasoningInput(),
        ...output,
        { type: "message", role: "user", content: "next" },
      ],
    })
    expect(calls.map((call) => call.model)).toEqual([
      sourceModel,
      targetModel,
      targetModel,
    ])
    expect(response.frames.at(-1)?.type).toBe("response.completed")
    expect(response.headers.get("x-copilot-api-fallback-reason")).toBe(
      "refusal",
    )
    expect(response.headers.get("x-copilot-api-fallback-cached")).toBe("true")
    expect(JSON.stringify(calls[2])).not.toContain("source history thought")
    expect(JSON.stringify(calls[2])).not.toContain("source-history-signature")
    expect(JSON.stringify(calls[2])).toContain("target history thought")
    expect(JSON.stringify(calls[2])).toContain("target-history-signature")
    expect((await listLlmDebugLogs()).entries[0]?.fallback).toMatchObject({
      reason: "refusal",
      sourceModel,
      targetModel,
      cached: true,
    })
  },
)

test.each([
  { transport: "HTTP", first: "refusal", second: "http_422" },
  { transport: "WebSocket", first: "refusal", second: "http_422" },
  { transport: "HTTP", first: "http_422", second: "refusal" },
  { transport: "WebSocket", first: "http_422", second: "refusal" },
] as const)(
  "$transport follows $first then $second with the correct reason for each hop",
  async ({ transport, first, second }) => {
    setModelFallbackConfigForTest({
      ...getLoadedModelFallbackConfig(),
      rules: [
        { id: "first", sourceModel, targetModel: middleModel, enabled: true },
        { id: "second", sourceModel: middleModel, targetModel, enabled: true },
      ],
    })
    upstreamReply = (body, index) => {
      if (body.model === targetModel)
        return completedResponse(targetModel, index)
      const reason = body.model === sourceModel ? first : second
      return reason === "http_422" ?
          new Response("upstream rejected", { status: 422 })
        : refusedResponse(String(body.model), index)
    }
    const client = await createClient(transport)
    const response = await client.send()
    expect(calls.map((call) => call.model)).toEqual([
      sourceModel,
      middleModel,
      targetModel,
    ])
    expect(response.frames.at(-1)?.type).toBe("response.completed")
    expect(response.body).not.toContain("msg_rejected_")
    expect(response.body).not.toContain("source refusal")
    expect(response.headers.get("x-copilot-api-fallback-reason")).toBe(second)
    const entries = (await listLlmDebugLogs()).entries
    expect(
      entries.find((entry) => entry.model === middleModel)?.fallback,
    ).toMatchObject({
      reason: first,
      sourceModel,
      fromModel: sourceModel,
      targetModel: middleModel,
      hop: 1,
      cached: false,
    })
    expect(
      entries.find((entry) => entry.model === targetModel)?.fallback,
    ).toMatchObject({
      reason: second,
      sourceModel,
      fromModel: middleModel,
      targetModel,
      hop: 2,
      cached: false,
    })
    const next = await client.send({ input: "next" })
    expect(calls.at(-1)?.model).toBe(targetModel)
    expect(next.headers.get("x-copilot-api-fallback-reason")).toBe(second)
    expect(next.headers.get("x-copilot-api-fallback-cached")).toBe("true")
  },
)

const childHeaders = {
  "thread-id": "child-thread",
  "x-codex-parent-thread-id": "parent-thread",
  "x-openai-subagent": "collab_spawn",
}

test.each(transports)(
  "%s keeps parent, child and sibling routes separate while the same child continues",
  async (transport) => {
    const client = await createClient(transport)
    await client.send()
    const child = await client.send({ input: reasoningInput() }, childHeaders)
    expect(child.frames.at(-1)?.type).toBe("response.completed")
    const completed = child.frames.at(-1)?.response as Frame
    const continuation =
      transport === "WebSocket" ?
        { previous_response_id: completed.id, input: "child continues" }
      : {
          input: [
            ...reasoningInput(),
            ...(completed.output as Array<Frame>),
            { type: "message", role: "user", content: "child continues" },
          ],
        }
    const continued = await client.send(continuation, childHeaders)
    const sibling = await client.send(
      { input: "sibling begins" },
      { ...childHeaders, "thread-id": "sibling-thread" },
    )
    const parent = await client.send({ input: "parent continues" })
    expect(calls.map((call) => call.model)).toEqual([
      sourceModel,
      targetModel,
      sourceModel,
      targetModel,
      targetModel,
      sourceModel,
      targetModel,
      targetModel,
    ])
    expect(continued.headers.get("x-copilot-api-fallback-cached")).toBe("true")
    expect(sibling.headers.get("x-copilot-api-fallback-cached")).toBe("false")
    expect(parent.headers.get("x-copilot-api-fallback-cached")).toBe("true")
    expect(JSON.stringify(calls[3])).not.toContain("source-history-signature")
    expect(JSON.stringify(calls[4])).not.toContain("source-history-signature")
    expect(JSON.stringify(calls[4])).toContain("target-history-signature")
    for (const response of [child, continued, sibling, parent]) {
      expect(response.frames.at(-1)?.type).toBe("response.completed")
      expect(response.body).not.toContain("msg_rejected_")
    }
  },
)

test.each([
  { transport: "HTTP", reason: "max_tokens", terminal: "response.incomplete" },
  {
    transport: "WebSocket",
    reason: "max_tokens",
    terminal: "response.incomplete",
  },
  { transport: "HTTP", reason: "end_turn", terminal: "response.completed" },
  {
    transport: "WebSocket",
    reason: "end_turn",
    terminal: "response.completed",
  },
] as const)(
  "$transport keeps an Opus $reason result on its requested model",
  async ({ transport, reason, terminal }) => {
    upstreamReply = () =>
      anthropicResponse(sourceModel, "msg_original", reason, [
        {
          type: "text",
          text: 'Plain text may mention "stop_reason":"refusal".',
        },
      ])
    const client = await createClient(transport)
    const response = await client.send()
    expect(calls.map((call) => call.model)).toEqual([sourceModel])
    expect(response.frames.at(-1)?.type).toBe(terminal)
    expect(response.body).toContain("Plain text may mention")
    expect(response.headers.get("x-copilot-api-fallback-reason")).toBeNull()
  },
)

test.each([
  { transport: "HTTP", mode: "disabled" },
  { transport: "WebSocket", mode: "disabled" },
  { transport: "HTTP", mode: "no-rule" },
  { transport: "WebSocket", mode: "no-rule" },
] as const)(
  "$transport preserves native refusal when fallback is $mode",
  async ({ transport, mode }) => {
    setModelFallbackConfigForTest({
      ...getLoadedModelFallbackConfig(),
      ...(mode === "disabled" ? { enabled: false } : { rules: [] }),
    })
    const client = await createClient(transport)
    const response = await client.send()
    expect(calls.map((call) => call.model)).toEqual([sourceModel])
    expect(response.frames.at(-1)).toMatchObject({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "content_filter" } },
    })
    expect(response.body).toContain("source refusal")
    expect(response.headers.get("x-copilot-api-fallback-reason")).toBeNull()
  },
)

test.each(transports)(
  "%s forwards an exhausted target refusal without remembering a successful route",
  async (transport) => {
    upstreamReply = (body, index) => refusedResponse(String(body.model), index)
    const client = await createClient(transport, childHeaders)
    for (let index = 0; index < 2; index++) {
      const response = await client.send()
      expect(response.frames.at(-1)).toMatchObject({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "content_filter" } },
      })
      expect(response.body).toContain("source refusal")
      expect(response.headers.get("x-copilot-api-fallback-cached")).not.toBe(
        "true",
      )
    }
    expect(calls.map((call) => call.model)).toEqual([
      sourceModel,
      targetModel,
      sourceModel,
      targetModel,
    ])
  },
)

test.each(transports)(
  "%s aborts a stalled native Messages body without starting another model",
  async (transport) => {
    const readingBody = Promise.withResolvers<undefined>()
    let upstreamAborted = false
    upstreamReply = (_body, _index, signal) => {
      let pulls = 0
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => {
                  upstreamAborted = true
                  controller.error(signal.reason)
                },
                { once: true },
              )
            },
            pull(controller) {
              if (pulls++ === 0) {
                controller.enqueue(
                  new TextEncoder().encode(
                    '{"id":"msg_pending","type":"message",',
                  ),
                )
              } else readingBody.resolve(undefined)
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      )
    }
    const client = await createClient(transport)
    const request = client.send().then(
      (response) => ({ kind: "response" as const, response }),
      (error: unknown) => ({ kind: "error" as const, error }),
    )
    await readingBody.promise
    client.abort()
    const result = await Promise.race([
      request,
      Bun.sleep(1000).then(() => ({ kind: "timeout" as const })),
    ])
    expect(result.kind).not.toBe("timeout")
    expect(upstreamAborted).toBe(true)
    expect(calls.map((call) => call.model)).toEqual([sourceModel])
    if (result.kind === "response")
      expect(
        result.response.frames.some(
          (frame) => frame.type === "response.completed",
        ),
      ).toBe(false)
  },
)

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

function reasoningInput() {
  const blocks = [
    {
      type: "thinking",
      thinking: "source history thought",
      signature: "source-history-signature",
    },
  ]
  return [
    {
      type: "reasoning",
      id: "rs_source_history",
      summary: [{ type: "summary_text", text: "source history thought" }],
      encrypted_content:
        "capi_anthropic_v1:"
        + Buffer.from(JSON.stringify({ model: sourceModel, blocks })).toString(
          "base64url",
        ),
    },
    { type: "message", role: "assistant", content: "Previous source answer" },
    { type: "message", role: "user", content: "continue" },
  ]
}

// eslint-disable-next-line max-params -- The upstream fixture keeps model, identity, terminal and content explicit.
function anthropicResponse(
  modelId: string,
  id: string,
  stopReason: string,
  content: Array<Frame>,
): Response {
  return Response.json({
    id,
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 1 },
  })
}

function refusedResponse(
  modelId: string,
  index: number,
  withContent = true,
): Response {
  return anthropicResponse(
    modelId,
    `msg_rejected_${index}`,
    "refusal",
    withContent ?
      [
        {
          type: "thinking",
          thinking: "source refusal thought",
          signature: "source-refusal-signature",
        },
        { type: "text", text: "source refusal" },
      ]
    : [],
  )
}

function completedResponse(modelId: string, index: number): Response {
  return anthropicResponse(modelId, `msg_accepted_${index}`, "end_turn", [
    {
      type: "thinking",
      thinking: "target history thought",
      signature: "target-history-signature",
    },
    { type: "text", text: "fallback answer" },
  ])
}

function parseFrames(body: string): Array<Frame> {
  return body
    .split(/\r?\n\r?\n/u)
    .map((frame) =>
      frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data) as Frame)
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

async function createClient(
  transport: Transport,
  initialHeaders: Record<string, string> = {},
) {
  const headers = {
    authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
    "session-id": "shared-parent-session",
    "thread-id": "parent-thread",
    ...initialHeaders,
  }
  await seedProtocolDatabase()
  if (transport === "HTTP") {
    const controller = new AbortController()
    return {
      abort() {
        controller.abort()
      },
      async send(
        payload: Record<string, unknown> = {},
        extraHeaders: Record<string, string> = {},
      ) {
        await seedProtocolDatabase()
        const response = await server.request("/v1/responses", {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            ...extraHeaders,
          },
          body: JSON.stringify({
            model: sourceModel,
            input: "hello",
            stream: true,
            ...payload,
          }),
          signal: controller.signal,
        })
        const body = await response.text()
        return {
          body,
          frames: parseFrames(body),
          headers: response.headers,
          status: response.status,
        }
      },
    }
  }
  let data: ResponsesWebSocketData | undefined
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/responses", { headers }),
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
    abort() {
      responsesWebSocket.close(socket)
    },
    async send(
      payload: Record<string, unknown> = {},
      extraHeaders: Record<string, string> = {},
    ) {
      const start = frames.length
      await responsesWebSocket.message(
        socket,
        JSON.stringify({
          type: "response.create",
          model: sourceModel,
          input: "hello",
          ...payload,
          headers: extraHeaders,
        }),
      )
      const received = frames.slice(start)
      return {
        body: JSON.stringify(received),
        frames: received,
        headers: frameHeaders(received),
        status: 200,
      }
    },
  }
}
