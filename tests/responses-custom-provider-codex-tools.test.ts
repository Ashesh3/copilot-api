/* eslint-disable max-lines -- one Codex fixture covers every custom-provider transport */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { CustomProviderModelConfig } from "~/lib/config"
import type { ResponsesWebSocketData } from "~/routes/responses/websocket"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setCustomProviderRetrySleepForTest } from "~/lib/custom-provider-retry"
import {
  createCustomProviderChatCompletions,
  resolveCustomProviderModel,
} from "~/lib/custom-providers"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { state } from "~/lib/state"
import { adaptResponsesToChatCandidate } from "~/routes/responses/responses-chat-adapter"
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

const PROVIDER_URL = "https://custom.example/v1/chat/completions"
const CUSTOM_MODEL = "glm-target"
const CUSTOM_ALIAS = "glm-cyber"
const COPILOT_MODEL = "gpt-5.4"
const WS_SECRET = "ws-client-secret"
const EXEC_GRAMMAR = "start: source\nsource: /[\\s\\S]+/"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  apiKeyAuth: state.apiKeyAuth,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  models: state.models,
}

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

const requests: Array<CapturedRequest> = []
const providerResponses: Array<() => Response> = []
const copilotResponses: Array<() => Response> = []
const retrySleeps: Array<number> = []

const copilotModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: COPILOT_MODEL,
      name: COPILOT_MODEL,
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

beforeEach(() => {
  requests.length = 0
  providerResponses.length = 0
  copilotResponses.length = 0
  retrySleeps.length = 0
  setCustomProviderRetrySleepForTest((ms) => {
    retrySleeps.push(ms)
    return Promise.resolve()
  })
  setModelRedirectsForTest([])
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "experiential",
        name: "Experiential",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "provider-key",
        models: [
          {
            id: CUSTOM_MODEL,
            aliases: [CUSTOM_ALIAS],
            kind: "chat",
            supportsStreaming: true,
          },
        ],
      },
    ],
  })
  state.accountType = "individual"
  state.apiKeyAuth = WS_SECRET
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.models = structuredClone(copilotModels)
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}
    requests.push({ url, body })
    const isProvider = url.startsWith("https://custom.example/")
    // ExperientialLabs rejects this shape, as OpenAI-compatible APIs do.
    if (isProvider && "stream_options" in body && body.stream !== true) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              message: "stream_options requires stream=true.",
              type: "invalid_request_error",
              param: "body",
              code: "invalid_parameter",
            },
          },
          { status: 400 },
        ),
      )
    }
    const next =
      isProvider ? providerResponses.shift() : copilotResponses.shift()
    if (!next) throw new Error(`Unexpected upstream request to ${url}`)
    return Promise.resolve(next())
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setCustomProviderRetrySleepForTest()
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
  setModelRedirectsForTest([])
})

function configureCustomModels(models: Array<CustomProviderModelConfig>): void {
  setConfigForTest({
    auth: { apiKeys: [] },
    customProviders: [
      {
        id: "experiential",
        name: "Experiential",
        type: "openai-compatible",
        baseUrl: "https://custom.example/v1",
        apiKey: "provider-key",
        models,
      },
    ],
  })
}

function codexToolsItem(): Record<string, unknown> {
  return {
    type: "additional_tools",
    id: "at_fixture",
    role: "developer",
    tools: [
      {
        type: "namespace",
        name: "functions",
        description: "",
        tools: [
          {
            type: "custom",
            name: "exec",
            description: "Run JavaScript code to orchestrate tool calls",
            format: {
              type: "grammar",
              syntax: "lark",
              definition: EXEC_GRAMMAR,
            },
          },
          {
            type: "function",
            name: "wait",
            description: "Wait for a running exec cell",
            strict: false,
            parameters: {
              type: "object",
              properties: { cell_id: { type: "string" } },
              required: ["cell_id"],
            },
          },
        ],
      },
      {
        type: "namespace",
        name: "collaboration",
        description: "Tools for spawning and managing sub-agents.",
        tools: [
          {
            type: "function",
            name: "spawn_agent",
            description: "Spawn a sub-agent",
            strict: false,
            parameters: {
              type: "object",
              properties: {
                task_name: { type: "string" },
                message: { type: "string", encrypted: true },
                model: { type: "string" },
              },
              required: ["task_name", "message"],
            },
          },
        ],
      },
      {
        type: "namespace",
        name: "mcp__cua_repl",
        description: "UI automation",
        tools: [
          {
            type: "function",
            name: "js",
            description: "Run browser automation",
            strict: false,
            parameters: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
          },
        ],
      },
    ],
  }
}

function codexInput(): Array<Record<string, unknown>> {
  return [
    codexToolsItem(),
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "You are Codex." }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Spawn a helper and run pwd" }],
    },
    {
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_exec_1",
      name: "exec",
      input: "text(await tools.exec_command({cmd:'pwd'}))",
    },
    {
      type: "custom_tool_call_output",
      call_id: "call_exec_1",
      output: [{ type: "input_text", text: String.raw`C:\work` }],
    },
    {
      type: "function_call",
      call_id: "call_spawn_1",
      namespace: "collaboration",
      name: "spawn_agent",
      arguments: JSON.stringify({ task_name: "helper", message: "Say hello" }),
      encrypted_function_args: [],
    },
    {
      type: "function_call_output",
      call_id: "call_spawn_1",
      output: "spawned /root/helper",
    },
  ]
}

