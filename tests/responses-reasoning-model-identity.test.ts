import { expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { setModelSettingsForTest } from "~/lib/model-settings"
import {
  adaptResponsesToMessagesCandidate,
  anthropicResponseToResponsesResult,
} from "~/routes/responses/messages-bridge"
import {
  anthropicReasoningModelIdentity,
  encodeAnthropicReasoningEnvelope,
} from "~/routes/responses/messages-reasoning-provenance"
import { expandCompactionItems } from "~/routes/responses/utils"

setModelSettingsForTest([])

function blocks(payload: AnthropicMessagesPayload) {
  return payload.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  )
}

/** A Claude 5.5 turn shown with progress updates, served as `servedModel`. */
function servedTurn(servedModel: string): Array<ResponseInputItem> {
  const response: AnthropicResponse = {
    id: "msg_served",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig-reasoning" },
      {
        type: "thinking",
        thinking: "Checking the failing test first.",
        signature: "sig-update",
      },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "exec_command",
        input: { cmd: "bun test" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  const source: ResponsesPayload = {
    model: servedModel,
    input: "Fix the failing test",
    tools: [{ type: "function", name: "exec_command" }],
  }
  const result = anthropicResponseToResponsesResult(
    response,
    "claude-opus-5.5",
    source,
    { progressUpdates: true },
  )
  return [
    { type: "message", role: "user", content: "Fix the failing test" },
    ...(result.output as unknown as Array<ResponseInputItem>),
    { type: "function_call_output", call_id: "toolu_1", output: "1 failed" },
  ]
}

async function translate(model: string, input: Array<ResponseInputItem>) {
  return await adaptResponsesToMessagesCandidate({
    source: {
      model,
      input,
      tools: [{ type: "function", name: "exec_command" }],
    },
  })
}

test.each([
  ["claude-opus-5.5", "claude-opus-5.5"],
  ["claude-opus-5-5", "claude-opus-5.5"],
  ["claude-opus-5-5-20261015", "claude-opus-5.5"],
  ["claude-opus-5.5-fast", "claude-opus-5.5"],
  ["claude-opus-5.5-1m", "claude-opus-5.5"],
  ["claude-opus-4-6-1m", "claude-opus-4.6"],
  ["claude-3-7-sonnet-20250219", "claude-3.7-sonnet"],
  ["claude-sonnet-5.5", "claude-sonnet-5.5"],
  ["claude-opus-5", "claude-opus-5"],
  ["gpt-6.1-sol", "gpt-6.1-sol"],
])("maps %s to the Anthropic model %s", (model, identity) => {
  expect(anthropicReasoningModelIdentity(model)).toBe(identity)
})

test.each(["claude-opus-5.5-fast", "claude-opus-5.5-1m", "claude-opus-5-5"])(
  "replays thinking served by claude-opus-5.5 when the next turn runs as %s",
  async (nextModel) => {
    const candidate = await translate(nextModel, servedTurn("claude-opus-5.5"))

    expect(blocks(candidate.payload)).toContainEqual({
      type: "thinking",
      thinking: "Checking the failing test first.",
      signature: "sig-update",
    })
    // The update is replayed once, as the signed thinking that produced it.
    expect(JSON.stringify(candidate.payload.messages)).not.toContain(
      '"text":"Checking the failing test first."',
    )
  },
)

test("keeps thinking out of a different Claude model and shows its update as text", async () => {
  const candidate = await translate(
    "claude-sonnet-5.5",
    servedTurn("claude-opus-5.5"),
  )

  expect(
    blocks(candidate.payload).some((block) => block.type === "thinking"),
  ).toBe(false)
  expect(JSON.stringify(candidate.payload)).not.toContain("sig-update")
  expect(blocks(candidate.payload)).toContainEqual({
    type: "text",
    text: "Checking the failing test first.",
  })
})

test("keeps a Claude envelope for another ID of the same model during compaction expansion", () => {
  const encrypted = encodeAnthropicReasoningEnvelope("claude-opus-5.5", [
    { type: "thinking", thinking: "Plan", signature: "sig" },
  ])
  const sameModel: ResponsesPayload = {
    model: "claude-opus-5.5-fast",
    input: [{ type: "reasoning", summary: [], encrypted_content: encrypted }],
  }
  const otherModel: ResponsesPayload = {
    model: "claude-opus-5",
    input: [{ type: "reasoning", summary: [], encrypted_content: encrypted }],
  }

  expandCompactionItems(sameModel)
  expandCompactionItems(otherModel)

  expect(sameModel).toHaveProperty("input.0.encrypted_content", encrypted)
  expect(otherModel).not.toHaveProperty("input.0.encrypted_content")
})
