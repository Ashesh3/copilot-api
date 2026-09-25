import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
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

const originalFetch = globalThis.fetch
const originalState = { ...state }
const messagesModel = "claude-opus-5.5"
const taskText =
  "Message Type: NEW_TASK\nTask name: /root/hello_test\nSender: /root\nPayload:\nThis is a simple subagent connectivity test. Respond with exactly: hello world\nDo not use tools or do any other work."

interface CapturedRequest {
  path: string
  body: Record<string, unknown>
  headers: Headers
}

const requests: Array<CapturedRequest> = []

function model(id: string, endpoint: string): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: endpoint === "/v1/messages" ? "anthropic" : "openai",
    version: "fixture",
    supported_endpoints: [endpoint],
    capabilities: {
      family: endpoint === "/v1/messages" ? "claude" : "gpt",
      object: "model_capabilities",
      limits: { max_output_tokens: 4096 },
      supports: { reasoning_effort: ["low", "medium", "high", "max"] },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function agentMessage(text = taskText) {
  return {
    type: "agent_message",
    id: "amsg_source_opaque_id",
    author: "/root",
    recipient: "/root/hello_test",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: {
      turn_id: "source_turn_id",
      create_time: 1790310000,
    },
  }
}

function nativeResult(id: string, modelId: unknown) {
  return {
    id,
    object: "response",
    created_at: 1,
    model: modelId,
    output: [
      {
        id: `text_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "hello world", annotations: [] },
        ],
      },
    ],
    output_text: "hello world",
    status: "completed",
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    error: null,
    incomplete_details: null,
  }
}

function upstreamResponse(request: CapturedRequest): Response {
  if (request.path === "/v1/messages") {
    return Response.json({
      id: `msg_agent_${requests.length}`,
      type: "message",
      role: "assistant",
      model: request.body.model,
      content: [{ type: "text", text: "hello world" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
    })
  }
  if (request.path === "/chat/completions") {
    return Response.json({
      id: "chat_agent",
      object: "chat.completion",
      created: 1,
      model: request.body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    })
  }
  if (request.path !== "/responses")
    throw new Error("Unexpected upstream endpoint")
  const result = nativeResult(
    `resp_agent_${requests.length}`,
    request.body.model,
  )
  if (!request.body.stream) return Response.json(result)
  return new Response(
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

beforeEach(() => {
  requests.length = 0
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  state.accountType = "individual"
  state.copilotToken = "agent-message-upstream-token"
  state.githubToken = "agent-message-oauth-token"
  state.apiKeyAuth = PROTOCOL_GATEWAY_KEY
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      model(messagesModel, "/v1/messages"),
      model("chat-agent-model", "/chat/completions"),
      model("native-agent-model", "/responses"),
    ],
  }
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON upstream request")
      const request = {
        path: new URL(input instanceof Request ? input.url : String(input))
          .pathname,
        body: JSON.parse(init.body) as Record<string, unknown>,
        headers: new Headers(init.headers),
      }
      requests.push(request)
      return Promise.resolve(upstreamResponse(request))
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

async function post(payload: Record<string, unknown>): Promise<Response> {
  await seedProtocolDatabase()
  return await server.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })
}

async function createSocket() {
  await seedProtocolDatabase()
  let data: ResponsesWebSocketData | undefined
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/responses", {
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "session-id": "agent-message-socket",
      },
    }),
    {
      upgrade(_request, options) {
        data = (options as { data: ResponsesWebSocketData }).data
        return true
      },
    },
  )
  if (!data) throw new Error("Expected authenticated WebSocket upgrade")
  const sent: Array<Record<string, unknown>> = []
  return {
    data,
    sent,
    send(frame: string) {
      sent.push(JSON.parse(frame) as Record<string, unknown>)
    },
    close() {},
  }
}

test.each([false, true])(
  "HTTP preserves the captured initial agent task with max effort (stream=%s)",
  async (stream) => {
    const response = await post({
      model: messagesModel,
      reasoning: { effort: "max" },
      stream,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Environment context" }],
        },
        agentMessage(),
      ],
    })
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain("hello world")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.path).toBe("/v1/messages")
    expect(requests[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Environment context" }],
      },
      { role: "user", content: [{ type: "text", text: taskText }] },
    ])
    expect(requests[0]?.body.output_config).toMatchObject({ effort: "max" })
    expect(requests[0]?.headers.get("x-initiator")).toBe("agent")
    expect(JSON.stringify(requests[0]?.body.messages)).not.toContain(
      "amsg_source_opaque_id",
    )
  },
)

test("HTTP keeps later agent messages after assistant history on the Chat fallback", async () => {
  const followup =
    "Message Type: MESSAGE\nSender: /root/reviewer\nPayload:\nUse the reviewed result."
  const response = await post({
    model: "chat-agent-model",
    stream: false,
    input: [
      { role: "user", content: "Start work" },
      { role: "assistant", content: "Initial result" },
      agentMessage(followup),
    ],
  })
  expect(response.status).toBe(200)
  expect(requests[0]?.path).toBe("/chat/completions")
  expect(requests[0]?.body.messages).toEqual([
    { role: "user", content: "Start work" },
    { role: "assistant", content: "Initial result" },
    { role: "user", content: followup },
  ])
  expect(requests[0]?.headers.get("x-initiator")).toBe("agent")
})

test("WebSocket continuation preserves the next agent message and original source snapshot", async () => {
  const socket = await createSocket()
  const first = agentMessage()
  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: messagesModel,
      reasoning: { effort: "max" },
      input: [first],
    }),
  )
  expect(socket.sent.at(-1)?.type).toBe("response.completed")
  expect(requests[0]?.body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: taskText }] },
  ])
  expect(socket.data.responseSnapshots.get("msg_agent_1")?.input?.[0]).toEqual(
    first,
  )
  const followup =
    "Message Type: MESSAGE\nSender: /root\nPayload:\nContinue with the second step."
  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: messagesModel,
      reasoning: { effort: "max" },
      previous_response_id: "msg_agent_1",
      input: [agentMessage(followup)],
    }),
  )
  expect(socket.sent.at(-1)?.type).toBe("response.completed")
  expect(requests).toHaveLength(2)
  expect(requests[1]?.body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: taskText }] },
    { role: "assistant", content: [{ type: "text", text: "hello world" }] },
    { role: "user", content: [{ type: "text", text: followup }] },
  ])
  for (const request of requests) {
    expect(request.body.output_config).toMatchObject({ effort: "max" })
    expect(request.headers.get("x-initiator")).toBe("agent")
  }
})

test("WebSocket warmup retains the original agent task for the following generation", async () => {
  const socket = await createSocket()
  const original = agentMessage()
  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: messagesModel,
      reasoning: { effort: "max" },
      generate: false,
      input: [original],
    }),
  )
  expect(requests).toHaveLength(0)
  const terminal = socket.sent.at(-1)
  expect(terminal?.type).toBe("response.completed")
  const responseId = (terminal?.response as { id?: string } | undefined)?.id
  if (!responseId) throw new Error("Expected warmup response ID")
  expect(socket.data.responseSnapshots.get(responseId)?.input?.[0]).toEqual(
    original,
  )
  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: messagesModel,
      previous_response_id: responseId,
      input: [],
    }),
  )
  expect(socket.sent.at(-1)?.type).toBe("response.completed")
  expect(requests).toHaveLength(1)
  expect(requests[0]?.body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: taskText }] },
  ])
  expect(requests[0]?.body.output_config).toMatchObject({ effort: "max" })
  expect(requests[0]?.headers.get("x-initiator")).toBe("agent")
})

test.each(["/v1/messages", "/chat/completions"])(
  "rejects encrypted agent content before a translated %s dispatch",
  async (endpoint) => {
    const response = await post({
      model: endpoint === "/v1/messages" ? messagesModel : "chat-agent-model",
      stream: false,
      input: [
        {
          ...agentMessage(),
          content: [
            { type: "input_text", text: "Visible agent context" },
            {
              type: "encrypted_content",
              encrypted_content: "opaque-agent-ciphertext",
            },
          ],
        },
      ],
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        code: "endpoint_translation_unsupported",
        param: "content_part",
      },
    })
    expect(requests).toHaveLength(0)
  },
)

test("native Responses receives agent-message provenance and encrypted content unchanged", async () => {
  const original = {
    ...agentMessage(),
    content: [
      { type: "encrypted_content", encrypted_content: "native-agent-state" },
    ],
  }
  const response = await post({
    model: "native-agent-model",
    stream: false,
    input: [original],
  })
  expect(response.status).toBe(200)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.path).toBe("/responses")
  expect(requests[0]?.body.input).toEqual([original])
  expect(requests[0]?.headers.get("x-initiator")).toBe("agent")
})

test("WebSocket rejects opaque agent content before starting a translated upstream request", async () => {
  const socket = await createSocket()
  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      model: messagesModel,
      input: [
        {
          ...agentMessage(),
          content: [
            {
              type: "encrypted_content",
              encrypted_content: "opaque-agent-ciphertext",
            },
          ],
        },
      ],
    }),
  )
  expect(socket.sent.at(-1)).toMatchObject({
    type: "error",
    status: 400,
    error: { code: "bad_request", param: "content_part" },
  })
  expect(requests).toHaveLength(0)
  expect(socket.data.activeTurns.size).toBe(0)
})

test.each([messagesModel, "chat-agent-model"])(
  "ordinary user requests keep the user initiator on %s",
  async (modelId) => {
    const response = await post({
      model: modelId,
      stream: false,
      input: [{ role: "user", content: "Hello from the user" }],
    })
    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get("x-initiator")).toBe("user")
    expect(JSON.stringify(requests[0]?.body.messages)).toContain(
      "Hello from the user",
    )
  },
)

test.each([messagesModel, "chat-agent-model"])(
  "tool-result followups keep the agent initiator on %s",
  async (modelId) => {
    const response = await post({
      model: modelId,
      stream: false,
      tools: [
        {
          type: "function",
          name: "echo",
          parameters: { type: "object", properties: {} },
        },
      ],
      input: [
        { role: "user", content: "Use echo" },
        {
          type: "function_call",
          call_id: "call_echo",
          name: "echo",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_echo",
          output: "echo completed",
        },
      ],
    })
    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get("x-initiator")).toBe("agent")
    expect(JSON.stringify(requests[0]?.body.messages)).toContain("call_echo")
    expect(JSON.stringify(requests[0]?.body.messages)).toContain(
      "echo completed",
    )
  },
)

test.each(["system", "developer"])(
  "Messages tool-result followups remain agent-originated after a trailing %s instruction is hoisted",
  async (role) => {
    const response = await post({
      model: messagesModel,
      stream: false,
      tools: [
        {
          type: "function",
          name: "echo",
          parameters: { type: "object", properties: {} },
        },
      ],
      input: [
        { role: "user", content: "Use echo" },
        {
          type: "function_call",
          call_id: "call_hoisted",
          name: "echo",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_hoisted",
          output: "echo completed",
        },
        { type: "message", role, content: "Keep the response short" },
      ],
    })
    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body.system).toBe("Keep the response short")
    expect(requests[0]?.headers.get("x-initiator")).toBe("agent")
  },
)