const restoredExecCall = {
  type: "custom_tool_call",
  call_id: "call_exec_2",
  name: "exec",
  input: "text('hi')",
}
const restoredSpawnCall = {
  type: "function_call",
  call_id: "call_spawn_2",
  namespace: "collaboration",
  name: "spawn_agent",
  encrypted_function_args: [],
}
const restoredJsCall = {
  type: "function_call",
  call_id: "call_js_2",
  namespace: "mcp__cua_repl",
  name: "js",
}

function providerToolCalls() {
  return [
    {
      id: "call_exec_2",
      type: "function",
      function: {
        name: "exec",
        arguments: JSON.stringify({ input: "text('hi')" }),
      },
    },
    {
      id: "call_spawn_2",
      type: "function",
      function: {
        name: "collaboration__spawn_agent",
        arguments: JSON.stringify({
          task_name: "opus",
          message: "Return hello world",
          model: "claude-opus-5.5",
        }),
      },
    },
    {
      id: "call_js_2",
      type: "function",
      function: {
        name: "mcp__cua_repl__js",
        arguments: JSON.stringify({ code: "1+1" }),
      },
    },
  ]
}

function providerToolResponse(): Response {
  return Response.json({
    id: "chatcmpl-tools",
    object: "chat.completion",
    created: 1,
    model: CUSTOM_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: providerToolCalls(),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}

function providerTextResponse(text: string): Response {
  return Response.json({
    id: "chatcmpl-text",
    object: "chat.completion",
    created: 1,
    model: CUSTOM_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  })
}

function providerCapacityResponse(retryAfter: string): Response {
  return Response.json(
    {
      error: {
        message: "This model is at capacity right now.",
        type: "api_error",
        code: "unavailable_route",
      },
    },
    { status: 429, headers: { "retry-after": retryAfter } },
  )
}

function chunk(choice: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 1,
    model: CUSTOM_MODEL,
    choices: [{ index: 0, finish_reason: null, ...choice }],
  }
}

function providerSse(chunks: Array<unknown>): Response {
  return new Response(
    [...chunks.map((entry) => `data: ${JSON.stringify(entry)}`), "data: [DONE]"]
      .map((line) => `${line}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function providerStreamFromMessage(
  message: { content?: string; tool_calls?: Array<Record<string, unknown>> },
  finishReason: string,
): Response {
  return providerSse([
    ...(message.content ?
      [chunk({ delta: { role: "assistant", content: message.content } })]
    : []),
    ...(message.tool_calls ?? []).map((call, index) =>
      chunk({ delta: { tool_calls: [{ index, ...call }] } }),
    ),
    chunk({ delta: {}, finish_reason: finishReason }),
  ])
}

function providerTextStream(text: string): Response {
  return providerStreamFromMessage({ content: text }, "stop")
}

function providerToolCallsStream(): Response {
  return providerStreamFromMessage(
    { tool_calls: providerToolCalls() },
    "tool_calls",
  )
}

function providerToolStream(): Response {
  return providerSse([
    chunk({ delta: { role: "assistant", content: "Starting." } }),
    chunk({
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call_exec_2",
            type: "function",
            function: { name: "exec", arguments: "" },
          },
        ],
      },
    }),
    chunk({
      delta: {
        tool_calls: [{ index: 0, function: { arguments: '{"input":' } }],
      },
    }),
    chunk({
      delta: {
        tool_calls: [{ index: 0, function: { arguments: "\"text('hi')\"}" } }],
      },
    }),
    chunk({
      delta: {
        tool_calls: [
          {
            index: 1,
            id: "call_spawn_2",
            type: "function",
            function: {
              name: "collaboration__spawn_agent",
              arguments: '{"task_name":"opus",',
            },
          },
        ],
      },
    }),
    chunk({
      delta: {
        tool_calls: [
          {
            index: 1,
            function: { arguments: '"message":"Return hello world"}' },
          },
        ],
      },
    }),
    chunk({ delta: {}, finish_reason: "tool_calls" }),
    {
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: 1,
      model: CUSTOM_MODEL,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ])
}

function copilotCompletedResponse(id: string): Response {
  const response = { id, model: COPILOT_MODEL, output: [], usage: null }
  return new Response(
    [
      {
        type: "response.created",
        response: { ...response, status: "in_progress" },
      },
      {
        type: "response.completed",
        response: { ...response, status: "completed" },
      },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function providerRequests(): Array<CapturedRequest> {
  return requests.filter((request) => request.url === PROVIDER_URL)
}

type OutputItem = Record<string, unknown>

function itemMatching(fields: OutputItem): OutputItem {
  return expect.objectContaining(fields) as OutputItem
}

function itemsContaining(items: Array<OutputItem>): Array<OutputItem> {
  return expect.arrayContaining(items) as Array<OutputItem>
}

function toolNames(body: Record<string, unknown>): Array<string> {
  const tools = body.tools as Array<{ function: { name: string } }> | undefined
  return (tools ?? []).map((tool) => tool.function.name).sort()
}

/** Mirror strict OpenAI-compatible validation of tool-call history order. */
function unansweredToolCalls(body: Record<string, unknown>): Array<string> {
  const messages = body.messages as Array<{
    role: string
    tool_calls?: Array<{ id: string }>
    tool_call_id?: string
  }>
  const unanswered: Array<string> = []
  for (const [index, message] of messages.entries()) {
    const pending = new Set((message.tool_calls ?? []).map((call) => call.id))
    for (const next of messages.slice(index + 1)) {
      if (next.role !== "tool") break
      pending.delete(next.tool_call_id ?? "")
    }
    unanswered.push(...pending)
  }
  return unanswered
}

function expectRestoredToolCalls(output: unknown): void {
  expect(output).toEqual(
    expect.arrayContaining([
      expect.objectContaining(restoredExecCall),
      expect.objectContaining(restoredSpawnCall),
      expect.objectContaining(restoredJsCall),
    ]),
  )
  const items = output as Array<Record<string, unknown>>
  const exec = items.find((item) => item.call_id === "call_exec_2")
  expect(exec).not.toHaveProperty("namespace")
  const js = items.find((item) => item.call_id === "call_js_2")
  expect(js).not.toHaveProperty("encrypted_function_args")
  const spawn = items.find((item) => item.call_id === "call_spawn_2")
  expect(JSON.parse(String(spawn?.arguments))).toMatchObject({
    task_name: "opus",
    message: "Return hello world",
  })
}

async function postResponses(body: Record<string, unknown>) {
  await seedProtocolDatabase()
  return server.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

async function createSocket() {
  let data: ResponsesWebSocketData | undefined
  await seedProtocolDatabase().then(() =>
    tryUpgradeResponsesWebSocket(
      new Request("http://localhost/responses", {
        headers: {
          authorization: `Bearer ${WS_SECRET}`,
          "session-id": crypto.randomUUID(),
        },
      }),
      {
        upgrade(_request, options) {
          data = (options as { data: ResponsesWebSocketData }).data
          return true
        },
      },
    ),
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

async function sendTurn(
  ws: Awaited<ReturnType<typeof createSocket>>,
  payload: Record<string, unknown>,
) {
  await responsesWebSocket.message(
    ws,
    JSON.stringify({ type: "response.create", ...payload }),
  )
}

function completedFrames(
  ws: Awaited<ReturnType<typeof createSocket>>,
): Array<Record<string, unknown>> {
  return ws.sent
    .filter((frame) => frame.type === "response.completed")
    .map((frame) => frame.response as Record<string, unknown>)
}

describe("Codex tools in translated Chat requests", () => {
  test("declares namespaced, deferred, and freeform tools with readable names", async () => {
    const source = {
      model: CUSTOM_MODEL,
      tools: [],
      parallel_tool_calls: false,
      input: codexInput(),
    }
    const snapshot = structuredClone(source)
    const candidate = await adaptResponsesToChatCandidate({ source })

    expect(candidate.check.supported).toBe(true)
    expect(
      toolNames(candidate.payload as unknown as Record<string, unknown>),
    ).toEqual([
      "collaboration__spawn_agent",
      "exec",
      "mcp__cua_repl__js",
      "wait",
    ])
    const tools = candidate.payload.tools ?? []
    const exec = tools.find((tool) => tool.function.name === "exec")
    expect(exec?.function.parameters).toMatchObject({
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    })
    expect(exec?.function.description).toContain(EXEC_GRAMMAR)
    const spawn = tools.find(
      (tool) => tool.function.name === "collaboration__spawn_agent",
    )
    expect(spawn?.function.description).toContain(
      "Tools for spawning and managing sub-agents.",
    )
    expect(JSON.stringify(spawn?.function.parameters)).not.toContain(
      "encrypted",
    )

    const messages = candidate.payload.messages
    expect(JSON.stringify(messages)).not.toContain("[Future Responses item]")
    expect(JSON.stringify(messages)).not.toContain("[Custom tool")
    expect(messages).toContainEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_exec_1",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({
              input: "text(await tools.exec_command({cmd:'pwd'}))",
            }),
          },
        },
      ],
    })
    expect(messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_exec_1",
      content: String.raw`C:\work`,
    })
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        tool_calls: [
          expect.objectContaining({
            id: "call_spawn_1",
            function: expect.objectContaining({
              name: "collaboration__spawn_agent",
            }) as unknown,
          }),
        ],
      }) as (typeof messages)[number],
    )
    expect(messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_spawn_1",
      content: "spawned /root/helper",
    })
    expect(source).toEqual(snapshot)
  })

  test("keeps text between a tool call and its result in the calling message", async () => {
    const candidate = await adaptResponsesToChatCandidate({
      source: {
        model: CUSTOM_MODEL,
        input: [
          codexToolsItem(),
          { type: "message", role: "user", content: "Run it" },
          {
            type: "custom_tool_call",
            call_id: "call_exec_2",
            name: "exec",
            input: "text('hi')",
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Starting." }],
          },
          {
            type: "function_call",
            call_id: "call_spawn_2",
            namespace: "collaboration",
            name: "spawn_agent",
            arguments: JSON.stringify({ task_name: "opus", message: "hi" }),
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_exec_2",
            output: [{ type: "input_text", text: "hi" }],
          },
          {
            type: "function_call_output",
            call_id: "call_spawn_2",
            output: "spawned",
          },
        ],
      },
    })
    const body = candidate.payload as unknown as Record<string, unknown>

    expect(unansweredToolCalls(body)).toEqual([])
    expect(candidate.payload.messages.slice(-3)).toEqual([
      {
        role: "assistant",
        content: "Starting.",
        tool_calls: [
          {
            id: "call_exec_2",
            type: "function",
            function: {
              name: "exec",
              arguments: JSON.stringify({ input: "text('hi')" }),
            },
          },
          {
            id: "call_spawn_2",
            type: "function",
            function: {
              name: "collaboration__spawn_agent",
              arguments: JSON.stringify({ task_name: "opus", message: "hi" }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_exec_2", content: "hi" },
      { role: "tool", tool_call_id: "call_spawn_2", content: "spawned" },
    ])
  })
})

describe("Codex tool calls in translated Chat responses", () => {
  test("restores buffered HTTP tool calls to Codex tool identities", async () => {
    providerResponses.push(providerToolResponse)
    const response = await postResponses({
      model: CUSTOM_ALIAS,
      stream: false,
      tools: [],
      input: codexInput(),
    })
    const text = await response.text()
    expect(response.status, text).toBe(200)
    const body = JSON.parse(text) as { output: unknown }

    const dispatched = providerRequests()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].body.model).toBe(CUSTOM_MODEL)
    expect(toolNames(dispatched[0].body)).toContain(
      "collaboration__spawn_agent",
    )
    expectRestoredToolCalls(body.output)
    expect(text).not.toContain('"name":"collaboration__spawn_agent"')
  })

  test("restores streamed HTTP tool calls before Codex sees them", async () => {
    providerResponses.push(providerToolStream)
    const response = await postResponses({
      model: CUSTOM_ALIAS,
      stream: true,
      tools: [],
      input: codexInput(),
    })
    const text = await response.text()
    expect(response.status, text).toBe(200)
    const events = parseSse(text)
    const completed = events.find(
      (event) => event.type === "response.completed",
    )?.response as Record<string, unknown> | undefined
    const output = completed?.output as Array<Record<string, unknown>>
    expect(output).toEqual(
      itemsContaining([
        itemMatching(restoredExecCall),
        itemMatching(restoredSpawnCall),
      ]),
    )
    const done = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item as Record<string, unknown>)
    expect(done).toEqual(
      itemsContaining([
        itemMatching(restoredExecCall),
        itemMatching(restoredSpawnCall),
      ]),
    )
    const added = events
      .filter((event) => event.type === "response.output_item.added")
      .map((event) => event.item as Record<string, unknown>)
    expect(added).toContainEqual(
      itemMatching({
        type: "custom_tool_call",
        call_id: "call_exec_2",
        name: "exec",
      }),
    )
    expect(added).toContainEqual(
      itemMatching({
        type: "function_call",
        call_id: "call_spawn_2",
        name: "spawn_agent",
        namespace: "collaboration",
      }),
    )
    expect(text).not.toContain('"name":"collaboration__spawn_agent"')
    expect(text).not.toContain("response.failed")
  })

  test("keeps streamed output indexes consistent when a tool call precedes text", async () => {
    providerResponses.push(() =>
      providerSse([
        chunk({
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_exec_2",
                type: "function",
                function: {
                  name: "exec",
                  arguments: JSON.stringify({ input: "text('hi')" }),
                },
              },
            ],
          },
        }),
        chunk({ delta: { content: "Running it." } }),
        chunk({ delta: {}, finish_reason: "tool_calls" }),
      ]),
    )
    const response = await postResponses({
      model: CUSTOM_ALIAS,
      stream: true,
      input: codexInput(),
    })
    const events = parseSse(await response.text())

    const messageIndexes = events
      .filter(
        (event) =>
          event.item_id === "msg_cc_001"
          || (event.item as OutputItem | undefined)?.type === "message",
      )
      .map((event) => event.output_index)
    expect(new Set(messageIndexes)).toEqual(new Set([1]))
    const execIndexes = events
      .filter(
        (event) =>
          (event.item as OutputItem | undefined)?.call_id === "call_exec_2"
          || event.item_id === "ctc_call_exec_2",
      )
      .map((event) => event.output_index)
    expect(new Set(execIndexes)).toEqual(new Set([0]))
    const doneTypes = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => (event.item as OutputItem).type)
    expect(doneTypes).toEqual(["custom_tool_call", "message"])
    const completed = events.find(
      (event) => event.type === "response.completed",
    )?.response as { output: Array<OutputItem> } | undefined
    expect(completed?.output.map((item) => item.type)).toEqual([
      "custom_tool_call",
      "message",
    ])
  })

  test("restores dotted tool names that Chat models copy from Codex instructions", async () => {
    providerResponses.push(() =>
      Response.json({
        id: "chatcmpl-dotted",
        object: "chat.completion",
        created: 1,
        model: CUSTOM_MODEL,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_dotted",
                  type: "function",
                  function: {
                    name: "functions.collaboration.spawn_agent",
                    arguments: JSON.stringify({
                      task_name: "opus",
                      message: "Return hello world",
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    )
    const response = await postResponses({
      model: CUSTOM_ALIAS,
      stream: false,
      input: codexInput(),
    })
    const body = (await response.json()) as { output: unknown }
    expect(body.output).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        call_id: "call_dotted",
        namespace: "collaboration",
        name: "spawn_agent",
      }),
    )
  })
})

describe("non-streaming custom models over HTTP Responses", () => {
  test.each([false, true])(
    "buffers upstream and honors the client's stream=%s response format",
    async (stream) => {
      configureCustomModels([
        {
          id: CUSTOM_MODEL,
          aliases: [CUSTOM_ALIAS],
          kind: "chat",
          supportsStreaming: false,
        },
      ])
      const answer = "First paragraph.\n\nSecond paragraph."
      providerResponses.push(() => providerTextResponse(answer))
      const response = await postResponses({
        model: CUSTOM_ALIAS,
        stream,
        input: "Write two paragraphs",
      })
      const text = await response.text()

      expect(response.status, text).toBe(200)
      expect(providerRequests()).toHaveLength(1)
      expect(providerRequests()[0].body).toMatchObject({
        model: CUSTOM_MODEL,
        stream: false,
      })
      expect(providerRequests()[0].body).not.toHaveProperty("stream_options")
      if (stream) {
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        )
        const events = parseSse(text)
        expect(events.at(-1)).toMatchObject({
          type: "response.completed",
          response: { model: CUSTOM_ALIAS, output_text: answer },
        })
        expect(
          events.filter((event) => event.type === "response.output_text.delta"),
        ).toEqual([itemMatching({ delta: answer })])
      } else {
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        )
        expect(JSON.parse(text) as unknown).toMatchObject({
          model: CUSTOM_ALIAS,
          output_text: answer,
          status: "completed",
        })
      }
    },
  )

  test("serves buffered tool calls as SSE after a WebSocket 404", async () => {
    configureCustomModels([
      {
        id: CUSTOM_MODEL,
        aliases: [CUSTOM_ALIAS],
        kind: "chat",
        supportsStreaming: false,
      },
    ])
    const payload = { model: CUSTOM_ALIAS, tools: [], input: codexInput() }
    const ws = await createSocket()
    await sendTurn(ws, payload)
    expect(ws.sent).toEqual([itemMatching({ type: "error", status: 404 })])
    expect(providerRequests()).toEqual([])

    providerResponses.push(providerToolResponse)
    const response = await postResponses({ ...payload, stream: true })
    const events = parseSse(await response.text())

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(providerRequests()[0].body.stream).toBe(false)
    expect(providerRequests()[0].body).not.toHaveProperty("stream_options")
    expect(events.at(-1)?.type).toBe("response.completed")
    const completed = events.at(-1)?.response as Record<string, unknown>
    expectRestoredToolCalls(completed.output)
  })
})

describe("buffered custom HTTP tools and fallbacks", () => {
  test("keeps web search responses buffered with SSE framing", async () => {
    configureCustomModels([
      {
        id: CUSTOM_MODEL,
        aliases: [CUSTOM_ALIAS],
        kind: "chat",
        supportsStreaming: false,
      },
    ])
    providerResponses.push(
      () =>
        Response.json({
          id: "chatcmpl-search",
          object: "chat.completion",
          created: 1,
          model: CUSTOM_MODEL,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_search",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: '{"query":"fixture search"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      () => providerTextResponse("Search complete"),
    )
    copilotResponses.push(
      () =>
        Response.json(
          { jsonrpc: "2.0", id: "init", result: {} },
          { headers: { "Mcp-Session-Id": "fixture-search-session" } },
        ),
      () =>
        Response.json({
          jsonrpc: "2.0",
          id: "search",
          result: {
            content: [{ type: "text", text: "Fixture search result" }],
          },
        }),
    )
    const response = await postResponses({
      model: CUSTOM_ALIAS,
      stream: true,
      input: "Look it up",
      tools: [{ type: "web_search" }],
    })
    const events = parseSse(await response.text())

    expect(providerRequests()[0].body.stream).toBe(false)
    expect(providerRequests()[0].body).not.toHaveProperty("stream_options")
    expect(toolNames(providerRequests()[0].body)).toContain("web_search")
    expect(providerRequests()).toHaveLength(2)
    expect(providerRequests()[1].body.stream).toBe(false)
    expect(providerRequests()[1].body).not.toHaveProperty("stream_options")
    expect(providerRequests()[1].body.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_search",
      content: "Fixture search result",
    })
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { output_text: "Search complete" },
    })
  })

  test("keeps remote compaction as one buffered compaction item over SSE", async () => {
    configureCustomModels([
      {
        id: CUSTOM_MODEL,
        aliases: [CUSTOM_ALIAS],
        kind: "chat",
        supportsStreaming: false,
      },
    ])
    providerResponses.push(() => providerTextResponse("Summary for next turn"))
    const response = await postResponses({
      model: CUSTOM_ALIAS,
      stream: true,
      input: [
        { type: "message", role: "user", content: "Summarize this task" },
        { type: "compaction_trigger" },
      ],
    })
    const events = parseSse(await response.text())

    expect(providerRequests()[0].body.stream).toBe(false)
    expect(providerRequests()[0].body).not.toHaveProperty("stream_options")
    expect(events.at(-1)?.type).toBe("response.completed")
    const completed = events.at(-1)?.response as Record<string, unknown>
    expect(completed.output).toEqual([
      expect.objectContaining({
        type: "compaction",
        encrypted_content: Buffer.from("Summary for next turn").toString(
          "base64",
        ),
      }),
    ])
  })

  test("retries a buffered HTTP provider failure on its configured fallback", async () => {
    const fallbackModel = "http-buffered-fallback"
    configureCustomModels([
      {
        id: CUSTOM_MODEL,
        aliases: [CUSTOM_ALIAS],
        kind: "chat",
        supportsStreaming: false,
      },
      { id: fallbackModel, kind: "chat", supportsStreaming: false },
    ])
    setModelFallbackConfigForTest({
      enabled: true,
      notifyClient: false,
      nativeClientNotice: false,
      rules: [
        {
          id: "http-buffered-fallback",
          sourceModel: CUSTOM_ALIAS,
          targetModel: fallbackModel,
          enabled: true,
        },
      ],
    })
    providerResponses.push(
      () => new Response("unprocessable", { status: 422 }),
      () => providerTextResponse("Fallback answer"),
    )
    const response = await postResponses({
      model: CUSTOM_ALIAS,
      stream: true,
      input: "hello",
    })
    const events = parseSse(await response.text())

    expect(
      providerRequests().map((request) => [
        request.body.model,
        request.body.stream,
      ]),
    ).toEqual([
      [CUSTOM_MODEL, false],
      [fallbackModel, false],
    ])
    expect(events.filter((event) => event.type === "response.failed")).toEqual(
      [],
    )
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { output_text: "Fallback answer" },
    })
  })
})

describe("custom-provider models over the Responses WebSocket", () => {
  test("retries a provider that is briefly at capacity once", async () => {
    providerResponses.push(
      () => providerCapacityResponse("5"),
      () => providerTextStream("after capacity"),
    )
    const ws = await createSocket()
    await sendTurn(ws, { model: CUSTOM_ALIAS, input: "hello" })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(providerRequests()).toHaveLength(2)
    expect(retrySleeps).toEqual([5000])
    expect(JSON.stringify(completedFrames(ws).at(-1)?.output)).toContain(
      "after capacity",
    )
  })

  test("returns a long provider capacity wait without retrying", async () => {
    providerResponses.push(() => providerCapacityResponse("120"))
    const ws = await createSocket()
    await sendTurn(ws, { model: CUSTOM_ALIAS, input: "hello" })

    expect(providerRequests()).toHaveLength(1)
    expect(retrySleeps).toEqual([])
    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([
      expect.objectContaining({ status: 429 }) as Record<string, unknown>,
    ])
  })

  test("dispatches a custom alias after a Copilot turn assigned the conversation", async () => {
    const ws = await createSocket()
    copilotResponses.push(() => copilotCompletedResponse("resp_copilot"))
    await sendTurn(ws, { model: COPILOT_MODEL, input: "first" })
    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])

    providerResponses.push(() => providerTextStream("custom answer"))
    await sendTurn(ws, { model: CUSTOM_ALIAS, input: "second" })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    const dispatched = providerRequests()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].body.model).toBe(CUSTOM_MODEL)
    expect(dispatched[0].body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(
      ws.sent.some((frame) => frame.type === "response.output_text.delta"),
    ).toBe(true)
    const completed = completedFrames(ws).at(-1)
    expect(completed?.model).toBe(CUSTOM_ALIAS)
    expect(JSON.stringify(completed?.output)).toContain("custom answer")
  })

  test("buffers a web search turn without stream options", async () => {
    providerResponses.push(() => providerTextResponse("searched answer"))
    const ws = await createSocket()
    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      input: "look it up",
      tools: [{ type: "web_search" }],
    })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    const [dispatched] = providerRequests()
    expect(dispatched.body.stream).toBe(false)
    expect(dispatched.body).not.toHaveProperty("stream_options")
    expect(toolNames(dispatched.body)).toContain("web_search")
    expect(JSON.stringify(completedFrames(ws).at(-1)?.output)).toContain(
      "searched answer",
    )
  })

  test("rejects a non-streaming model's WebSocket turn with 404 for HTTP fallback", async () => {
    configureCustomModels([
      {
        id: CUSTOM_MODEL,
        aliases: [CUSTOM_ALIAS],
        kind: "chat",
        supportsStreaming: false,
      },
    ])
    const ws = await createSocket()
    await sendTurn(ws, { model: CUSTOM_ALIAS, input: "hello" })

    // No upstream call: the client must retry the request on its HTTP endpoint.
    expect(providerRequests()).toEqual([])
    expect(completedFrames(ws)).toEqual([])
    expect(ws.sent).toHaveLength(1)
    expect(ws.sent.at(-1)).toMatchObject({
      type: "error",
      status: 404,
      error: { code: "not_found", type: "not_found" },
    })
  })

  test("rejects a non-streaming model's warmup turn with 404 too", async () => {
    configureCustomModels([
      {
        id: CUSTOM_MODEL,
        aliases: [CUSTOM_ALIAS],
        kind: "chat",
        supportsStreaming: false,
      },
    ])
    const ws = await createSocket()
    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      input: codexInput(),
      tools: [],
      generate: false,
    })

    expect(providerRequests()).toEqual([])
    expect(completedFrames(ws)).toEqual([])
    expect(ws.data.responseSnapshots.size).toBe(0)
    expect(ws.sent).toHaveLength(1)
    expect(ws.sent.at(-1)).toMatchObject({
      type: "error",
      status: 404,
      error: { code: "not_found" },
    })
  })

  test("drops stream options from any buffered provider request", async () => {
    const reference = resolveCustomProviderModel({
      model: CUSTOM_ALIAS,
      kind: "chat",
    })
    if (!reference) throw new Error("Expected the custom alias to resolve")
    providerResponses.push(() => providerTextResponse("buffered"))
    const response = (await createCustomProviderChatCompletions(reference, {
      model: CUSTOM_ALIAS,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      stream_options: { include_usage: true },
    })) as ChatCompletionResponse

    expect(providerRequests()[0].body).not.toHaveProperty("stream_options")
    expect(response.choices[0].message.content).toBe("buffered")
  })

  test("answers Codex warmup locally and continues it on the provider", async () => {
    const ws = await createSocket()
    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      input: codexInput(),
      tools: [],
      generate: false,
    })
    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(requests).toHaveLength(0)
    const warmup = completedFrames(ws).at(-1)
    expect(String(warmup?.id)).toStartWith("warmup_")

    providerResponses.push(providerToolCallsStream)
    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      previous_response_id: warmup?.id,
      input: [],
      tools: [],
    })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    const dispatched = providerRequests()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].body.model).toBe(CUSTOM_MODEL)
    expect(toolNames(dispatched[0].body)).toEqual([
      "collaboration__spawn_agent",
      "exec",
      "mcp__cua_repl__js",
      "wait",
    ])
    expect(JSON.stringify(dispatched[0].body)).not.toContain(
      "[Future Responses item]",
    )
    const completed = completedFrames(ws).at(-1)
    expect(completed?.model).toBe(CUSTOM_ALIAS)
    expectRestoredToolCalls(completed?.output)
    const done = ws.sent
      .filter((frame) => frame.type === "response.output_item.done")
      .map((frame) => frame.item as Record<string, unknown>)
    expect(done).toEqual(
      itemsContaining([
        itemMatching(restoredExecCall),
        itemMatching(restoredSpawnCall),
      ]),
    )
  })

  test("keeps custom model names exactly as configured", async () => {
    configureCustomModels([{ id: "qwen3-8b", kind: "chat" }])
    const ws = await createSocket()
    providerResponses.push(() => providerTextStream("dashed answer"))
    await sendTurn(ws, { model: "qwen3-8b", input: "hello" })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(providerRequests().map((request) => request.body.model)).toEqual([
      "qwen3-8b",
    ])
  })
})

describe("custom-provider WebSocket routing", () => {
  test("buffers a non-streaming custom fallback and continues the original model", async () => {
    const fallbackModel = "buffered-fallback"
    configureCustomModels([
      { id: CUSTOM_MODEL, aliases: [CUSTOM_ALIAS], kind: "chat" },
      { id: fallbackModel, kind: "chat", supportsStreaming: false },
    ])
    setModelFallbackConfigForTest({
      enabled: true,
      notifyClient: false,
      nativeClientNotice: false,
      rules: [
        {
          id: "custom-to-buffered",
          sourceModel: CUSTOM_ALIAS,
          targetModel: fallbackModel,
          enabled: true,
        },
      ],
    })
    providerResponses.push(
      () => new Response("unprocessable", { status: 422 }),
      () => providerTextResponse("First buffered answer"),
      () => providerTextResponse("Next buffered answer"),
    )
    const ws = await createSocket()
    await sendTurn(ws, { model: CUSTOM_ALIAS, input: "first" })
    const first = completedFrames(ws).at(-1)
    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(first).toMatchObject({
      model: CUSTOM_ALIAS,
      output_text: "First buffered answer",
    })
    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      previous_response_id: first?.id,
      input: "second",
    })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(
      providerRequests().map((request) => [
        request.body.model,
        request.body.stream,
      ]),
    ).toEqual([
      [CUSTOM_MODEL, true],
      [fallbackModel, false],
      [fallbackModel, false],
    ])
    expect(providerRequests()[1].body).not.toHaveProperty("stream_options")
    expect(providerRequests()[2].body).not.toHaveProperty("stream_options")
    expect(completedFrames(ws).at(-1)?.output_text).toBe("Next buffered answer")
    expect(JSON.stringify(providerRequests()[2].body.messages)).toContain(
      "First buffered answer",
    )
  })

  test("buffers a non-streaming priority variant of a streaming custom model", async () => {
    configureCustomModels([
      { id: CUSTOM_MODEL, aliases: [CUSTOM_ALIAS], kind: "chat" },
      { id: `${CUSTOM_MODEL}-fast`, kind: "chat", supportsStreaming: false },
    ])
    providerResponses.push(() => providerTextResponse("Buffered fast answer"))
    const ws = await createSocket()
    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      service_tier: "priority",
      input: "hello",
    })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(providerRequests()[0].body).toMatchObject({
      model: `${CUSTOM_MODEL}-fast`,
      stream: false,
    })
    expect(completedFrames(ws).at(-1)).toMatchObject({
      model: CUSTOM_ALIAS,
      output_text: "Buffered fast answer",
    })
  })

  test("rejects a non-streaming requested custom model with a streaming priority variant", async () => {
    configureCustomModels([
      {
        id: CUSTOM_MODEL,
        aliases: [CUSTOM_ALIAS],
        kind: "chat",
        supportsStreaming: false,
      },
      { id: `${CUSTOM_MODEL}-fast`, kind: "chat", supportsStreaming: true },
    ])
    providerResponses.push(() => providerTextStream("Must not be called"))
    const ws = await createSocket()
    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      service_tier: "priority",
      input: "hello",
    })

    expect(providerRequests()).toEqual([])
    expect(ws.sent).toEqual([itemMatching({ type: "error", status: 404 })])
    expect(ws.sent[0].error).toMatchObject({
      code: "not_found",
      message: expect.stringContaining(CUSTOM_ALIAS) as unknown,
    })
  })

  test("rejects a non-streaming requested custom model routed to a Copilot priority variant", async () => {
    const fastModel = `${CUSTOM_MODEL}-fast`
    configureCustomModels([
      {
        id: CUSTOM_MODEL,
        aliases: [CUSTOM_ALIAS],
        kind: "chat",
        supportsStreaming: false,
      },
    ])
    state.models = {
      ...copilotModels,
      data: [{ ...copilotModels.data[0], id: fastModel, name: fastModel }],
    }
    copilotResponses.push(() => copilotCompletedResponse("resp_must_not_run"))
    const ws = await createSocket()
    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      service_tier: "priority",
      input: "hello",
    })

    expect(requests).toEqual([])
    expect(ws.sent).toEqual([itemMatching({ type: "error", status: 404 })])
  })
})

describe("custom-provider WebSocket continuations", () => {
  test("continues a custom model after its fallback moved a turn to Copilot", async () => {
    setModelFallbackConfigForTest({
      enabled: true,
      notifyClient: false,
      nativeClientNotice: false,
      rules: [
        {
          id: "custom-to-copilot",
          sourceModel: CUSTOM_ALIAS,
          targetModel: COPILOT_MODEL,
          enabled: true,
        },
      ],
    })
    providerResponses.push(
      () => new Response("unprocessable", { status: 422 }),
      () => new Response("unprocessable", { status: 422 }),
    )
    copilotResponses.push(
      () => copilotCompletedResponse("resp_fallback"),
      () => copilotCompletedResponse("resp_fallback_next"),
    )
    const ws = await createSocket()
    await sendTurn(ws, { model: CUSTOM_ALIAS, input: "first" })
    expect(ws.data.responseSnapshots.get("resp_fallback")?.model).toBe(
      CUSTOM_ALIAS,
    )

    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      previous_response_id: "resp_fallback",
      input: "second",
    })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(requests.at(-1)?.body.model).toBe(COPILOT_MODEL)
    expect(completedFrames(ws).map((response) => response.model)).toEqual([
      CUSTOM_ALIAS,
      CUSTOM_ALIAS,
    ])
  })

  test("routes a priority custom turn to its configured fast variant", async () => {
    configureCustomModels([
      { id: CUSTOM_MODEL, aliases: [CUSTOM_ALIAS], kind: "chat" },
      { id: `${CUSTOM_MODEL}-fast`, kind: "chat" },
    ])
    const ws = await createSocket()
    copilotResponses.push(() => copilotCompletedResponse("resp_seed"))
    await sendTurn(ws, { model: COPILOT_MODEL, input: "seed" })
    providerResponses.push(() => providerTextStream("fast answer"))
    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      service_tier: "priority",
      input: "hello",
    })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(providerRequests().map((request) => request.body.model)).toEqual([
      `${CUSTOM_MODEL}-fast`,
    ])
  })

  test("continues a custom model selected with an effort suffix", async () => {
    configureCustomModels([
      {
        id: CUSTOM_MODEL,
        aliases: [CUSTOM_ALIAS],
        kind: "chat",
        passReasoningEffort: true,
      },
    ])
    providerResponses.push(
      () => providerTextStream("first answer"),
      () => providerTextStream("second answer"),
    )
    const ws = await createSocket()
    await sendTurn(ws, { model: `${CUSTOM_ALIAS}:high`, input: "hello" })
    const first = completedFrames(ws).at(-1)
    await sendTurn(ws, {
      model: `${CUSTOM_ALIAS}:high`,
      previous_response_id: first?.id,
      input: "next",
    })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    expect(
      providerRequests().map((request) => [
        request.body.model,
        request.body.reasoning_effort,
      ]),
    ).toEqual([
      [CUSTOM_MODEL, "high"],
      [CUSTOM_MODEL, "high"],
    ])
  })

  test("answers a batch of restored tool calls on the next turn", async () => {
    providerResponses.push(providerToolCallsStream, () => {
      const unanswered = unansweredToolCalls(requests.at(-1)?.body ?? {})
      return unanswered.length > 0 ?
          Response.json(
            { error: { message: `unanswered: ${unanswered.join(",")}` } },
            { status: 400 },
          )
        : providerTextStream("batch done")
    })
    const ws = await createSocket()
    await sendTurn(ws, { model: CUSTOM_ALIAS, input: codexInput(), tools: [] })
    const first = completedFrames(ws).at(-1)
    expectRestoredToolCalls(first?.output)

    await sendTurn(ws, {
      model: CUSTOM_ALIAS,
      previous_response_id: first?.id,
      tools: [],
      input: [
        {
          type: "custom_tool_call_output",
          call_id: "call_exec_2",
          output: [{ type: "input_text", text: "hi" }],
        },
        {
          type: "function_call_output",
          call_id: "call_spawn_2",
          output: "spawned /root/opus",
        },
        { type: "function_call_output", call_id: "call_js_2", output: "2" },
      ],
    })

    expect(ws.sent.filter((frame) => frame.type === "error")).toEqual([])
    const second = providerRequests().at(-1)?.body ?? {}
    expect(unansweredToolCalls(second)).toEqual([])
    const batch = (
      second.messages as Array<{ tool_calls?: Array<{ id: string }> }>
    ).find((message) =>
      message.tool_calls?.some((call) => call.id === "call_exec_2"),
    )
    expect(batch?.tool_calls?.map((call) => call.id)).toEqual([
      "call_exec_2",
      "call_spawn_2",
      "call_js_2",
    ])
    expect(JSON.stringify(completedFrames(ws).at(-1)?.output)).toContain(
      "batch done",
    )
  })
})
