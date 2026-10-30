import { afterEach, beforeEach, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ResponseInputItem } from "~/services/copilot/create-responses"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { adaptResponsesToMessagesCandidate } from "~/routes/responses/messages-bridge"
import { encodeAnthropicReasoningEnvelope } from "~/routes/responses/messages-reasoning-provenance"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalModels = state.models
const EXEC_TOOL = {
  type: "function" as const,
  name: "exec_command",
  parameters: { type: "object", properties: { cmd: { type: "string" } } },
}

beforeEach(() => {
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
})

/** A Codex turn: instructions, context, a signed tool call and its result. */
function codexTurn(): Array<ResponseInputItem> {
  return [
    { type: "message", role: "developer", content: "Sandbox: workspace" },
    { type: "message", role: "user", content: "Run the tests" },
    {
      type: "reasoning",
      summary: [],
      encrypted_content: encodeAnthropicReasoningEnvelope("claude-opus-5.5", [
        { type: "thinking", thinking: "Run them.", signature: "sig" },
      ]),
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "exec_command",
      arguments: '{"cmd":"bun test"}',
    },
    { type: "function_call_output", call_id: "call_1", output: "2 passed" },
  ]
}

function cacheMarkers(payload: AnthropicMessagesPayload): Array<unknown> {
  const markers: Array<unknown> = []
  JSON.stringify(payload, (key, value: unknown) => {
    if (key === "cache_control") markers.push(value)
    return value
  })
  return markers
}

test("marks the end of the instructions and of the conversation for the prompt cache", async () => {
  const { payload } = await adaptResponsesToMessagesCandidate({
    source: {
      model: "claude-opus-5.5",
      instructions: "You are Codex.",
      input: codexTurn(),
      tools: [EXEC_TOOL],
    },
  })

  expect(payload.system).toEqual([
    {
      type: "text",
      text: "You are Codex.\n\nSandbox: workspace",
      cache_control: { type: "ephemeral" },
    },
  ])
  expect(payload.messages.at(-1)).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: "2 passed",
        cache_control: { type: "ephemeral" },
      },
    ],
  })
  expect(cacheMarkers(payload)).toHaveLength(2)
})

test("never marks thinking or empty text, and marks a plain prompt as a block", async () => {
  const interrupted = await adaptResponsesToMessagesCandidate({
    source: {
      model: "claude-opus-5.5",
      input: [
        { type: "message", role: "user", content: "Continue" },
        {
          type: "reasoning",
          summary: [],
          encrypted_content: encodeAnthropicReasoningEnvelope(
            "claude-opus-5.5",
            [{ type: "thinking", thinking: "Unfinished", signature: "sig" }],
          ),
        },
      ],
    },
  })
  const plain = await adaptResponsesToMessagesCandidate({
    source: { model: "claude-opus-5.5", input: "Hello" },
  })

  expect(cacheMarkers(interrupted.payload)).toEqual([])
  expect(plain.payload.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
      ],
    },
  ])
})

test("sends prompt-cache markers to Messages for a Codex turn", async () => {
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.models = {
    object: "list",
    data: [
      {
        id: "claude-opus-5.5",
        name: "claude-opus-5.5",
        object: "model",
        version: "1",
        vendor: "anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          family: "claude",
          limits: { max_output_tokens: 4096 },
          object: "model_capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }
  const bodies: Array<AnthropicMessagesPayload> = []
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected a JSON request body")
    bodies.push(JSON.parse(init.body) as AnthropicMessagesPayload)
    return Promise.resolve(
      Response.json({
        id: "msg_cached",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "All tests pass." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 900,
          output_tokens: 5,
        },
      }),
    )
  }) as typeof fetch
  await seedProtocolDatabase()

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-5.5",
      instructions: "You are Codex.",
      input: codexTurn(),
      tools: [EXEC_TOOL],
    }),
  })

  expect(response.status).toBe(200)
  expect(bodies).toHaveLength(1)
  expect(cacheMarkers(bodies[0])).toEqual([
    { type: "ephemeral" },
    { type: "ephemeral" },
  ])
  expect(await response.json()).toMatchObject({
    usage: { input_tokens_details: { cached_tokens: 900 } },
  })
})
