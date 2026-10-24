import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { state } from "~/lib/state"
import {
  responsesWebSocket,
  tryUpgradeResponsesWebSocket,
} from "~/routes/responses/websocket"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const requests: Array<{
  path: string
  body: Record<string, unknown>
  signal?: AbortSignal | null
}> = []
const replies: Array<Response | ((signal?: AbortSignal | null) => Response)> =
  []
const sourceModel = "gpt-5.4"
const targetModel = "gpt-5-mini"

interface Frame {
  type: string
  item?: Record<string, unknown>
  response?: {
    id: string
    model: string
    output: Array<Record<string, unknown>>
    incomplete_details?: { reason: string }
  }
}

beforeEach(async () => {
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  state.apiKeyAuth = "interrupt-translated-key"
  state.accountType = "individual"
  state.copilotToken = "fixture-copilot-token"
  state.githubToken = "fixture-github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      model("chat-interrupt", "/chat/completions"),
      model(sourceModel),
      model(targetModel),
    ],
  }
  requests.length = 0
  replies.length = 0
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON request")
    requests.push({
      path: new URL(String(_input)).pathname,
      body: JSON.parse(init.body) as Record<string, unknown>,
      signal: init.signal,
    })
    const reply = replies.shift()
    if (!reply) throw new Error("Unexpected upstream inference")
    return Promise.resolve(
      typeof reply === "function" ? reply(init.signal) : reply,
    )
  }) as typeof fetch
  await seedProtocolDatabase()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelFallbackConfigForTest(null)
})

test("interrupts translated Chat after a completed message and discards unfinished tool arguments before continuation", async () => {
  const ws = await createSocket()
  delete ws.data.authenticationRequest
  const chatId = "chat_interrupt"
  replies.push(chatResponse(chatId, true), chatResponse("chat_followup", false))
  let interruption: Promise<void> | undefined
  ws.onFrame = (frame) => {
    if (
      frame.type === "response.output_item.done"
      && frame.item?.type === "message"
      && !interruption
    ) {
      interruption = interrupt(ws, `resp_${chatId}`)
    }
  }
  await send(ws, {
    model: "chat-interrupt",
    input: "start translated",
    tools: [
      {
        type: "function",
        name: "shell",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
        },
      },
    ],
  })
  expect(interruption).toBeDefined()
  await interruption
  expect(requests).toHaveLength(1)
  expect(requests[0].path).toBe("/chat/completions")
  expect(requests[0].signal?.aborted).toBe(true)
  const terminal = ws.frames.find(
    (frame) => frame.type === "response.incomplete",
  )
  expect(terminal?.response).toMatchObject({
    id: `resp_${chatId}`,
    incomplete_details: { reason: "interrupted" },
    output: [
      { type: "message", content: [{ text: "saved translated answer" }] },
    ],
  })
  expect(terminal?.response?.output).toHaveLength(1)
  expect(
    ws.frames.some(
      (frame) => frame.type === "response.output_item.interrupted",
    ),
  ).toBe(true)
  expect(
    ws.frames.some(
      (frame) => frame.type === "response.completed" || frame.type === "error",
    ),
  ).toBe(false)
  expect(
    JSON.stringify(ws.data.responseSnapshots.get(`resp_${chatId}`)),
  ).not.toContain("discarded-command")
  ws.onFrame = undefined
  await send(ws, {
    previous_response_id: `resp_${chatId}`,
    input: "continue translated",
  })
  expect(requests).toHaveLength(2)
  expect(requests[1].body.model).toBe("chat-interrupt")
  expect(JSON.stringify(requests[1].body.messages)).toContain(
    "saved translated answer",
  )
  expect(JSON.stringify(requests[1].body.messages)).toContain(
    "continue translated",
  )
  expect(JSON.stringify(requests[1].body.messages)).not.toContain(
    "discarded-command",
  )
  expect(ws.frames.at(-1)?.type).toBe("response.completed")
  expect(ws.data.activeTurns.size).toBe(0)
})

