import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { setModelFallbackConfigForTest } from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import {
  CHAT_REASONING_ENVELOPE_PREFIX,
  encodeChatReasoningEnvelope,
  readChatReasoningEnvelope,
  sharesChatReasoningModel,
} from "~/routes/responses/chat-reasoning-provenance"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const CHAT_MODEL = "chat-only-reasoner"
const calls: Array<Record<string, unknown>> = []
const upstream: Array<Response> = []

const READ_TOOL = {
  type: "function",
  name: "read",
  parameters: { type: "object", properties: {} },
}
const READ_CALL = {
  id: "call_read",
  type: "function",
  function: { name: "read", arguments: "{}" },
}

function chatModel(id: string): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      family: id,
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function chatStream(
  chunks: Array<{ delta: Record<string, unknown>; finish?: string }>,
): Response {
  const frames = chunks.map(({ delta, finish }) => {
    const chunk = {
      id: "chat_turn",
      object: "chat.completion.chunk",
      created: 1,
      model: CHAT_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  })
  return new Response(`${frames.join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function chatCompletion(message: Record<string, unknown>): Response {
  return Response.json({
    id: "chat_turn",
    object: "chat.completion",
    created: 1,
    model: CHAT_MODEL,
    choices: [
      { index: 0, message, finish_reason: "tool_calls", logprobs: null },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  })
}

beforeEach(() => {
  calls.length = 0
  upstream.length = 0
  Object.assign(state, {
    copilotToken: "test-token",
    githubToken: "test-token",
    accountType: "individual",
    isMultiToken: false,
    manualApprove: false,
    apiKeyAuth: undefined,
    models: { object: "list", data: [chatModel(CHAT_MODEL)] },
  })
  setConfigForTest({})
  setModelFallbackConfigForTest(null)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected serialized inference body")
    calls.push(JSON.parse(init.body) as Record<string, unknown>)
    const response = upstream.shift()
    if (!response) throw new Error("Unexpected upstream request")
    return Promise.resolve(response)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
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
    body: JSON.stringify({ model: CHAT_MODEL, tools: [READ_TOOL], ...payload }),
  })
}

async function completedOutput(
  response: Response,
): Promise<Array<Record<string, unknown>>> {
  expect(response.status).toBe(200)
  const text = await response.text()
  for (const frame of text.split("\n\n")) {
    const line = frame.split("\n").find((entry) => entry.startsWith("data: "))
    if (!line) continue
    const event = JSON.parse(line.slice(6)) as Record<string, unknown>
    if (event.type === "response.completed") {
      return (event.response as { output: Array<Record<string, unknown>> })
        .output
    }
  }
  throw new Error("Expected a completed Responses stream")
}

/** Codex replays history without the item IDs Copilot issued, or any here. */
function withoutItemIds(
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return items.map(({ id: _id, ...item }) => item)
}

async function continueTurn(
  output: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  upstream.push(chatStream([{ delta: { content: "Done." }, finish: "stop" }]))
  await completedOutput(
    await post({
      stream: true,
      input: [
        { type: "message", role: "user", content: "Fix it." },
        ...withoutItemIds(output),
        { type: "function_call_output", call_id: "call_read", output: "text" },
      ],
    }),
  )
  return calls.at(-1)?.messages as Array<Record<string, unknown>>
}

const REPLAYED_TURN = {
  role: "assistant",
  content: "Reading it.",
  reasoning_text: "Checked the file.",
  tool_calls: [READ_CALL],
}

test("a streamed Chat turn keeps its reasoning state when Codex clears item IDs", async () => {
  upstream.push(
    chatStream([
      { delta: { role: "assistant", reasoning_text: "Checked the file." } },
      { delta: { content: "Reading it.", reasoning_opaque: "partial-state" } },
      {
        delta: {
          tool_calls: [{ index: 0, ...READ_CALL }],
          reasoning_opaque: "complete-state",
        },
        finish: "tool_calls",
      },
    ]),
  )

  const output = await completedOutput(
    await post({ stream: true, input: "Fix it." }),
  )

  expect(output.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
    "function_call",
  ])
  expect(readChatReasoningEnvelope(output[0].encrypted_content)).toEqual({
    model: CHAT_MODEL,
    reasoning_opaque: "complete-state",
  })
  const messages = await continueTurn(output)
  expect(messages).toHaveLength(3)
  expect(messages[1]).toEqual({
    ...REPLAYED_TURN,
    reasoning_opaque: "complete-state",
  })
  expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_read" })
})

test("a buffered Chat turn keeps its reasoning state when Codex clears item IDs", async () => {
  upstream.push(
    chatCompletion({
      role: "assistant",
      content: "Reading it.",
      reasoning_text: "Checked the file.",
      reasoning_opaque: "buffered-state",
      tool_calls: [READ_CALL],
    }),
  )
  const first = await post({ input: "Fix it." })
  expect(first.status).toBe(200)
  const { output } = (await first.json()) as {
    output: Array<Record<string, unknown>>
  }

  expect(output[0]).toMatchObject({ id: "rs_chat_turn", type: "reasoning" })
  const messages = await continueTurn(output)
  expect(messages[1]).toEqual({
    ...REPLAYED_TURN,
    reasoning_opaque: "buffered-state",
  })
})

test("binds Chat reasoning state to the model that produced it", () => {
  const envelope = encodeChatReasoningEnvelope("claude-sonnet-4.5", {
    reasoning_opaque: "signature",
    encrypted_content: "state",
  })

  expect(readChatReasoningEnvelope(envelope)).toEqual({
    model: "claude-sonnet-4.5",
    reasoning_opaque: "signature",
    encrypted_content: "state",
  })
  expect(
    sharesChatReasoningModel("claude-sonnet-4.5", "claude-sonnet-4-5-20250929"),
  ).toBe(true)
  expect(sharesChatReasoningModel("gemini-3-pro", "gemini-3-flash")).toBe(false)
})

test.each([
  ["another value", "copilot-reasoning-state"],
  ["an empty envelope", CHAT_REASONING_ENVELOPE_PREFIX],
  ["a malformed envelope", `${CHAT_REASONING_ENVELOPE_PREFIX}not+base64url`],
  [
    "an envelope without a model",
    `${CHAT_REASONING_ENVELOPE_PREFIX}${Buffer.from('{"reasoning_opaque":"x"}').toString("base64url")}`,
  ],
  [
    "an envelope with unreadable state",
    `${CHAT_REASONING_ENVELOPE_PREFIX}${Buffer.from('{"model":"m","reasoning_opaque":1}').toString("base64url")}`,
  ],
])("reads no Chat reasoning state from %s", (_name, value) => {
  expect(readChatReasoningEnvelope(value)).toBeUndefined()
})
