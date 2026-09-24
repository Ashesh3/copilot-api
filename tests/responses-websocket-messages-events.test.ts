import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { responsesWebSocket } from "~/routes/responses/websocket"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }

interface StreamFrame {
  type: string
  sequence_number: number
  item?: Record<string, unknown>
  delta?: string
  response?: { output: Array<Record<string, unknown>>; status: string }
}

beforeEach(() => {
  state.accountType = "individual"
  state.copilotToken = "synthetic-upstream-token"
  state.githubToken = "synthetic-oauth-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-current",
        name: "Claude Current",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "test",
        model_picker_enabled: true,
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 4096 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

function createSocket() {
  const frames: Array<StreamFrame> = []
  const data: ResponsesWebSocketData = {
    activeTurns: new Map(),
    closed: false,
    nextTurnSequence: 0,
    type: "responses",
    requestId: "synthetic-ws-tool-events",
    nativeMessagesOptions: {},
    effectiveNativeMessagesOptions: {},
    responseSnapshots: new Map(),
  }
  return {
    data,
    frames,
    send(frame: string): void {
      frames.push(JSON.parse(frame) as StreamFrame)
    },
    close(): void {},
  }
}

test("Messages WebSocket emits executable tool items before terminal and retains continuation", async () => {
  const upstreamRequests: Array<Record<string, unknown>> = []
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.endsWith("/v1/messages"))
        throw new Error(`Unexpected upstream: ${url}`)
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request body")
      upstreamRequests.push(JSON.parse(init.body) as Record<string, unknown>)
      const first = upstreamRequests.length === 1
      return Promise.resolve(
        Response.json({
          id: first ? "msg_tool_turn" : "msg_final_turn",
          type: "message",
          role: "assistant",
          model: "claude-current",
          content:
            first ?
              [
                {
                  type: "tool_use",
                  id: "call_read",
                  name: "read",
                  input: { path: "sample.txt" },
                },
              ]
            : [{ type: "text", text: "Read successfully" }],
          stop_reason: first ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
  const socket = createSocket()
  await seedProtocolDatabase()
  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: "claude-current",
      input: "Read the sample",
      tools: [
        { type: "function", name: "read", parameters: { type: "object" } },
      ],
    }),
  )

  expect(socket.frames.map((frame) => frame.type)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
    "response.completed",
  ])
  expect(socket.frames[0]?.response?.output).toEqual([])
  expect(socket.frames[1]?.item).toMatchObject({
    type: "function_call",
    call_id: "call_read",
    arguments: "",
  })
  expect(socket.frames[2]?.delta).toBe('{"path":"sample.txt"}')
  expect(socket.frames[4]?.item).toMatchObject({
    type: "function_call",
    call_id: "call_read",
    arguments: '{"path":"sample.txt"}',
  })
  expect(socket.data.activeTurns.size).toBe(0)

  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: "claude-current",
      previous_response_id: "msg_tool_turn",
      input: [
        {
          type: "function_call_output",
          call_id: "call_read",
          output: "sample contents",
        },
      ],
    }),
  )

  expect(upstreamRequests[1]?.messages).toMatchObject([
    { role: "user", content: [{ type: "text", text: "Read the sample" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_read",
          name: "read",
          input: { path: "sample.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_read" }],
    },
  ])
  expect(JSON.stringify(upstreamRequests[1]?.messages)).toContain(
    "sample contents",
  )
  expect(
    socket.frames.some(
      (frame) =>
        frame.type === "response.output_text.delta"
        && frame.delta === "Read successfully",
    ),
  ).toBe(true)
  expect(socket.frames.at(-1)?.type).toBe("response.completed")
  expect(socket.data.activeTurns.size).toBe(0)
})

test("synthetic incomplete WebSocket results keep their terminal type and continuation snapshot", async () => {
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        Response.json({
          id: "msg_partial",
          type: "message",
          role: "assistant",
          model: "claude-current",
          content: [{ type: "text", text: "Partial answer" }],
          stop_reason: "max_tokens",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      ),
    { preconnect: originalFetch.preconnect },
  )
  const socket = createSocket()
  await seedProtocolDatabase()
  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: "claude-current",
      input: "Start answer",
    }),
  )

  expect(socket.frames.at(-1)?.type).toBe("response.incomplete")
  expect(socket.frames.at(-1)?.response?.status).toBe("incomplete")
  expect(
    socket.frames.some(
      (frame) =>
        frame.type === "response.output_text.delta"
        && frame.delta === "Partial answer",
    ),
  ).toBe(true)
  expect(socket.data.responseSnapshots.get("msg_partial")?.input).toMatchObject(
    [
      { role: "user", content: [{ type: "input_text", text: "Start answer" }] },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Partial answer" }],
      },
    ],
  )
  expect(socket.data.activeTurns.size).toBe(0)
})

