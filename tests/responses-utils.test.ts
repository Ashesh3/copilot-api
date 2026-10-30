import { afterAll, expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import { setModelSettingsForTest } from "../src/lib/model-settings"
import { encodeChatReasoningEnvelope } from "../src/routes/responses/chat-reasoning-provenance"
import { encodeAnthropicReasoningEnvelope } from "../src/routes/responses/messages-reasoning-provenance"
import { expandCompactionItems } from "../src/routes/responses/utils"
import {
  finalizeNativeResponsesRequest,
  prepareResponsesRequest,
} from "../src/services/copilot/responses-contract"

setModelSettingsForTest([])
afterAll(() => setModelSettingsForTest([]))

test("retains translated Claude thinking for the matching Messages continuation", () => {
  const encrypted = encodeAnthropicReasoningEnvelope("claude-opus-5.5", [
    {
      type: "thinking",
      thinking: "Continue the tool workflow.",
      signature: "synthetic-claude-signature",
    },
  ])
  const payload: ResponsesPayload = {
    model: "claude-opus-5.5",
    input: [{ type: "reasoning", summary: [], encrypted_content: encrypted }],
  }

  expandCompactionItems(payload)

  expect(payload).toHaveProperty("input.0.encrypted_content", encrypted)
})

test("does not replay foreign reasoning into another model after a model switch", () => {
  const encrypted = encodeAnthropicReasoningEnvelope("claude-opus-5.5", [
    {
      type: "redacted_thinking",
      data: "synthetic-opaque-claude-thinking",
    },
  ])
  const payload: ResponsesPayload = {
    model: "gpt-5.5",
    input: [
      {
        type: "reasoning",
        id: "rs_claude_turn",
        summary: [],
        encrypted_content: encrypted,
      },
    ],
  }

  expandCompactionItems(payload)

  // The gateway issued the ID too, so the item is not left as a reference.
  expect(payload.input).toEqual([{ type: "reasoning", summary: [] }])
})

test("replays Copilot reasoning state so the model keeps its reasoning", () => {
  const reasoning = {
    type: "reasoning" as const,
    summary: [{ type: "summary_text", text: "Planned the change." }],
    encrypted_content: "copilot-reasoning-state",
  }
  const payload: ResponsesPayload = { model: "gpt-6-astra", input: [reasoning] }

  expandCompactionItems(payload)

  expect(payload.input).toEqual([reasoning])
})

test.each([null, ""])("drops reasoning state that is %p", (state) => {
  const payload = {
    model: "gpt-6-astra",
    input: [{ type: "reasoning", summary: [], encrypted_content: state }],
  } as unknown as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([{ type: "reasoning", summary: [] }])
})

test("strips bridge-owned Claude envelopes from the native Responses candidate", () => {
  const encrypted = encodeAnthropicReasoningEnvelope("dual-protocol-model", [
    {
      type: "thinking",
      thinking: "Visible reasoning stays available.",
      signature: "synthetic-claude-signature",
    },
  ])
  const source: ResponsesPayload = {
    model: "dual-protocol-model",
    input: [
      {
        type: "reasoning",
        id: "rs_bridge_turn",
        summary: [
          { type: "summary_text", text: "Visible reasoning stays available." },
        ],
        encrypted_content: encrypted,
      },
    ],
  }
  const candidate = finalizeNativeResponsesRequest(
    prepareResponsesRequest(source),
    {
      model: "dual-protocol-model",
      implicitDefault: false,
    },
  )

  expect(candidate.body).not.toHaveProperty("input.0.encrypted_content")
  expect(candidate.body).not.toHaveProperty("input.0.id")
  expect(candidate.body).toHaveProperty(
    "input.0.summary.0.text",
    "Visible reasoning stays available.",
  )
  expect(source).toHaveProperty("input.0.encrypted_content", encrypted)
})

test("strips gateway-owned Chat reasoning from the native Responses candidate", () => {
  const encrypted = encodeChatReasoningEnvelope("chat-only-model", {
    reasoning_opaque: "chat-reasoning-state",
  })
  const source: ResponsesPayload = {
    model: "gpt-5.5",
    input: [
      {
        type: "reasoning",
        id: "rs_chat_turn",
        summary: [{ type: "summary_text", text: "Chat model reasoning." }],
        encrypted_content: encrypted,
      },
    ],
  }

  expandCompactionItems(source)
  const candidate = finalizeNativeResponsesRequest(
    prepareResponsesRequest(source),
    { model: "gpt-5.5", implicitDefault: false },
  )

  expect(candidate.body).not.toHaveProperty("input.0.encrypted_content")
  expect(candidate.body).not.toHaveProperty("input.0.id")
  expect(candidate.body).toHaveProperty(
    "input.0.summary.0.text",
    "Chat model reasoning.",
  )
  expect(source).toHaveProperty("input.0.encrypted_content", encrypted)
})

test("preserves native compaction items for the upstream account", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "compaction",
        encrypted_content: "opaque-native-compaction",
      },
    ],
  } as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([
    {
      type: "compaction",
      encrypted_content: "opaque-native-compaction",
    },
  ])
})

