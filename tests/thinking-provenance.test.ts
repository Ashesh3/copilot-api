import { beforeEach, expect, test } from "bun:test"

import {
  createThinkingStreamRecorder,
  foreignThinkingProducers,
  recordResponseThinking,
  rememberRejectedThinkingProducers,
  resetThinkingProvenanceForTest,
  rewriteLearnedForeignThinking,
  rewriteRejectedThinking,
} from "~/services/copilot/thinking-provenance"

beforeEach(() => {
  resetThinkingProvenanceForTest()
})

function thinking(text: string, signature: string) {
  return { type: "thinking", thinking: text, signature }
}

function recordSigned(
  model: string,
  blocks: Array<Record<string, unknown>>,
  account?: number,
): void {
  recordResponseThinking({ content: blocks }, { model, account })
}

/** A Droid session that moved from Opus to Sonnet and back to Sonnet tools. */
function switchedConversation(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 64,
    messages: [
      { role: "user", content: "Plan the change." },
      {
        role: "assistant",
        content: [
          thinking("Opus planned the change.", "sig-opus"),
          { type: "redacted_thinking", data: "redacted-opus" },
          { type: "text", text: "Plan ready." },
        ],
      },
      { role: "user", content: "Now implement it." },
      {
        role: "assistant",
        content: [
          thinking("Sonnet chose the file.", "sig-sonnet"),
          { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        ],
      },
    ],
  }
}

test("rewrites only the thinking another model signed, keeping its own", () => {
  recordSigned("claude-opus-5.5", [
    thinking("Opus planned the change.", "sig-opus"),
    { type: "redacted_thinking", data: "redacted-opus" },
  ])
  recordSigned("claude-sonnet-5.5", [
    thinking("Sonnet chose the file.", "sig-sonnet"),
  ])
  const body = switchedConversation("claude-sonnet-5.5")

  expect(foreignThinkingProducers(body)).toEqual(new Set(["claude-opus-5.5"]))
  expect(rewriteRejectedThinking(body)).toBe(true)
  expect(body.messages).toEqual([
    { role: "user", content: "Plan the change." },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<thinking>\nOpus planned the change.\n</thinking>",
        },
        { type: "text", text: "Plan ready." },
      ],
    },
    { role: "user", content: "Now implement it." },
    {
      role: "assistant",
      content: [
        thinking("Sonnet chose the file.", "sig-sonnet"),
        { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
    },
  ])
})

test("treats unrecorded thinking as unverified but keeps unknown redacted blocks", () => {
  recordSigned("claude-sonnet-5.5", [
    thinking("Sonnet chose the file.", "sig-sonnet"),
  ])
  const body = switchedConversation("claude-sonnet-5.5")

  expect(rewriteRejectedThinking(body)).toBe(true)
  expect(body).toHaveProperty("messages.1.content", [
    { type: "text", text: "<thinking>\nOpus planned the change.\n</thinking>" },
    { type: "redacted_thinking", data: "redacted-opus" },
    { type: "text", text: "Plan ready." },
  ])
  expect(body).toHaveProperty(
    "messages.3.content.0",
    thinking("Sonnet chose the file.", "sig-sonnet"),
  )
})

test("keeps every readable thought when the model signed all of them", () => {
  recordSigned("claude-sonnet-5.5", [
    thinking("Opus planned the change.", "sig-opus"),
    thinking("Sonnet chose the file.", "sig-sonnet"),
  ])
  const body = switchedConversation("claude-sonnet-5.5")

  expect(rewriteRejectedThinking(body)).toBe(true)
  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain('"type":"thinking"')
  expect(serialized).toContain(
    String.raw`<thinking>\nOpus planned the change.\n</thinking>`,
  )
  expect(serialized).toContain(
    String.raw`<thinking>\nSonnet chose the file.\n</thinking>`,
  )
  expect(serialized).toContain('"redacted_thinking"')
})

