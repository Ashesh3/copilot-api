import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"

import type { ResponseUsage } from "~/services/copilot/create-responses"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { listLlmDebugLogs } from "~/lib/llm-debug-log"
import { getLastUsedRoutedAccountId } from "~/lib/request-session"
import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import {
  enableDatabaseUsageForTest,
  getUsageResponse,
} from "~/lib/usage-tracker"
import {
  responsesWebSocket,
  type ResponsesWebSocketData,
} from "~/routes/responses/websocket"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

interface Frame {
  type: string
  response_id?: string
  response?: {
    id: string
    status: string
    incomplete_details?: { reason: string }
    output: Array<Record<string, unknown>>
  }
  error?: { code: string }
  status?: number
}

interface CapturedRequest {
  accountId?: number
  affinity?: string
  routingAffinity?: RoutingAffinity
  body: Record<string, unknown>
  signal?: AbortSignal | null
}

const originalFetch = globalThis.fetch
const originalModels = state.models
const requests: Array<CapturedRequest> = []
const upstreams: Array<ReturnType<typeof createUpstream>> = []
const models: ModelsResponse = {
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

beforeEach(async () => {
  enableDatabaseUsageForTest()
  state.models = models
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  setConfigForTest(null)
  requests.length = 0
  upstreams.length = 0
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected a serialized Responses request")
    requests.push({
      accountId: getLastUsedRoutedAccountId(),
      affinity: getRoutingAffinity()?.key,
      routingAffinity: structuredClone(getRoutingAffinity()),
      body: JSON.parse(init.body) as Record<string, unknown>,
      signal: init.signal,
    })
    const upstream = upstreams.shift()
    if (!upstream) throw new Error("Unexpected upstream inference")
    upstream.attach(init.signal)
    return Promise.resolve(upstream.response)
  }) as typeof fetch
  await seedProtocolDatabase()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
  setConfigForTest(null)
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// eslint-disable-next-line max-lines-per-function -- Protocol cases share one isolated upstream fixture.
describe("Responses WebSocket interrupt", () => {
  test("acknowledges completed responses without changing COMPLETE or dispatching inference", async () => {
    const ws = createSocket()
    const upstream = createUpstream("resp_complete")
    upstream.finish({ input_tokens: 17, output_tokens: 4, total_tokens: 21 })
    upstreams.push(upstream)
    const log = spyOn(console, "info").mockImplementation(() => {})
    try {
      await createResponse(ws, "finish")
      const debugBefore = await listLlmDebugLogs()
      expect(debugBefore.count).toBe(1)
      expect(debugBefore.entries[0]?.status).toBe("complete")
      const usageBefore = await getUsageResponse()
      expect(usageBefore.lifetime).toMatchObject({
        total_input_tokens: 17,
        total_output_tokens: 4,
        total_requests: 1,
      })
      const priorFrames = ws.frames.length
      await interrupt(ws, "resp_complete")
      await interrupt(ws, "resp_complete")

      expect(ws.frames.slice(priorFrames)).toEqual([
        { type: "response.interrupt.accepted", response_id: "resp_complete" },
        { type: "response.interrupt.accepted", response_id: "resp_complete" },
      ])
      expect(requests).toHaveLength(1)
      expect(ws.data.nextTurnSequence).toBe(1)
      const debugAfter = await listLlmDebugLogs()
      expect(debugAfter.count).toBe(1)
      expect(debugAfter.entries[0]?.id).toBe(debugBefore.entries[0]?.id)
      expect(debugAfter.entries[0]?.status).toBe("complete")
      expect((await getUsageResponse()).lifetime).toEqual(usageBefore.lifetime)
      const lines = log.mock.calls.flat().map(String)
      expect(lines.filter((line) => line.includes("STARTED"))).toHaveLength(1)
      expect(lines.filter((line) => line.includes("COMPLETE"))).toHaveLength(1)
      expect(lines.some((line) => /ABORTED|REJECTED|ERROR/.test(line))).toBe(
        false,
      )
    } finally {
      log.mockRestore()
    }
  })

  test("interrupts a stalled stream promptly after acknowledging and preserving only done items", async () => {
    const ws = createSocket()
    const upstream = createUpstream("resp_stalled")
    upstreams.push(upstream)
    upstream.emit({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg_done",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    })
    upstream.emit({
      type: "response.output_item.done",
      output_index: 0,
      item: completedMessage("msg_done", "saved answer"),
    })
    upstream.emit({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "call_done",
        type: "function_call",
        call_id: "call_saved",
        name: "shell",
        arguments: "",
        status: "in_progress",
      },
    })
    upstream.emit({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "call_done",
        type: "function_call",
        call_id: "call_saved",
        name: "shell",
        arguments: '{"cmd":"saved"}',
        status: "completed",
      },
    })
    upstream.emit({
      type: "response.output_item.added",
      output_index: 2,
      item: {
        id: "msg_partial",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    })
    upstream.emit({
      type: "response.output_text.delta",
      item_id: "msg_partial",
      output_index: 2,
      content_index: 0,
      delta: "discarded partial",
    })
    upstream.emit({
      type: "response.in_progress",
      response: {
        id: "resp_stalled",
        status: "in_progress",
        usage: { input_tokens: 19, output_tokens: 6, total_tokens: 25 },
      },
    })
    const delivered = ws.waitFor("response.in_progress")
    const pending = createResponse(ws, "original input")
    try {
      await delivered
      let abortObserved: { terminal?: string; snapshot: boolean } | undefined
      upstream.onAbort = () => {
        abortObserved = {
          terminal: ws.frames.at(-1)?.type,
          snapshot: ws.data.responseSnapshots.has("resp_stalled"),
        }
      }
      const offset = ws.frames.length
      await interrupt(ws, "resp_stalled")
      expect(ws.frames[offset]).toEqual({
        type: "response.interrupt.accepted",
        response_id: "resp_stalled",
      })
      const terminal = ws.frames.at(-1)
      expect(terminal).toMatchObject({
        type: "response.incomplete",
        response: {
          id: "resp_stalled",
          status: "incomplete",
          incomplete_details: { reason: "interrupted" },
          output: [
            completedMessage("msg_done", "saved answer"),
            {
              id: "call_done",
              type: "function_call",
              call_id: "call_saved",
              name: "shell",
              arguments: '{"cmd":"saved"}',
              status: "completed",
            },
          ],
        },
      })
      expect(terminal?.response?.output).toHaveLength(2)
      expect(requests[0]?.signal?.aborted).toBe(true)
      expect(abortObserved).toEqual({
        terminal: "response.incomplete",
        snapshot: true,
      })
      expect(ws.data.closed).toBe(false)
      await pending
      await interrupt(ws, "resp_stalled")
      expect(
        ws.frames.filter((frame) => frame.type === "response.incomplete"),
      ).toHaveLength(1)
      expect(ws.frames.at(-1)?.type).toBe("response.interrupt.accepted")
      expect(ws.data.activeTurns.size).toBe(0)
      expect(ws.data.nextTurnSequence).toBe(1)
      expect((await getUsageResponse()).lifetime).toMatchObject({
        total_input_tokens: 19,
        total_output_tokens: 6,
        total_requests: 1,
      })
    } finally {
      upstream.finish()
      await pending
    }
  })

  test("continues interrupted responses with saved output, model and account affinity", async () => {
    const ws = createSocket()
    const upstream = createUpstream("resp_continue")
    upstreams.push(upstream)
    upstream.emit({
      type: "response.output_item.done",
      output_index: 0,
      item: completedMessage("msg_kept", "retained output"),
    })
    upstream.emit({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "msg_dropped",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    })
    upstream.emit({
      type: "response.output_text.delta",
      item_id: "msg_dropped",
      output_index: 1,
      content_index: 0,
      delta: "discarded output",
    })
    const delivered = ws.waitFor("response.output_text.delta")
    const pending = createResponse(ws, "original question")
    try {
      await delivered
      await interrupt(ws, "resp_continue")
      expect(ws.frames.at(-1)?.type).toBe("response.incomplete")
      await pending
      const continuation = createUpstream("resp_next")
      continuation.finish()
      upstreams.push(continuation)
      await responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          previous_response_id: "resp_continue",
          input: "follow up",
        }),
      )
      expect(requests).toHaveLength(2)
      expect(requests[1]?.body.model).toBe("gpt-5.4")
      expect(requests[1]?.body.previous_response_id).toBeUndefined()
      expect(requests[1]?.accountId).toBe(requests[0]?.accountId)
      expect(requests[1]?.affinity).toBe(requests[0]?.affinity)
      expect(JSON.stringify(requests[1]?.body.input)).toContain(
        "original question",
      )
      expect(JSON.stringify(requests[1]?.body.input)).toContain(
        "retained output",
      )
      expect(JSON.stringify(requests[1]?.body.input)).toContain("follow up")
      expect(JSON.stringify(requests[1]?.body.input)).not.toContain(
        "discarded output",
      )
      expect(JSON.stringify(requests[1]?.body.input)).not.toContain(
        "msg_dropped",
      )
      expect(ws.frames.at(-1)?.response?.id).toBe("resp_next")
    } finally {
      upstream.finish()
      await pending
    }
  })

  test("interrupts only the exact target while another concurrent response completes", async () => {
    const ws = createSocket()
    const first = createUpstream("resp_first")
    const second = createUpstream("resp_second")
    upstreams.push(first, second)
    const firstCreated = ws.waitFor("response.created", "resp_first")
    const pendingFirst = createResponse(ws, "first")
    await firstCreated
    const secondCreated = ws.waitFor("response.created", "resp_second")
    const pendingSecond = createResponse(ws, "second")
    try {
      await secondCreated
      await interrupt(ws, "resp_first")
      expect(ws.frames.at(-1)).toMatchObject({
        type: "response.incomplete",
        response: { id: "resp_first" },
      })
      expect(requests[0]?.signal?.aborted).toBe(true)
      expect(requests[1]?.signal?.aborted).toBe(false)
      second.finish()
      await Promise.all([pendingFirst, pendingSecond])
      expect(
        ws.frames
          .filter((frame) => frame.type === "response.completed")
          .map((frame) => frame.response?.id),
      ).toEqual(["resp_second"])
      expect(ws.data.responseSnapshots.has("resp_first")).toBe(true)
      expect(ws.data.responseSnapshots.has("resp_second")).toBe(true)
      expect(requests).toHaveLength(2)
      expect(ws.data.closed).toBe(false)
    } finally {
      first.finish()
      second.finish()
      await Promise.all([pendingFirst, pendingSecond])
    }
  })

  test("retains interrupted memory affinity when continuation metadata describes another root turn", async () => {
    const ws = createSocket()
    ws.data.affinity = { key: "memory-root", source: "codex_session" }
    const upstream = createUpstream("resp_memory")
    upstreams.push(upstream)
    const created = ws.waitFor("response.created")
    const pending = responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "memory history",
        client_metadata: {
          session_id: "memory-root",
          thread_id: "memory-root",
          "x-codex-turn-metadata": { request_kind: "memory" },
        },
      }),
    )
    try {
      await created
      expect(requests[0]?.routingAffinity?.memoryThreadKey).toBe("memory-root")
      expect(requests[0]?.affinity).toStartWith("codex-memory:")
      await interrupt(ws, "resp_memory")
      await pending
      const continuation = createUpstream("resp_memory_next")
      continuation.finish()
      upstreams.push(continuation)
      await responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          previous_response_id: "resp_memory",
          input: "continue memory",
          client_metadata: {
            session_id: "different-root",
            thread_id: "different-child",
            "x-codex-turn-metadata": {
              request_kind: "turn",
              forked_from_thread_id: "different-parent",
            },
          },
        }),
      )
      expect(requests).toHaveLength(2)
      expect(requests[1]?.routingAffinity).toEqual(requests[0]?.routingAffinity)
      expect(requests[1]?.accountId).toBe(requests[0]?.accountId)
      expect(ws.data.affinity).toEqual({
        key: "memory-root",
        source: "codex_session",
      })
      expect(ws.frames.at(-1)).toMatchObject({
        type: "response.completed",
        response: { id: "resp_memory_next" },
      })
    } finally {
      upstream.finish()
      await pending
    }
  })

  test("continues replayed history with a queued agent message after interrupting the resumed stream", async () => {
    const ws = createSocket()
    const queuedMessage = {
      type: "agent_message",
      id: "amsg_resumed",
      author: "/root/research",
      recipient: "/root",
      content: [{ type: "input_text", text: "Saved research is ready" }],
    }
    const replay = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue the saved work" }],
      },
      queuedMessage,
      { type: "reasoning", summary: [] },
    ]
    const upstream = createUpstream("resp_resumed")
    upstreams.push(upstream)
    const created = ws.waitFor("response.created")
    const pending = responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: replay,
        tools: [],
      }),
    )
    try {
      await created
      expect(requests[0]?.body.input).toEqual(replay)
      await interrupt(ws, "resp_resumed")
      await pending
      const continuation = createUpstream("resp_resumed_next")
      continuation.finish()
      upstreams.push(continuation)
      await responsesWebSocket.message(
        ws,
        JSON.stringify({
          type: "response.create",
          previous_response_id: "resp_resumed",
          input: "Use those research results",
        }),
      )
      const input = requests[1]?.body.input as Array<Record<string, unknown>>
      expect(input.slice(0, 3)).toEqual(replay)
      expect(input[3]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Use those research results" }],
      })
      expect(ws.frames.some((frame) => frame.type === "error")).toBe(false)
      expect(ws.frames.at(-1)).toMatchObject({
        type: "response.completed",
        response: { id: "resp_resumed_next" },
      })
      expect(requests).toHaveLength(2)
    } finally {
      upstream.finish()
      await pending
    }
  })

  test.each(["response.interrupt.accepted", "response.incomplete"])(
    "clears interrupted state when the socket closes reentrantly during %s delivery",
    async (closeOn) => {
      const ws = createSocket()
      const upstream = createUpstream("resp_close")
      upstreams.push(upstream)
      const created = ws.waitFor("response.created")
      const pending = createResponse(ws, "close during interrupt")
      const log = spyOn(console, "info").mockImplementation(() => {})
      try {
        await created
        ws.onFrame = (frame) => {
          if (frame.type === closeOn) responsesWebSocket.close(ws)
        }
        await interrupt(ws, "resp_close")
        await pending
        expect(ws.data.closed).toBe(true)
        expect(ws.data.activeTurns.size).toBe(0)
        expect(ws.data.responseSnapshots.size).toBe(0)
        expect(requests[0]?.signal?.aborted).toBe(true)
        expect(requests).toHaveLength(1)
        expect(
          ws.frames.filter((frame) => frame.type === "response.incomplete"),
        ).toHaveLength(closeOn === "response.incomplete" ? 1 : 0)
        expect(
          ws.frames.some(
            (frame) =>
              frame.type === "error" || frame.type === "response.completed",
          ),
        ).toBe(false)
        const lines = log.mock.calls.flat().map(String)
        expect(lines.filter((line) => line.includes("COMPLETE"))).toHaveLength(
          closeOn === "response.incomplete" ? 1 : 0,
        )
        expect(lines.filter((line) => line.includes("ABORTED"))).toHaveLength(
          closeOn === "response.incomplete" ? 0 : 1,
        )
      } finally {
        log.mockRestore()
        upstream.finish()
        await pending
      }
    },
  )

  test("reports an unknown exact response ID without cancelling an active response", async () => {
    const ws = createSocket()
    const upstream = createUpstream("resp_known")
    upstreams.push(upstream)
    const created = ws.waitFor("response.created")
    const pending = createResponse(ws, "keep going")
    try {
      await created
      await interrupt(ws, "resp_known_typo")
      expect(ws.frames.at(-1)).toMatchObject({
        type: "response.interrupt.failed",
        response_id: "resp_known_typo",
        error: { code: "response_not_found" },
      })
      expect(ws.frames.at(-1)?.status).toBeUndefined()
      expect(requests[0]?.signal?.aborted).toBe(false)
      upstream.finish()
      await pending
      expect(ws.frames.at(-1)?.type).toBe("response.completed")
      expect(requests).toHaveLength(1)
    } finally {
      upstream.finish()
      await pending
    }
  })

  test("keeps a normal completion when interrupt arrives during terminal delivery", async () => {
    const ws = createSocket()
    const upstream = createUpstream("resp_race")
    upstream.finish()
    upstreams.push(upstream)
    const interrupted = new Promise<void>((resolve, reject) => {
      ws.onFrame = (frame) => {
        if (frame.type === "response.completed")
          void interrupt(ws, "resp_race").then(resolve, reject)
      }
    })
    await createResponse(ws, "complete first")
    await interrupted
    expect(
      ws.frames.filter((frame) => frame.type === "response.completed"),
    ).toHaveLength(1)
    expect(
      ws.frames.filter((frame) => frame.type === "response.incomplete"),
    ).toHaveLength(0)
    expect(ws.frames.at(-1)).toEqual({
      type: "response.interrupt.accepted",
      response_id: "resp_race",
    })
    expect(requests).toHaveLength(1)
    expect(ws.data.nextTurnSequence).toBe(1)
  })

  test.each([
    { response_id: undefined, mode: "discard_partial_items" },
    { response_id: null, mode: "discard_partial_items" },
    { response_id: "", mode: "discard_partial_items" },
    { response_id: 12, mode: "discard_partial_items" },
    { response_id: "resp_target", mode: undefined },
    { response_id: "resp_target", mode: "keep_partial_items" },
  ])(
    "rejects malformed interrupt %p without starting a turn",
    async (fields) => {
      const ws = createSocket()
      await responsesWebSocket.message(
        ws,
        JSON.stringify({ type: "response.interrupt", ...fields }),
      )
      expect(ws.frames).toHaveLength(1)
      expect(ws.frames[0]).toMatchObject({
        type: "error",
        status: 400,
        error: { code: "bad_request" },
      })
      expect(requests).toHaveLength(0)
      expect(ws.data.nextTurnSequence).toBe(0)
      expect(ws.data.closed).toBe(false)
    },
  )
})