test("expands proxy-generated compaction items as a compatibility fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        id: "cmp_123",
        type: "compaction",
        encrypted_content: Buffer.from("summary").toString("base64"),
      },
    ],
  } as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([
    {
      type: "message",
      role: "user",
      content: "[Previous conversation summary]\nsummary",
    },
  ])
})

test("decodes Unicode proxy-generated compaction summaries", () => {
  const summary = "Résumé — पिछला संदर्भ"
  const payload = {
    model: "gpt-4o",
    input: [
      {
        id: "cmp_unicode",
        type: "compaction",
        encrypted_content: Buffer.from(summary).toString("base64"),
      },
    ],
  } as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([
    {
      type: "message",
      role: "user",
      content: `[Previous conversation summary]\n${summary}`,
    },
  ])
})

test("drops superseded history before the latest compaction item", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "message",
        role: "user",
        content: "superseded history",
      },
      {
        id: "cmp_native_older",
        type: "compaction",
        encrypted_content: "opaque-older-compaction",
      },
      {
        type: "message",
        role: "assistant",
        content: "also superseded",
      },
      {
        id: "cmp_native_latest",
        type: "compaction",
        encrypted_content: "opaque-native-compaction",
      },
      {
        type: "message",
        role: "user",
        content: "post-compaction work",
      },
    ],
  } as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([
    {
      id: "cmp_native_latest",
      type: "compaction",
      encrypted_content: "opaque-native-compaction",
    },
    {
      type: "message",
      role: "user",
      content: "post-compaction work",
    },
  ])
})

test("preserves the latest compacted window bootstrap and tool declarations", () => {
  const latestTurnId = "turn_latest"
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "function", name: "exec" }],
      },
      {
        type: "message",
        role: "user",
        content: "superseded conversation",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_old" },
      },
      {
        type: "message",
        role: "developer",
        content: "current permissions, app, and skill instructions",
        internal_chat_message_metadata_passthrough: {
          turn_id: latestTurnId,
        },
      },
      {
        type: "message",
        role: "developer",
        content: "current collaboration instructions",
        internal_chat_message_metadata_passthrough: {
          turn_id: latestTurnId,
        },
      },
      {
        type: "message",
        role: "developer",
        content: "current multi-agent policy",
        internal_chat_message_metadata_passthrough: {
          turn_id: latestTurnId,
        },
      },
      {
        type: "message",
        role: "user",
        content: "current AGENTS and environment context",
        internal_chat_message_metadata_passthrough: {
          turn_id: latestTurnId,
        },
      },
      {
        type: "message",
        role: "user",
        content: "continue",
        internal_chat_message_metadata_passthrough: {
          turn_id: latestTurnId,
        },
      },
      {
        id: "cmp_native_latest",
        type: "compaction",
        encrypted_content: "opaque-native-compaction",
      },
      {
        type: "message",
        role: "user",
        content: "post-compaction work",
      },
    ],
  } as ResponsesPayload

  expandCompactionItems(payload)

  expect(payload.input).toEqual([
    {
      type: "additional_tools",
      role: "developer",
      tools: [{ type: "function", name: "exec" }],
    },
    {
      type: "message",
      role: "developer",
      content: "current permissions, app, and skill instructions",
      internal_chat_message_metadata_passthrough: {
        turn_id: latestTurnId,
      },
    },
    {
      type: "message",
      role: "developer",
      content: "current collaboration instructions",
      internal_chat_message_metadata_passthrough: {
        turn_id: latestTurnId,
      },
    },
    {
      type: "message",
      role: "developer",
      content: "current multi-agent policy",
      internal_chat_message_metadata_passthrough: {
        turn_id: latestTurnId,
      },
    },
    {
      type: "message",
      role: "user",
      content: "current AGENTS and environment context",
      internal_chat_message_metadata_passthrough: {
        turn_id: latestTurnId,
      },
    },
    {
      type: "message",
      role: "user",
      content: "continue",
      internal_chat_message_metadata_passthrough: {
        turn_id: latestTurnId,
      },
    },
    {
      id: "cmp_native_latest",
      type: "compaction",
      encrypted_content: "opaque-native-compaction",
    },
    {
      type: "message",
      role: "user",
      content: "post-compaction work",
    },
  ])
})
