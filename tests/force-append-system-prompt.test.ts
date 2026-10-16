import { afterEach, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Message } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { LocalHTTPError } from "~/lib/error"
import {
  forceChatSystemPrompt,
  forceMessagesSystemPrompt,
  forceResponsesSystemPrompt,
} from "~/lib/forced-system-prompt"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { asAnthropicUnknownRole } from "~/routes/messages/anthropic-types"

const MODEL = "force-append-test"

function enableForceAppend(): void {
  setModelSettingsForTest([
    {
      model: MODEL,
      forcedSystemPrompt: "Be brief.",
      forceAppendSystemPrompt: true,
    },
  ])
}

afterEach(() => setModelSettingsForTest([]))

test.each([
  ["Original instructions.", "Be brief.\n\nOriginal instructions."],
  [null, "Be brief."],
  [[], [{ type: "text", text: "Be brief." }]],
  [
    [
      { type: "text", text: "Original instructions." },
      { type: "text", text: "More instructions." },
    ],
    [
      { type: "text", text: "Be brief.\n\nOriginal instructions." },
      { type: "text", text: "More instructions." },
    ],
  ],
] satisfies Array<[Message["content"], Message["content"]]>)(
  "Chat force append prefixes the existing message without duplication %#",
  (content, expected) => {
    enableForceAppend()
    const existing: Message = { role: "system", name: "client", content }
    const payload = {
      messages: [
        existing,
        { role: "system", content: "Another system prompt." },
        { role: "user", content: "Hello" },
      ] satisfies Array<Message>,
    }
    const original = structuredClone(payload)

    forceChatSystemPrompt(payload, MODEL)
    forceChatSystemPrompt(payload, MODEL)

    expect(payload.messages).toEqual([
      { role: "system", name: "client", content: expected },
      { role: "system", content: "Another system prompt." },
      { role: "user", content: "Hello" },
    ])
    expect(existing).toEqual(original.messages[0])
  },
)

test("Chat force append uses a developer message when no system message exists", () => {
  enableForceAppend()
  const payload = {
    messages: [
      { role: "developer", content: "Client developer." },
      { role: "user", content: "Hello" },
    ] satisfies Array<Message>,
  }

  forceChatSystemPrompt(payload, MODEL)

  expect(payload.messages).toEqual([
    { role: "developer", content: "Be brief.\n\nClient developer." },
    { role: "user", content: "Hello" },
  ])
})

test("Chat force append creates a system prompt when none exists", () => {
  enableForceAppend()
  const payload: { messages: Array<Message> } = {
    messages: [{ role: "user", content: "Hello" }],
  }

  forceChatSystemPrompt(payload, MODEL)
  forceChatSystemPrompt(payload, MODEL)

  expect(payload.messages).toEqual([
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hello" },
  ])
})

test.each([
  ["Original instructions.", "Be brief.\n\nOriginal instructions."],
  [undefined, "Be brief."],
  [
    [
      {
        type: "text",
        text: "Original instructions.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      { type: "text", text: "More instructions." },
    ],
    [
      {
        type: "text",
        text: "Be brief.\n\nOriginal instructions.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      { type: "text", text: "More instructions." },
    ],
  ],
] satisfies Array<
  [AnthropicMessagesPayload["system"], AnthropicMessagesPayload["system"]]
>)(
  "Messages force append preserves the existing system shape %#",
  (system, expected) => {
    enableForceAppend()
    const payload: AnthropicMessagesPayload = {
      model: MODEL,
      system,
      messages: [{ role: "user", content: "Hello" }],
    }
    const original = structuredClone(payload)

    forceMessagesSystemPrompt(payload, MODEL)
    forceMessagesSystemPrompt(payload, MODEL)

    expect(payload.system).toEqual(expected)
    expect(payload.messages).toEqual(original.messages)
    expect(original.system).toEqual(system)
  },
)

test.each(["system", "developer"] as const)(
  "Responses force append edits existing %s input when instructions are absent",
  (role) => {
    enableForceAppend()
    const item = {
      type: "message" as const,
      role,
      content: [{ type: "input_text", text: "Client instructions." }],
    }
    const payload: ResponsesPayload = {
      model: MODEL,
      input: [item, { role: "user", content: "Hello" }],
    }
    const original = structuredClone(item)

    forceResponsesSystemPrompt(payload, MODEL)
    forceResponsesSystemPrompt(payload, MODEL)

    expect(payload.instructions).toBeUndefined()
    expect(payload.input).toEqual([
      {
        type: "message",
        role,
        content: [
          { type: "input_text", text: "Be brief.\n\nClient instructions." },
        ],
      },
      { role: "user", content: "Hello" },
    ])
    expect(item).toEqual(original)
  },
)

test("Responses force append prefers existing instructions over input messages", () => {
  enableForceAppend()
  const payload: ResponsesPayload = {
    model: MODEL,
    instructions: "Client instructions.",
    input: [{ role: "system", content: "Additional system prompt." }],
  }

  forceResponsesSystemPrompt(payload, MODEL)
  forceResponsesSystemPrompt(payload, MODEL)

  expect(payload.instructions).toBe("Be brief.\n\nClient instructions.")
  expect(payload.input).toEqual([
    { role: "system", content: "Additional system prompt." },
  ])
})

test.each(["system", "developer"])(
  "Messages force append reuses a %s turn when top-level system is absent",
  (role) => {
    enableForceAppend()
    const payload: AnthropicMessagesPayload = {
      model: MODEL,
      messages: [
        { role: asAnthropicUnknownRole(role), content: "Client instructions." },
        { role: "user", content: "Hello" },
      ],
    }
    const original = structuredClone(payload.messages)

    forceMessagesSystemPrompt(payload, MODEL)
    forceMessagesSystemPrompt(payload, MODEL)

    expect(payload.system).toBeUndefined()
    expect(payload.messages).toEqual([
      {
        role: asAnthropicUnknownRole(role),
        content: "Be brief.\n\nClient instructions.",
      },
      { role: "user", content: "Hello" },
    ])
    expect(original[0].content).toBe("Client instructions.")
  },
)

test.each([
  { content: 42 },
  { content: {} },
  { content: [42, { type: "input_text", text: "Client instructions." }] },
  { content: [null] },
])(
  "Responses force append rejects malformed instruction content as a client error %#",
  ({ content }) => {
    enableForceAppend()
    const payload: ResponsesPayload = {
      model: MODEL,
      input: [
        { role: "system", content },
        { role: "user", content: "Hello" },
      ],
    }

    let caught: unknown
    try {
      forceResponsesSystemPrompt(payload, MODEL)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LocalHTTPError)
    if (!(caught instanceof LocalHTTPError))
      throw new Error("Expected a client error")
    expect(caught.response.status).toBe(400)
    expect(caught.clientBody).toMatchObject({
      error: { type: "invalid_request_error" },
    })
  },
)