test("closing after a synthetic incomplete frame does not restore cleared history", async () => {
  globalThis.fetch = Object.assign(
    () =>
      Promise.resolve(
        Response.json({
          id: "msg_partial_close",
          type: "message",
          role: "assistant",
          model: "claude-current",
          content: [{ type: "text", text: "Partial answer" }],
          stop_reason: "max_tokens",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      ),
    { preconnect: originalFetch.preconnect },
  )
  const socket = createSocket()
  const originalSend = socket.send.bind(socket)
  socket.send = (data: string) => {
    originalSend(data)
    if ((JSON.parse(data) as StreamFrame).type === "response.incomplete") {
      queueMicrotask(() => responsesWebSocket.close(socket))
    }
  }
  await seedProtocolDatabase()
  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: "claude-current",
      input: "Start answer",
    }),
  )

  expect(socket.frames.at(-1)?.type).toBe("response.incomplete")
  expect(socket.data.closed).toBe(true)
  expect(socket.data.activeTurns.size).toBe(0)
  expect(socket.data.responseSnapshots.size).toBe(0)
})

test.each([
  {
    kind: "custom_tool_call",
    input: {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                {
                  type: "custom",
                  name: "exec",
                  description: "Execute audit code",
                  format: { type: "text" },
                },
              ],
            },
          ],
        },
        { type: "message", role: "user", content: "Run audit" },
      ],
    },
    returnedInput: { input: 'text("audit");' },
    expectedCall: {
      type: "custom_tool_call",
      call_id: "call_restored",
      namespace: "functions",
      name: "exec",
      input: 'text("audit");',
    },
    expectedEvents: [
      "response.created",
      "response.output_item.added",
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "response.output_item.done",
      "response.completed",
    ],
  },
  {
    kind: "tool_search_call",
    input: {
      input: "Find tools",
      tools: [
        {
          type: "tool_search",
          execution: "client",
          description: "Discover audit tools",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    },
    returnedInput: { query: "audit" },
    expectedCall: {
      type: "tool_search_call",
      call_id: "call_restored",
      execution: "client",
      arguments: { query: "audit" },
    },
    expectedEvents: [
      "response.created",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ],
  },
])(
  "Messages WebSocket restores $kind with its original executable item shape",
  async ({ input, returnedInput, expectedCall, expectedEvents }) => {
    globalThis.fetch = Object.assign(
      (_request: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON request")
        const body = JSON.parse(init.body) as {
          tools?: Array<{ name?: string }>
        }
        const name = body.tools?.[0]?.name
        if (!name) throw new Error("Translated callable tool was lost")
        return Promise.resolve(
          Response.json({
            id: "msg_restored",
            type: "message",
            role: "assistant",
            model: "claude-current",
            content: [
              {
                type: "tool_use",
                id: "call_restored",
                name,
                input: returnedInput,
              },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    const socket = createSocket()
    await seedProtocolDatabase()
    await responsesWebSocket.message(
      socket,
      JSON.stringify({
        type: "response.create",
        model: "claude-current",
        ...input,
      }),
    )

    expect(socket.frames.map((frame) => frame.type)).toEqual([
      ...expectedEvents,
    ])
    expect(
      socket.frames.find((frame) => frame.type === "response.output_item.done")
        ?.item,
    ).toMatchObject(expectedCall)
    expect(socket.frames.at(-1)?.response?.output).toMatchObject([expectedCall])
    const storedInput = socket.data.responseSnapshots.get("msg_restored")?.input
    expect(Array.isArray(storedInput)).toBe(true)
    if (!Array.isArray(storedInput)) throw new Error("Missing stored history")
    expect(storedInput.at(-1)).toMatchObject(expectedCall)
    expect(socket.data.activeTurns.size).toBe(0)
  },
)
