import { expect, test } from "bun:test"

import {
  asAnthropicUnknownRole,
  type AnthropicMessagesPayload,
} from "~/routes/messages/anthropic-types"
import { detectAnthropicInitiator } from "~/services/copilot/create-anthropic-messages"
import {
  normalizeAnthropicMessagesRequest,
  prepareAnthropicMessagesRequest,
  serializeAnthropicMessagesRequest,
} from "~/services/copilot/messages-contract"

function createClaudeRequest(): AnthropicMessagesPayload {
  return {
    model: "claude-opus-5.5",
    max_tokens: 128000,
    messages: [
      { role: "user", content: "Review the supplied component." },
      {
        role: asAnthropicUnknownRole("system"),
        content: [{ type: "text", text: "Current turn instructions." }],
        output_config: { effort: "max" },
      },
    ],
    system: [{ type: "text", text: "You are an engineering assistant." }],
    thinking: { type: "adaptive" },
    output_config: { effort: "max" },
    context_management: {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    },
    stream: true,
  }
}

test("normalizes the captured Claude per-turn control before native dispatch", () => {
  const source = createClaudeRequest()
  const original = structuredClone(source)
  const prepared = prepareAnthropicMessagesRequest({ payload: source })

  expect(prepared.body.messages).toEqual([
    { role: "user", content: "Review the supplied component." },
    {
      role: asAnthropicUnknownRole("system"),
      content: [{ type: "text", text: "Current turn instructions." }],
    },
  ])
  expect(prepared.body.output_config).toEqual({ effort: "max" })
  expect(prepared.body.thinking).toEqual({ type: "adaptive" })
  expect(prepared.body.context_management).toEqual(original.context_management)
  expect(prepared.normalizationClasses).toContain("message_controls")
  expect(source).toEqual(original)
})

test("normalizes controls in already-adapted Messages serialization too", () => {
  const source = createClaudeRequest()
  const normalized = normalizeAnthropicMessagesRequest(source)
  const serialized = JSON.parse(
    serializeAnthropicMessagesRequest(source),
  ) as Record<string, unknown>

  expect(normalized).toEqual(serialized)
  expect(serialized).not.toHaveProperty("messages.1.output_config")
  expect(serialized).toHaveProperty("output_config.effort", "max")
  expect(source).toHaveProperty("messages.1.output_config.effort", "max")
})

test("uses current system controls only as defaults beneath request controls", () => {
  const source = createClaudeRequest()
  source.messages.push({
    role: asAnthropicUnknownRole("system"),
    content: [],
    output_config: {
      effort: "low",
      task_budget: { type: "tokens", total: 4096, remaining: 2048 },
      unsupported_per_turn_control: { enabled: true },
    },
  })
  source.output_config = {
    effort: "high",
    format: { type: "json_schema", schema: { type: "object" } },
    future_request_control: true,
  }
  const prepared = prepareAnthropicMessagesRequest({ payload: source })

  expect(prepared.body.output_config).toEqual({
    effort: "high",
    format: { type: "json_schema", schema: { type: "object" } },
    task_budget: { type: "tokens", total: 4096, remaining: 2048 },
    future_request_control: true,
  })
  expect(prepared.body.messages).toHaveLength(2)
})

test("retains the latest active per-turn effort when root controls are absent", () => {
  const source = createClaudeRequest()
  delete source.output_config
  source.messages.push({
    role: asAnthropicUnknownRole("system"),
    content: [{ type: "text", text: "Use the reduced effort for this turn." }],
    output_config: { effort: "low" },
  })

  expect(
    prepareAnthropicMessagesRequest({ payload: source }).body,
  ).toHaveProperty("output_config.effort", "low")
})

test("does not resurrect historical controls or promote user message metadata", () => {
  const source = createClaudeRequest()
  delete source.output_config
  source.messages.push(
    { role: "assistant", content: [{ type: "text", text: "Finished." }] },
    { role: "user", content: "Continue.", output_config: { effort: "high" } },
  )
  const prepared = prepareAnthropicMessagesRequest({ payload: source })

  expect(prepared.body).not.toHaveProperty("output_config")
  expect(prepared.body.messages).toHaveLength(4)
  expect(prepared.body.messages[3]).toEqual({
    role: "user",
    content: "Continue.",
  })
  expect(prepared.body.messages[1]).not.toHaveProperty("output_config")
})

test("does not remove output_config from opaque content or tool arguments", () => {
  const source = createClaudeRequest()
  source.messages.push({
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "call_1",
        name: "configure",
        input: { output_config: { effort: "keep" } },
      },
    ],
  })
  const prepared = prepareAnthropicMessagesRequest({ payload: source })

  expect(prepared.body).toHaveProperty(
    "messages.2.content.0.input.output_config.effort",
    "keep",
  )
})

test("removes only empty instruction carriers whose per-turn controls were consumed", () => {
  const source = createClaudeRequest()
  source.messages.push(
    {
      role: asAnthropicUnknownRole("system"),
      content: [],
      output_config: {
        effort: "low",
        timing: { type: "now", now: "2026-09-24T00:00:00Z" },
      },
    },
    { role: asAnthropicUnknownRole("system"), content: [] },
    { role: "user", content: [], output_config: { effort: "high" } },
  )
  const prepared = prepareAnthropicMessagesRequest({ payload: source })

  expect(prepared.body.messages).toHaveLength(4)
  expect(prepared.body.messages.slice(-2)).toEqual([
    { role: asAnthropicUnknownRole("system"), content: [] },
    { role: "user", content: [] },
  ])
  expect(prepared.body.output_config).toEqual({ effort: "max" })
})

test("detects a tool continuation before trailing Claude system controls", () => {
  const messages: AnthropicMessagesPayload["messages"] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "done" },
      ],
    },
    {
      role: asAnthropicUnknownRole("system"),
      content: "Current turn controls.",
    },
  ]
  expect(detectAnthropicInitiator(messages)).toBe("agent")
  expect(
    detectAnthropicInitiator([
      { role: "assistant", content: "Continue." },
      { role: asAnthropicUnknownRole("developer"), content: [] },
    ]),
  ).toBe("agent")
  expect(
    detectAnthropicInitiator([
      { role: "user", content: "New request." },
      { role: asAnthropicUnknownRole("system"), content: [] },
    ]),
  ).toBe("user")
})