function createSocket() {
  const frames: Array<Frame> = []
  const observers = new Set<(frame: Frame) => void>()
  const data: ResponsesWebSocketData = {
    activeTurns: new Map(),
    closed: false,
    nextTurnSequence: 0,
    type: "responses",
    requestId: "interrupt-test",
    affinity: { key: "interrupt-session", source: "claude_session" },
    nativeMessagesOptions: {},
    effectiveNativeMessagesOptions: {},
    responseSnapshots: new Map(),
  }
  const socket = {
    data,
    frames,
    onFrame: undefined as ((frame: Frame) => void) | undefined,
    send(value: string) {
      const frame = JSON.parse(value) as Frame
      frames.push(frame)
      for (const observer of observers) observer(frame)
      socket.onFrame?.(frame)
    },
    close() {},
    waitFor(type: string, responseId?: string): Promise<Frame> {
      return new Promise((resolve) => {
        const observer = (frame: Frame) => {
          if (
            frame.type !== type
            || (responseId && frame.response?.id !== responseId)
          )
            return
          observers.delete(observer)
          resolve(frame)
        }
        observers.add(observer)
      })
    },
  }
  return socket
}

function completedMessage(id: string, text: string) {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  }
}

function createUpstream(id: string) {
  let controller: ReadableStreamDefaultController<Uint8Array>
  let finished = false
  let sequence = 0
  const responseData = {
    id,
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
  }
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      finished = true
    },
  })
  const upstream = {
    response: new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }),
    onAbort: undefined as (() => void) | undefined,
    emit(frame: Record<string, unknown>) {
      if (finished) return
      const event = { ...frame, sequence_number: sequence++ }
      controller.enqueue(
        new TextEncoder().encode(
          `event: ${String(frame.type)}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      )
    },
    finish(usage: ResponseUsage | null = null) {
      if (finished) return
      upstream.emit({
        type: "response.completed",
        response: { ...responseData, status: "completed", usage },
      })
      finished = true
      controller.close()
    },
    attach(signal?: AbortSignal | null) {
      signal?.addEventListener(
        "abort",
        () => {
          upstream.onAbort?.()
          if (finished) return
          finished = true
          controller.error(
            new DOMException("Upstream interrupted", "AbortError"),
          )
        },
        { once: true },
      )
    },
  }
  upstream.emit({ type: "response.created", response: responseData })
  return upstream
}

async function createResponse(
  ws: ReturnType<typeof createSocket>,
  input: string,
) {
  await responsesWebSocket.message(
    ws,
    JSON.stringify({
      type: "response.create",
      model: "gpt-5.4",
      input,
      tools: [],
    }),
  )
}

async function interrupt(
  ws: ReturnType<typeof createSocket>,
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