test("interrupts the selected fallback once and resumes its original-model snapshot without retrying cancellation", async () => {
  setModelFallbackConfigForTest({
    enabled: true,
    notifyClient: false,
    nativeClientNotice: false,
    rules: [
      { id: "interrupt-fallback", enabled: true, sourceModel, targetModel },
    ],
  })
  const ws = await createSocket()
  const active: { upstream?: ReadableStreamDefaultController<Uint8Array> } = {}
  const lifecycle = { ended: false }
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        active.upstream = controller
      },
      cancel() {
        lifecycle.ended = true
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  const native = {
    id: "resp_fallback_interrupt",
    object: "response",
    model: targetModel,
    created_at: 1,
    status: "in_progress",
    output: [],
    usage: null,
    error: null,
    incomplete_details: null,
  }
  let sequence = 0
  const emit = (frame: Record<string, unknown>) => {
    if (!active.upstream) throw new Error("Expected an initialized stream")
    active.upstream.enqueue(
      new TextEncoder().encode(
        `event: ${String(frame.type)}\ndata: ${JSON.stringify({ ...frame, sequence_number: sequence++ })}\n\n`,
      ),
    )
  }
  emit({ type: "response.created", response: native })
  emit({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "saved_fallback",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "saved fallback answer", annotations: [] },
      ],
    },
  })
  emit({
    type: "response.output_item.added",
    output_index: 1,
    item: {
      id: "partial_fallback",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  })
  emit({
    type: "response.output_text.delta",
    output_index: 1,
    item_id: "partial_fallback",
    delta: "discarded fallback partial",
  })
  replies.push(new Response("unprocessable", { status: 422 }), (signal) => {
    signal?.addEventListener(
      "abort",
      () => {
        if (!lifecycle.ended) {
          lifecycle.ended = true
          active.upstream?.error(
            new DOMException("Fixture interrupted", "AbortError"),
          )
        }
      },
      { once: true },
    )
    return response
  })
  const partial = ws.waitFor("response.output_text.delta")
  const pending = send(ws, {
    model: sourceModel,
    input: "start fallback",
    tools: [],
  })
  try {
    await partial
    await interrupt(ws, native.id)
    await pending
    expect(requests.map((request) => request.body.model)).toEqual([
      sourceModel,
      targetModel,
    ])
    expect(requests[1].signal?.aborted).toBe(true)
    expect(ws.data.responseSnapshots.get(native.id)?.model).toBe(sourceModel)
    const terminal = ws.frames.find(
      (frame) => frame.type === "response.incomplete",
    )
    expect(terminal?.response?.model).toBe(sourceModel)
    expect(terminal?.response?.output).toHaveLength(1)
    expect(JSON.stringify(terminal)).not.toContain("discarded fallback partial")
    // An interrupted upstream has no successful terminal to cache its fallback.
    replies.push(nativeCompleted("resp_fallback_followup"))
    await send(ws, {
      previous_response_id: native.id,
      input: "continue fallback",
    })
    expect(requests.map((request) => request.body.model)).toEqual([
      sourceModel,
      targetModel,
      sourceModel,
    ])
    expect(JSON.stringify(requests[2].body.input)).toContain(
      "saved fallback answer",
    )
    expect(JSON.stringify(requests[2].body.input)).toContain(
      "continue fallback",
    )
    expect(JSON.stringify(requests[2].body.input)).not.toContain(
      "discarded fallback partial",
    )
    expect(ws.frames.at(-1)?.response?.model).toBe(sourceModel)
    expect(
      ws.frames.filter((frame) => frame.type === "response.incomplete"),
    ).toHaveLength(1)
    expect(ws.frames.some((frame) => frame.type === "error")).toBe(false)
    expect(ws.data.activeTurns.size).toBe(0)
  } finally {
    if (!lifecycle.ended) {
      lifecycle.ended = true
      active.upstream?.close()
    }
    await pending
  }
})

function model(id: string, endpoint = "/responses"): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "fixture",
    supported_endpoints: [endpoint],
    capabilities: {
      family: "gpt",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

async function createSocket() {
  let data: ResponsesWebSocketData | undefined
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/responses", {
      headers: {
        authorization: "Bearer interrupt-translated-key",
        "session-id": crypto.randomUUID(),
      },
    }),
    {
      upgrade(_request, options) {
        data = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    },
  )
  if (!data) throw new Error("Expected authenticated socket")
  const frames: Array<Frame> = []
  const observers = new Set<(frame: Frame) => void>()
  const ws = {
    data,
    frames,
    onFrame: undefined as ((frame: Frame) => void) | undefined,
    close() {},
    send(value: string) {
      const frame = JSON.parse(value) as Frame
      frames.push(frame)
      for (const observer of observers) observer(frame)
      ws.onFrame?.(frame)
    },
    waitFor(type: string): Promise<Frame> {
      return new Promise((resolve) => {
        const observer = (frame: Frame) => {
          if (frame.type === type) {
            observers.delete(observer)
            resolve(frame)
          }
        }
        observers.add(observer)
      })
    },
  }
  return ws
}

async function send(
  ws: Awaited<ReturnType<typeof createSocket>>,
  payload: Record<string, unknown>,
) {
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...payload }),
  )
}

async function interrupt(
  ws: Awaited<ReturnType<typeof createSocket>>,
  responseId: string,
) {
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.interrupt",
      response_id: responseId,
      mode: "discard_partial_items",
    }),
  )
}

function chatResponse(id: string, withTool: boolean) {
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "chat-interrupt",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "saved translated answer",
            ...(withTool ?
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_discarded",
                    type: "function",
                    function: {
                      name: "shell",
                      arguments: '{"command":"discarded-command"}',
                    },
                  },
                ],
              }
            : {}),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "chat-interrupt",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: withTool ? "tool_calls" : "stop",
        },
      ],
    },
  ]
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
      + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

function nativeCompleted(id: string) {
  const frame = {
    type: "response.completed",
    response: {
      id,
      object: "response",
      model: sourceModel,
      status: "completed",
      output: [],
      usage: null,
      error: null,
      incomplete_details: null,
    },
  }
  return new Response(
    `event: response.completed\ndata: ${JSON.stringify(frame)}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}
