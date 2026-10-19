import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

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
const model = "claude-opus-5.5"
const requests: Array<Record<string, unknown>> = []
let toolTurn = false
let chatEndpoint = false

const clientTools = [
  {
    type: "namespace",
    name: "functions",
    tools: [
      {
        type: "custom",
        name: "exec",
        description: "CLIENT_EXEC",
        format: { type: "text" },
      },
    ],
  },
  {
    type: "namespace",
    name: "copilot_collaboration",
    tools: [
      {
        type: "function",
        name: "spawn_agent",
        description: "CLIENT_AGENT",
        parameters: { type: "object", properties: {} },
      },
    ],
  },
  {
    type: "namespace",
    name: "web",
    tools: [
      {
        type: "function",
        name: "run",
        description: "CLIENT_WEB",
        parameters: { type: "object", properties: {} },
      },
    ],
  },
]

function payload(location: "tools" | "additional_tools", type = "web_search") {
  const input: Array<Record<string, unknown>> = [
    {
      type: "message",
      role: "user",
      content: "Say hello or use the supplied client tool.",
    },
  ]
  if (location === "additional_tools")
    input.unshift({
      type: "additional_tools",
      role: "developer",
      tools: clientTools,
    })
  return {
    model,
    input,
    tools: [
      { type, external_web_access: false },
      ...(location === "tools" ? clientTools : []),
    ],
  }
}

