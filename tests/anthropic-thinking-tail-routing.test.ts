import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type { ResponsesWebSocketData } from "~/routes/responses/websocket"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { encodeAnthropicReasoningEnvelope } from "~/routes/responses/messages-reasoning-provenance"
import { responsesWebSocket } from "~/routes/responses/websocket"
import { server } from "~/server"
import { createAnthropicMessages } from "~/services/copilot/create-anthropic-messages"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const captures: Array<AnthropicMessagesPayload> = []
const completeThinking = {
  type: "thinking" as const,
  thinking: "Completed synthetic reasoning.",
  signature: "completed-native-signature",
}
const completedCall = {
  type: "tool_use" as const,
  id: "toolu_completed",
  name: "echo",
  input: { value: "hello" },
}
const completedResult = {
  type: "tool_result" as const,
  tool_use_id: "toolu_completed",
  content: "hello",
}

function upstreamError(payload: AnthropicMessagesPayload): string | undefined {
  const last = payload.messages.findLast(
    (message) => message.role !== "system" && message.role !== "developer",
  )
  if (last?.role !== "assistant") return undefined
  const assistantTail =
    typeof last.content === "string" ? "text" : last.content.at(-1)?.type
  if (assistantTail === "thinking" || assistantTail === "redacted_thinking") {
    return "The final block in an assistant message cannot be `thinking`."
  }
  return "This model does not support assistant message prefill. The conversation must end with a user message."
}

beforeAll(() => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname !== "/v1/messages" || typeof init?.body !== "string") {
      throw new Error("Expected native Messages dispatch")
    }
    const body = JSON.parse(init.body) as AnthropicMessagesPayload
    captures.push(body)
    const error = upstreamError(body)
    return Promise.resolve(
      error ?
        Response.json(
          {
            type: "error",
            error: { type: "invalid_request_error", message: error },
          },
          { status: 400 },
        )
      : Response.json({
          id: "msg_repaired_tail",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
    )
  }) as typeof fetch
})

beforeEach(async () => {
  captures.length = 0
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "synthetic-upstream-token",
    githubToken: "synthetic-oauth-token",
    isMultiToken: false,
    manualApprove: false,
    models: {
      object: "list",
      data: [
        {
          id: "claude-opus-5.5",
          name: "Claude Opus 5.5",
          object: "model",
          version: "1",
          supported_endpoints: ["/v1/messages"],
          capabilities: {
            family: "claude",
            limits: { max_output_tokens: 1024 },
            object: "model_capabilities",
            supports: {},
            tokenizer: "cl100k_base",
            type: "chat",
          },
        },
      ],
    },
  })
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  await seedProtocolDatabase()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

function requestWithPrefix(): AnthropicMessagesPayload {
  return {
    model: "claude-opus-5.5",
    max_tokens: 1024,
    output_config: { effort: "max" },
    tools: [
      {
        name: "echo",
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ],
    messages: [
      { role: "user", content: "Echo hello." },
      { role: "assistant", content: [completeThinking] },
      { role: "assistant", content: [completedCall] },
      { role: "user", content: [completedResult] },
      { role: "user", content: "Reply hello only." },
    ],
  }
}

function assertCompletePrefix(payload: AnthropicMessagesPayload): void {
  const blocks = payload.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  )
  expect(blocks).toContainEqual(completeThinking)
  expect(blocks).toContainEqual(completedCall)
  expect(blocks).toContainEqual(completedResult)
  expect(upstreamError(payload)).toBeUndefined()
  expect(payload.messages.at(-1)?.role).toBe("user")
}

async function post(path: string, body: unknown): Promise<Response> {
  return await server.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

test.each([
  { name: "ordinary", options: {} },
  { name: "alreadyAdapted", options: { alreadyAdapted: true } },
])(
  "repairs an empty thinking tail on the $name native transport and keeps complete split tool history",
  async ({ options }) => {
    const source = requestWithPrefix()
    source.messages.push({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          signature: "incomplete-native-signature",
        },
      ],
    })
    const snapshot = structuredClone(source)

    const response = (await createAnthropicMessages(
      source,
      options,
    )) as AnthropicResponse

    expect(response.content).toEqual([{ type: "text", text: "hello" }])
    expect(captures).toHaveLength(1)
    assertCompletePrefix(captures[0])
    expect(JSON.stringify(captures[0])).not.toContain(
      "incomplete-native-signature",
    )
    expect(captures[0].output_config?.effort).toBe("max")
    expect(source).toEqual(snapshot)
  },
)

