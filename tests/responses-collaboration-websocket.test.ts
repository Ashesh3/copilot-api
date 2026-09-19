import { afterEach, beforeEach, expect, test } from "bun:test"
import { events } from "fetch-event-stream"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { ModelsResponse } from "~/services/copilot/get-models"

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
const originalState = {
  apiKeyAuth: state.apiKeyAuth,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  manualApprove: state.manualApprove,
  models: state.models,
}
const model = "gpt-6-astra"
const requests: Array<Record<string, unknown>> = []
const responses: Array<Response> = []
const callArguments = '{"target":"/root/test","message":"hello compatibility"}'

beforeEach(() => {
  requests.length = 0
  responses.length = 0
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  state.apiKeyAuth = "collaboration-ws-client-secret"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: model,
        name: model,
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
  } satisfies ModelsResponse
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected a native Responses JSON request")
    requests.push(JSON.parse(init.body) as Record<string, unknown>)
    const response = responses.shift()
    if (!response) throw new Error("Unexpected upstream request")
    return Promise.resolve(response)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

function collaborationNamespace() {
  return {
    type: "namespace",
    name: "collaboration",
    tools: ["send_message", "followup_task", "spawn_agent"].map((name) => ({
      type: "function",
      name,
      description: "Communicate with another agent",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          ...(name === "spawn_agent" ?
            { task_name: { type: "string" } }
          : { target: { type: "string" } }),
          message: {
            type: "string",
            description: "Message to the agent",
            encrypted: true,
          },
        },
        required: [name === "spawn_agent" ? "task_name" : "target", "message"],
        additionalProperties: false,
      },
    })),
  }
}

function requestPayload(location: "tools" | "additional_tools") {
  const tools = [collaborationNamespace()]
  const input = [
    { type: "message", role: "user", content: "Send the greeting" },
  ]
  return location === "tools" ?
      { input, tools }
    : {
        input: [
          {
            type: "additional_tools",
            id: "tools_collaboration",
            role: "developer",
            tools,
          },
          ...input,
        ],
      }
}

async function createSocket() {
  let data: ResponsesWebSocketData | undefined
  await seedProtocolDatabase()
  await tryUpgradeResponsesWebSocket(
    new Request("http://localhost/responses", {
      headers: {
        authorization: "Bearer collaboration-ws-client-secret",
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
  if (!data) throw new Error("Expected an authenticated WebSocket upgrade")
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

async function sendTurn(
  ws: Awaited<ReturnType<typeof createSocket>>,
  payload: Record<string, unknown>,
) {
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", model, ...payload }),
  )
}

function upstreamResponse(
  id: string,
  withCall = false,
  stream = true,
): Response {
  const call = {
    id: "fc_ws_collaboration",
    type: "function_call",
    call_id: "call_ws_collaboration",
    name: "send_message",
    namespace: "copilot_collaboration",
    arguments: callArguments,
    status: "completed",
  }
  const response = { id, model, object: "response", output: [], usage: null }
  if (!stream) {
    return Response.json({
      ...response,
      status: "completed",
      output: withCall ? [call] : [],
    })
  }
  const frames = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress" },
    },
    ...(withCall ?
      [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...call, arguments: "", status: "in_progress" },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: call.id,
          delta: callArguments,
        },
        { type: "response.output_item.done", output_index: 0, item: call },
      ]
    : []),
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: withCall ? [call] : [],
      },
    },
  ]
  return new Response(
    frames
      .map(
        (frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

test.each(["tools", "additional_tools"] as const)(
  "WebSocket requests use plaintext collaboration schemas from %s",
  async (location) => {
    const ws = await createSocket()
    responses.push(upstreamResponse("resp_schema"))
    await sendTurn(ws, requestPayload(location))

    expect(requests).toHaveLength(1)
    const wireTools =
      location === "tools" ?
        requests[0].tools
      : (requests[0].input as Array<Record<string, unknown>>)[0].tools
    expect(wireTools).toMatchObject([
      {
        type: "namespace",
        name: "copilot_collaboration",
        tools: [
          { name: "send_message" },
          { name: "followup_task" },
          { name: "spawn_agent" },
        ],
      },
    ])
    expect(JSON.stringify(wireTools)).not.toContain('"encrypted":true')
    expect(ws.sent.some((frame) => frame.type === "error")).toBe(false)
  },
)

test("restores plaintext collaboration calls before WebSocket continuation snapshots", async () => {
  const ws = await createSocket()
  responses.push(
    upstreamResponse("resp_collaboration", true),
    upstreamResponse("resp_collaboration_followup"),
  )
  await sendTurn(ws, requestPayload("additional_tools"))
  await sendTurn(ws, {
    previous_response_id: "resp_collaboration",
    input: [
      {
        type: "function_call_output",
        call_id: "call_ws_collaboration",
        output: "message delivered",
      },
    ],
  })

  const callFrames = ws.sent.filter(
    (frame) =>
      frame.type === "response.output_item.added"
      || frame.type === "response.output_item.done",
  )
  expect(callFrames).toHaveLength(2)
  for (const frame of callFrames) {
    expect(frame.item).toMatchObject({
      type: "function_call",
      call_id: "call_ws_collaboration",
      name: "send_message",
      namespace: "collaboration",
      encrypted_function_args: [],
    })
  }
  const completed = ws.sent.find((frame) => frame.type === "response.completed")
  expect(completed?.response).toMatchObject({
    output: [
      {
        namespace: "collaboration",
        arguments: callArguments,
        encrypted_function_args: [],
      },
    ],
  })
  const snapshot = ws.data.responseSnapshots.get("resp_collaboration")
  expect(snapshot?.input).toContainEqual({
    id: "fc_ws_collaboration",
    type: "function_call",
    call_id: "call_ws_collaboration",
    name: "send_message",
    namespace: "collaboration",
    arguments: callArguments,
    status: "completed",
    encrypted_function_args: [],
  })
  expect(requests).toHaveLength(2)
  expect(requests[1].input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "function_call",
        namespace: "copilot_collaboration",
        name: "send_message",
        arguments: callArguments,
        call_id: "call_ws_collaboration",
      }),
      {
        type: "function_call_output",
        call_id: "call_ws_collaboration",
        output: "message delivered",
      },
    ]),
  )
  expect(requests[1]).not.toHaveProperty("previous_response_id")
  expect(ws.sent.some((frame) => frame.type === "error")).toBe(false)
  expect(ws.data.activeTurns.size).toBe(0)
})

test.each([false, true])(
  "HTTP Responses restores plaintext collaboration calls with stream=%s",
  async (stream) => {
    await seedProtocolDatabase()
    responses.push(upstreamResponse("resp_http_collaboration", true, stream))
    const response = await server.request("/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream,
        ...requestPayload("additional_tools"),
      }),
    })

    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    const wireTools = (requests[0].input as Array<Record<string, unknown>>)[0]
      .tools
    expect(wireTools).toMatchObject([
      { type: "namespace", name: "copilot_collaboration" },
    ])
    expect(JSON.stringify(wireTools)).not.toContain('"encrypted":true')

    let result: unknown
    if (stream) {
      for await (const frame of events(response)) {
        if (!frame.data) continue
        const parsed = JSON.parse(frame.data) as Record<string, unknown>
        if (parsed.type === "response.completed") result = parsed.response
      }
    } else result = await response.json()
    expect(result).toMatchObject({
      id: "resp_http_collaboration",
      output: [
        {
          type: "function_call",
          call_id: "call_ws_collaboration",
          name: "send_message",
          namespace: "collaboration",
          arguments: callArguments,
          encrypted_function_args: [],
        },
      ],
    })
  },
)