beforeEach(async () => {
  requests.length = 0
  toolTurn = false
  chatEndpoint = false
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  state.apiKeyAuth = PROTOCOL_GATEWAY_KEY
  state.copilotToken = "fixture-copilot"
  state.githubToken = "fixture-github"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      {
        id: model,
        name: model,
        object: "model",
        version: "1",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          object: "model_capabilities",
          supports: { tool_calls: true },
          limits: { max_output_tokens: 4096 },
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  await seedProtocolDatabase()
  globalThis.fetch = Object.assign(
    // eslint-disable-next-line complexity -- One transport fixture covers buffered Messages and buffered/streamed Chat responses.
    (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(url instanceof Request ? url.url : String(url))
      expect(target.pathname).toBe(
        chatEndpoint ? "/chat/completions" : "/v1/messages",
      )
      if (typeof init?.body !== "string") throw new Error("Expected JSON body")
      const body = JSON.parse(init.body) as Record<string, unknown>
      requests.push(body)
      expect(body.model).toBe(model)
      const tools = (body.tools as Array<Record<string, unknown>>).map(
        (tool) =>
          chatEndpoint ? (tool.function as Record<string, unknown>) : tool,
      )
      expect(tools).toHaveLength(3)
      for (const description of ["CLIENT_EXEC", "CLIENT_AGENT", "CLIENT_WEB"])
        expect(
          tools.some(
            (t) =>
              typeof t.description === "string"
              && t.description.startsWith(description),
          ),
        ).toBe(true)
      expect(
        tools.some(
          (t) =>
            t.name === "web_search"
            || String(t.name).startsWith("_copilot_web_"),
        ),
      ).toBe(false)
      const exec = tools.find(
        (t) =>
          typeof t.description === "string"
          && t.description.startsWith("CLIENT_EXEC"),
      )
      if (!exec) throw new Error("Missing client exec")
      const firstTool = toolTurn && requests.length === 1
      if (chatEndpoint && body.stream) {
        const chunk = {
          id: `chat_opus_${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              finish_reason: firstTool ? "tool_calls" : "stop",
              delta:
                firstTool ?
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_exec",
                        type: "function",
                        function: {
                          name: exec.name,
                          arguments: JSON.stringify({
                            input: "print('fixture')",
                          }),
                        },
                      },
                    ],
                  }
                : { content: "Hello from Opus" },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }
        return Promise.resolve(
          new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
        )
      }
      if (chatEndpoint)
        return Promise.resolve(
          Response.json({
            id: `chat_opus_${requests.length}`,
            object: "chat.completion",
            model,
            created: 1,
            choices: [
              {
                index: 0,
                finish_reason: firstTool ? "tool_calls" : "stop",
                message: {
                  role: "assistant",
                  content: firstTool ? null : "Hello from Opus",
                  ...(firstTool ?
                    {
                      tool_calls: [
                        {
                          type: "function",
                          id: "call_exec",
                          function: {
                            name: exec.name,
                            arguments: JSON.stringify({
                              input: "print('fixture')",
                            }),
                          },
                        },
                      ],
                    }
                  : {}),
                },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        )
      return Promise.resolve(
        Response.json({
          id: `msg_opus_${requests.length}`,
          type: "message",
          role: "assistant",
          model,
          content:
            firstTool ?
              [
                {
                  type: "tool_use",
                  id: "call_exec",
                  name: exec.name,
                  input: { input: "print('fixture')" },
                },
              ]
            : [{ type: "text", text: "Hello from Opus" }],
          stop_reason: firstTool ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      )
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

async function http(source: Record<string, unknown>) {
  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(source),
  })
  const text = await response.text()
  expect(response.status).toBe(200)
  expect(text).not.toContain("unsupported_web_tool_combination")
  expect(text).not.toContain("[Web tool")
  if (!source.stream) return JSON.parse(text) as Record<string, unknown>
  const frames = text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
  expect(frames.filter((frame) => frame.type === "error")).toEqual([])
  const terminal = frames.find((frame) => frame.type === "response.completed")
  expect(terminal).toBeDefined()
  return terminal?.response as Record<string, unknown>
}

for (const location of ["tools", "additional_tools"] as const)
  for (const stream of [false, true])
    test(`Opus5.5 fresh HTTP ${stream ? "SSE" : "JSON"} chat accepts optional search alongside ${location}`, async () => {
      const source = { ...payload(location), stream }
      const snapshot = structuredClone(source)
      const result = await http(source)
      expect(JSON.stringify(result)).toContain("Hello from Opus")
      expect(requests).toHaveLength(1)
      expect(source).toEqual(snapshot)
    })

test.each([false, true])(
  "Opus5.5 HTTP custom-tool result round trip remains executable beside web_search_preview, chat fallback=%j",
  async (chatFallback) => {
    chatEndpoint = chatFallback
    if (chatFallback && state.models) {
      state.models.data[0].supported_endpoints = ["/chat/completions"]
      await seedProtocolDatabase()
    }
    toolTurn = true
    const source = {
      ...payload("additional_tools", "web_search_preview"),
      stream: false,
    }
    const result = await http(source)
    expect(result.output).toEqual([
      {
        type: "custom_tool_call",
        id: "ctc_call_exec",
        call_id: "call_exec",
        name: "exec",
        ...(chatFallback ? {} : { namespace: "functions" }),
        input: "print('fixture')",
        status: "completed",
      },
    ])
    const second = await http({
      ...source,
      input: [
        ...source.input,
        ...(result.output as Array<Record<string, unknown>>),
        {
          type: "custom_tool_call_output",
          call_id: "call_exec",
          output: "fixture",
        },
      ],
    })
    expect(JSON.stringify(second)).toContain("Hello from Opus")
    expect(JSON.stringify(requests[1].messages)).toContain(
      chatFallback ? '"tool_call_id":"call_exec"' : '"tool_use_id":"call_exec"',
    )
  },
)

test.each([
  { withTool: false, chatFallback: false },
  { withTool: true, chatFallback: false },
  { withTool: true, chatFallback: true },
])(
  "Opus5.5 WebSocket fresh chat and cached continuation work with optional search: %j",
  async ({ withTool, chatFallback }) => {
    chatEndpoint = chatFallback
    if (chatFallback && state.models) {
      state.models.data[0].supported_endpoints = ["/chat/completions"]
      await seedProtocolDatabase()
    }
    toolTurn = withTool
    let data: ResponsesWebSocketData | undefined
    await tryUpgradeResponsesWebSocket(
      new Request("http://localhost/responses", {
        headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
      }),
      {
        upgrade(_request, options) {
          data = (options as { data: ResponsesWebSocketData }).data
          return true
        },
      },
    )
    if (!data) throw new Error("Expected upgrade")
    const sent: Array<Record<string, unknown>> = []
    const ws = {
      data,
      send(frame: string) {
        sent.push(JSON.parse(frame) as Record<string, unknown>)
      },
      close() {},
    }
    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        ...payload("additional_tools"),
      }),
    )
    expect(sent.filter((frame) => frame.type === "error")).toEqual([])
    const terminal = sent.find((frame) => frame.type === "response.completed")
      ?.response as Record<string, unknown>
    expect(terminal).toBeDefined()
    if (withTool)
      expect(terminal.output).toMatchObject([
        {
          type: "custom_tool_call",
          name: "exec",
          ...(chatFallback ? {} : { namespace: "functions" }),
          call_id: "call_exec",
        },
      ])
    await responsesWebSocket.message(
      ws,
      JSON.stringify({
        type: "response.create",
        model,
        previous_response_id: terminal.id,
        input:
          withTool ?
            [
              {
                type: "custom_tool_call_output",
                call_id: "call_exec",
                output: "fixture",
              },
            ]
          : [{ role: "user", content: "Hello again" }],
      }),
    )
    expect(sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(requests).toHaveLength(2)
    expect(
      sent.filter((frame) => frame.type === "response.completed"),
    ).toHaveLength(2)
    expect(JSON.stringify(sent)).not.toContain("web_result_")
  },
)
