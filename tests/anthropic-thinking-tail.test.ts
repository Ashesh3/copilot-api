import { expect, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import { normalizeAnthropicMessagesRequest } from "~/services/copilot/messages-contract"

const emptyThinking = {
  type: "thinking",
  thinking: "",
  signature: "synthetic-valid-signature",
}
const signedThinking = {
  type: "thinking",
  thinking: "Inspect the existing result first.",
  signature: "synthetic-valid-signature",
}
const user = { role: "user", content: "Continue the requested work." }

function normalize(messages: Array<Record<string, unknown>>) {
  return normalizeAnthropicMessagesRequest({
    model: "claude-opus-5.5",
    messages,
  })
}

test("removes the captured empty signed thinking-only assistant tail", () => {
  const source = [
    user,
    { role: "user", content: "Resume." },
    { role: "assistant", content: [emptyThinking] },
  ]
  const snapshot = structuredClone(source)
  const result = normalize(source)
  expect(result.messages).toEqual([user, { role: "user", content: "Resume." }])
  expect(source).toEqual(snapshot)
  expect(normalizeAnthropicMessagesRequest(result)).toEqual(result)
})

test("keeps complete thinking followed by text or a matched tool call intact", () => {
  const source = [
    user,
    {
      role: "assistant",
      content: [emptyThinking, { type: "text", text: "Starting." }],
    },
    user,
    {
      role: "assistant",
      content: [
        signedThinking,
        {
          type: "tool_use",
          id: "call_1",
          name: "read",
          input: { path: "fixture" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "read result" },
      ],
    },
  ]
  expect(normalize(source).messages).toEqual(source)
})

test("treats adjacent assistant records as one turn when thinking precedes an answer", () => {
  const source = [
    user,
    { role: "assistant", content: [emptyThinking] },
    { role: "assistant", content: [{ type: "text", text: "An answer." }] },
    user,
  ]
  expect(normalize(source).messages).toEqual(source)
})

test("preserves thinking-only suffixes in historical assistant turns", () => {
  const source = [
    user,
    {
      role: "assistant",
      content: [
        signedThinking,
        { type: "text", text: "An answer." },
        emptyThinking,
      ],
    },
    user,
  ]
  expect(normalize(source).messages).toEqual(source)
})

test("removes repeated opaque-only assistant records without leaving empty messages", () => {
  const source = [
    user,
    { role: "assistant", content: [emptyThinking] },
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "synthetic-opaque" },
        emptyThinking,
      ],
    },
  ]
  expect(normalize(source).messages).toEqual([user])
})

test("retains readable unfinished reasoning as user context without unsupported prefill", () => {
  const result = normalize([
    user,
    { role: "assistant", content: [signedThinking] },
  ])
  expect(result).toHaveProperty("messages.1.role", "user")
  expect(result).toHaveProperty("messages.1.content.0.type", "text")
  expect(result).toHaveProperty(
    "messages.1.content.0.text",
    "[Unfinished assistant reasoning]\nInspect the existing result first.",
  )
  expect(JSON.stringify(result)).not.toContain("synthetic-valid-signature")
  expect(normalizeAnthropicMessagesRequest(result)).toEqual(result)
})

test("keeps native signatures in valid historical thinking-only messages", () => {
  const result = normalize([
    user,
    { role: "assistant", content: [signedThinking] },
    user,
  ])
  expect(result).toHaveProperty("messages.1.role", "assistant")
  expect(result).toHaveProperty("messages.1.content.0", signedThinking)
  expect(result).toHaveProperty("messages.2", user)
})

test("preserves partial assistant text and resumes after removing its empty thinking tail", () => {
  const result = normalize([
    user,
    {
      role: "assistant",
      content: [{ type: "text", text: "Partial answer." }, emptyThinking],
    },
  ])
  expect(result).toHaveProperty("messages.1", {
    role: "assistant",
    content: [{ type: "text", text: "Partial answer." }],
  })
  expect(result).toHaveProperty("messages.2.role", "user")
  expect(result).toHaveProperty(
    "messages.2.content.0.text",
    "Continue the interrupted assistant response.",
  )
})

test("preserves readable context before a following tool result without breaking tool pairing", () => {
  const result = normalize([
    user,
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "read", input: {} },
        signedThinking,
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "result" },
      ],
    },
  ])
  expect(result).toHaveProperty("messages.1.role", "assistant")
  expect(result).toHaveProperty("messages.1.content.0.id", "call_1")
  expect(result).toHaveProperty("messages.1.content.1", signedThinking)
  expect(result).toHaveProperty("messages.2.content.0.tool_use_id", "call_1")
})

test("rejects an empty reasoning-only request rather than dispatching no messages", () => {
  expect(() =>
    normalize([{ role: "assistant", content: [emptyThinking] }]),
  ).toThrow(LocalHTTPError)
})

test("does not change thinking configuration or unrelated tool payloads", () => {
  const source = {
    model: "claude-opus-5.5",
    messages: [user, { role: "assistant", content: [emptyThinking] }],
    thinking: { type: "adaptive" },
    output_config: { effort: "max" },
    tools: [
      {
        name: "echo",
        input_schema: {
          type: "object",
          properties: { input: { default: emptyThinking } },
        },
      },
    ],
  }
  const result = normalizeAnthropicMessagesRequest(source)
  expect(result.thinking).toEqual(source.thinking)
  expect(result.output_config).toEqual(source.output_config)
  expect(result.tools).toEqual(source.tools)
})

test("resumes partial assistant content exposed by removing a tail after system controls", () => {
  const result = normalize([
    user,
    { role: "assistant", content: [{ type: "text", text: "Partial answer." }] },
    { role: "system", content: "Current turn context." },
    { role: "assistant", content: [emptyThinking] },
  ])
  expect(result).toHaveProperty("messages.1.content.0.text", "Partial answer.")
  expect(result).toHaveProperty("messages.2", {
    role: "system",
    content: "Current turn context.",
  })
  expect(result).toHaveProperty("messages.3.role", "user")
  expect(result).toHaveProperty(
    "messages.3.content.0.text",
    "Continue the interrupted assistant response.",
  )
  expect(normalizeAnthropicMessagesRequest(result)).toEqual(result)
})

test("preserves a complete assistant turn split by system context", () => {
  const source = [
    user,
    { role: "assistant", content: [emptyThinking] },
    { role: "system", content: "Current turn context." },
    {
      role: "assistant",
      content: [{ type: "text", text: "Completed answer." }],
    },
  ]
  expect(normalize(source).messages).toEqual(source)
})

test("leaves valid historical reasoning and an unrelated text prefill untouched", () => {
  const source = [
    user,
    { role: "assistant", content: [signedThinking] },
    { role: "user", content: "Complete the JSON." },
    { role: "assistant", content: '{"answer":' },
  ]
  expect(normalize(source).messages).toEqual(source)
})