test.each([false, true])(
  "public Messages preserves readable orphan reasoning without prefill (has text=%s)",
  async (hasText) => {
    const source = requestWithPrefix()
    source.messages.push({
      role: "assistant",
      content: [
        ...(hasText ?
          [{ type: "text" as const, text: "Synthetic partial response." }]
        : []),
        {
          type: "thinking",
          thinking: "The requested word is hello.",
          signature: "orphan-native-signature",
        },
      ],
    })

    const response = await post("/v1/messages", source)

    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty("content.0.text", "hello")
    assertCompletePrefix(captures[0])
    const repaired = JSON.stringify(captures[0].messages)
    expect(repaired).toContain("The requested word is hello.")
    expect(repaired).toContain("[Unfinished assistant reasoning]")
    expect(repaired).not.toContain("orphan-native-signature")
    if (hasText) expect(repaired).toContain("Synthetic partial response.")
  },
)

test("public Messages preserves historical signed thinking-only turns before a user message", async () => {
  const source = requestWithPrefix()
  source.messages.push(
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          signature: "historical-native-signature",
        },
      ],
    },
    { role: "user", content: "Continue. Reply hello only." },
  )
  const snapshot = structuredClone(source)

  const response = await post("/v1/messages", source)

  expect(response.status).toBe(200)
  expect(await response.json()).toHaveProperty("content.0.text", "hello")
  expect(captures).toHaveLength(1)
  expect(captures[0].messages).toEqual(snapshot.messages)
  expect(source).toEqual(snapshot)
})

function responsesHistory(orphanText: string) {
  return {
    model: "claude-opus-5.5",
    max_output_tokens: 1024,
    tools: [
      {
        type: "function",
        name: "echo",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ],
    input: [
      { role: "user", content: "Echo hello." },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: completeThinking.thinking }],
        encrypted_content: encodeAnthropicReasoningEnvelope("claude-opus-5.5", [
          completeThinking,
        ]),
      },
      {
        type: "function_call",
        call_id: "toolu_completed",
        name: "echo",
        arguments: '{"value":"hello"}',
      },
      {
        type: "function_call_output",
        call_id: "toolu_completed",
        output: "hello",
      },
      { role: "user", content: "Reply hello only." },
      {
        type: "reasoning",
        summary: orphanText ? [{ type: "summary_text", text: orphanText }] : [],
        encrypted_content: encodeAnthropicReasoningEnvelope("claude-opus-5.5", [
          {
            type: "thinking",
            thinking: orphanText,
            signature: "orphan-envelope-signature",
          },
        ]),
      },
    ],
  }
}

test("Responses HTTP removes an empty restored reasoning tail while keeping signed tool rounds", async () => {
  const response = await post("/v1/responses", responsesHistory(""))

  expect(response.status).toBe(200)
  expect(await response.json()).toHaveProperty("output_text", "hello")
  assertCompletePrefix(captures[0])
  expect(JSON.stringify(captures[0])).not.toContain("orphan-envelope-signature")
})

test("Responses WebSocket preserves readable restored orphan reasoning as context", async () => {
  const frames: Array<{ type: string; response?: { output_text?: string } }> =
    []
  const data: ResponsesWebSocketData = {
    activeTurns: new Map(),
    closed: false,
    nextTurnSequence: 0,
    type: "responses",
    requestId: "synthetic-thinking-tail",
    nativeMessagesOptions: {},
    effectiveNativeMessagesOptions: {},
    responseSnapshots: new Map(),
  }
  const socket = {
    data,
    send(frame: string): void {
      frames.push(JSON.parse(frame) as (typeof frames)[number])
    },
    close(): void {},
  }

  await responsesWebSocket.message(
    socket,
    JSON.stringify({
      type: "response.create",
      ...responsesHistory("The requested word is hello."),
    }),
  )

  expect(frames.at(-1)?.type).toBe("response.completed")
  expect(frames.at(-1)?.response?.output_text).toBe("hello")
  assertCompletePrefix(captures[0])
  expect(JSON.stringify(captures[0].messages)).toContain(
    "The requested word is hello.",
  )
  expect(JSON.stringify(captures[0].messages)).not.toContain(
    "orphan-envelope-signature",
  )
  expect(data.activeTurns.size).toBe(0)
})