test("drops an assistant turn left empty and thinking with no text", () => {
  const body: Record<string, unknown> = {
    model: "claude-sonnet-5.5",
    messages: [
      { role: "user", content: "One." },
      { role: "assistant", content: [thinking("  ", "sig-empty")] },
      { role: "user", content: "Two." },
      {
        role: "assistant",
        content: [
          {
            ...thinking("Cached thought.", "sig-cached"),
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  }

  expect(rewriteRejectedThinking(body)).toBe(true)
  expect(body).toHaveProperty("messages", [
    { role: "user", content: "One." },
    { role: "user", content: "Two." },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<thinking>\nCached thought.\n</thinking>",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ])
})

test("records signatures from streamed thinking, including split deltas", () => {
  const record = createThinkingStreamRecorder({ model: "claude-opus-5.5" })
  const events: Array<Record<string, unknown>> = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Streamed." },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "streamed" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: "redacted-streamed" },
    },
    { type: "content_block_stop", index: 1 },
  ]
  for (const event of events) {
    record({ event: String(event.type), data: JSON.stringify(event) })
  }
  const body = {
    model: "claude-sonnet-5.5",
    messages: [
      {
        role: "assistant",
        content: [
          thinking("Streamed.", "sig-streamed"),
          { type: "redacted_thinking", data: "redacted-streamed" },
          thinking("Partial.", "sig-"),
        ],
      },
    ],
  }

  expect(foreignThinkingProducers(body)).toEqual(new Set(["claude-opus-5.5"]))
  expect(rewriteRejectedThinking(body)).toBe(true)
  expect(body).toHaveProperty("messages.0.content", [
    { type: "text", text: "<thinking>\nStreamed.\n</thinking>" },
    { type: "text", text: "<thinking>\nPartial.\n</thinking>" },
  ])
})

test("rewrites learned rejected producers before sending, on a clone", () => {
  recordSigned("claude-opus-5.5", [
    thinking("Opus planned the change.", "sig-opus"),
    { type: "redacted_thinking", data: "redacted-opus" },
  ])
  recordSigned("claude-sonnet-5.5", [
    thinking("Sonnet chose the file.", "sig-sonnet"),
  ])
  const body = switchedConversation("claude-sonnet-5.5")
  const snapshot = structuredClone(body)

  expect(rewriteLearnedForeignThinking(body)).toBe(body)
  rememberRejectedThinkingProducers(["claude-opus-5.5"], "claude-sonnet-5.5")
  const rewritten = rewriteLearnedForeignThinking(body)

  expect(body).toEqual(snapshot)
  expect(rewritten).toHaveProperty("messages.1.content", [
    { type: "text", text: "<thinking>\nOpus planned the change.\n</thinking>" },
    { type: "text", text: "Plan ready." },
  ])
  expect(rewritten).toHaveProperty(
    "messages.3.content.0",
    thinking("Sonnet chose the file.", "sig-sonnet"),
  )
  // The pair is directional: Opus may still verify its own history.
  const opusRequest = switchedConversation("claude-opus-5.5")
  expect(rewriteLearnedForeignThinking(opusRequest)).toBe(opusRequest)
})

test("keeps the answering account's thinking after a pool moved the session", () => {
  recordSigned(
    "claude-sonnet-5.5",
    [thinking("Opus planned the change.", "sig-opus")],
    1,
  )
  recordSigned(
    "claude-sonnet-5.5",
    [thinking("Sonnet chose the file.", "sig-sonnet")],
    2,
  )
  const onSecond = switchedConversation("claude-sonnet-5.5")
  const unrouted = switchedConversation("claude-sonnet-5.5")
  // A model switch is not learned from an account move.
  expect(foreignThinkingProducers(onSecond)).toEqual(new Set())

  expect(rewriteRejectedThinking(onSecond, 2)).toBe(true)
  expect(onSecond).toHaveProperty("messages.1.content.0", {
    type: "text",
    text: "<thinking>\nOpus planned the change.\n</thinking>",
  })
  expect(onSecond).toHaveProperty(
    "messages.3.content.0",
    thinking("Sonnet chose the file.", "sig-sonnet"),
  )
  // No known account: same-model blocks are kept, so all readable thinking
  // becomes text only as the last resort.
  expect(rewriteRejectedThinking(unrouted)).toBe(true)
  expect(JSON.stringify(unrouted)).not.toContain('"type":"thinking"')
})
