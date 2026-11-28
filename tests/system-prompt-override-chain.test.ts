import { afterEach, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Message } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { LocalHTTPError } from "~/lib/error"
import {
  forceChatSystemPrompt,
  forceCompactionSystemPrompt,
  forceMessagesSystemPrompt,
  forceResponsesSystemPrompt,
} from "~/lib/forced-system-prompt"
import { setModelSettingsForTest } from "~/lib/model-settings"

const MODEL = "system-override-chain"

function configure(rules: Array<unknown>): void {
  setModelSettingsForTest([{ model: MODEL, systemPromptOverrides: rules }])
}

afterEach(() => setModelSettingsForTest([]))

test("Chat applies clear, prefix, and replacement rules in saved order", () => {
  configure([
    { mode: "clear", prompt: "Base OLD" },
    { mode: "append", prompt: "First OLD" },
    { mode: "replace", find: "OLD", replacement: "NEW" },
    { mode: "append", prompt: "Last" },
  ])
  const payload: { messages: Array<Message> } = {
    messages: [
      { role: "system", content: "Client system" },
      { role: "developer", content: "Client developer" },
      { role: "user", content: "User OLD" },
    ],
  }
  const original = structuredClone(payload)

  forceChatSystemPrompt(payload, MODEL)

  expect(payload.messages).toEqual([
    { role: "system", content: "Last\n\nFirst NEW\n\nBase NEW" },
    { role: "user", content: "User OLD" },
  ])
  expect(original.messages[0].content).toBe("Client system")
})

test("replacements are literal, replace every match, and preserve other content", () => {
  configure([
    { mode: "replace", find: ".*", replacement: "$&" },
    { mode: "replace", find: "delete", replacement: "" },
  ])
  const payload: { messages: Array<Message> } = {
    messages: [
      { role: "system", content: ".* delete .* DELETE" },
      { role: "developer", content: [{ type: "text", text: ".*\n\n.*" }] },
      { role: "user", content: ".* delete" },
      { role: "assistant", content: ".* delete" },
    ],
  }

  forceChatSystemPrompt(payload, MODEL)

  expect(payload.messages).toEqual([
    { role: "system", content: "$&  $& DELETE" },
    { role: "developer", content: [{ type: "text", text: "$&\n\n$&" }] },
    { role: "user", content: ".* delete" },
    { role: "assistant", content: ".* delete" },
  ])
})

test("a later clear removes the results of earlier rules and can clear without replacement", () => {
  configure([
    { mode: "append", prompt: "Discard this" },
    { mode: "clear", prompt: "" },
    { mode: "replace", find: "Hello", replacement: "Unchanged" },
  ])
  const payload: { messages: Array<Message> } = {
    messages: [{ role: "user", content: "Hello" }],
  }

  forceChatSystemPrompt(payload, MODEL)

  expect(payload.messages).toEqual([{ role: "user", content: "Hello" }])
})

test("repeated append rules execute separately and preserve whitespace", () => {
  configure([
    { mode: "append", prompt: " Prefix " },
    { mode: "append", prompt: " Prefix " },
  ])
  const payload: ResponsesPayload = {
    model: MODEL,
    instructions: "Original",
    input: "Hello",
  }

  forceResponsesSystemPrompt(payload, MODEL)

  expect(payload.instructions).toBe(" Prefix \n\n Prefix \n\nOriginal")
})

test("Chat force append at the end adds to the same existing prompt", () => {
  configure([
    { mode: "append", prompt: "Top", position: "start" },
    { mode: "append", prompt: "Bottom", position: "end" },
  ])
  const payload: { messages: Array<Message> } = {
    messages: [
      { role: "developer", content: "Developer" },
      { role: "system", content: "Client system" },
      { role: "system", content: "Later system" },
      { role: "user", content: "Hello" },
    ],
  }

  forceChatSystemPrompt(payload, MODEL)

  expect(payload.messages).toEqual([
    { role: "developer", content: "Developer" },
    { role: "system", content: "Top\n\nClient system\n\nBottom" },
    { role: "system", content: "Later system" },
    { role: "user", content: "Hello" },
  ])
})

test("Chat force append at the end creates a system prompt when none exists", () => {
  configure([{ mode: "append", prompt: "Bottom", position: "end" }])
  const payload: { messages: Array<Message> } = {
    messages: [{ role: "user", content: "Hello" }],
  }

  forceChatSystemPrompt(payload, MODEL)

  expect(payload.messages).toEqual([
    { role: "system", content: "Bottom" },
    { role: "user", content: "Hello" },
  ])
})

test("Messages force append at the end extends the last system text block and keeps its metadata", () => {
  configure([{ mode: "append", prompt: "Bottom", position: "end" }])
  const payload: AnthropicMessagesPayload = {
    model: MODEL,
    system: [
      { type: "text", text: "Header" },
      {
        type: "text",
        text: "Main",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{ role: "user", content: "Hello" }],
  }

  const behavior = forceMessagesSystemPrompt(payload, MODEL)

  expect(payload.system).toEqual([
    { type: "text", text: "Header" },
    {
      type: "text",
      text: "Main\n\nBottom",
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ])
  expect(behavior?.data?.modes).toBe("append (end)")
})

test("Messages force append at the end adds a text block after a trailing non-text block", () => {
  configure([{ mode: "append", prompt: "Bottom", position: "end" }])
  const payload: AnthropicMessagesPayload = {
    model: MODEL,
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "Custom" },
          { type: "image", source: { type: "url", url: "https://x/a.png" } },
        ],
      },
      { role: "user", content: "Hello" },
    ],
  } as unknown as AnthropicMessagesPayload

  forceMessagesSystemPrompt(payload, MODEL)

  expect(payload.system).toBeUndefined()
  const [systemTurn] = payload.messages as Array<unknown>
  expect(systemTurn).toEqual({
    role: "system",
    content: [
      { type: "text", text: "Custom" },
      { type: "image", source: { type: "url", url: "https://x/a.png" } },
      { type: "text", text: "Bottom" },
    ],
  })
})

test("Responses force append at the end uses instructions, or the instruction input when they are absent", () => {
  configure([{ mode: "append", prompt: "Bottom", position: "end" }])
  const withInstructions: ResponsesPayload = {
    model: MODEL,
    instructions: "Original",
    input: "Hello",
  }
  const withInput: ResponsesPayload = {
    model: MODEL,
    input: [
      {
        role: "developer",
        content: [
          { type: "input_text", text: "One" },
          { type: "input_text", text: "Two" },
        ],
      },
      { role: "user", content: "Hello" },
    ],
  }

  forceResponsesSystemPrompt(withInstructions, MODEL)
  forceResponsesSystemPrompt(withInput, MODEL)

  expect(withInstructions.instructions).toBe("Original\n\nBottom")
  expect(withInput.instructions).toBeUndefined()
  expect(withInput.input).toEqual([
    {
      role: "developer",
      content: [
        { type: "input_text", text: "One" },
        { type: "input_text", text: "Two\n\nBottom" },
      ],
    },
    { role: "user", content: "Hello" },
  ])
})

test("compaction places an end append after the configured prompt and before summary instructions", () => {
  configure([
    { mode: "clear", prompt: "Base" },
    { mode: "append", prompt: "Bottom", position: "end" },
    { mode: "append", prompt: "Top" },
  ])

  const result = forceCompactionSystemPrompt({
    requestedModel: MODEL,
    instructions: "Summarize.",
    input: [{ role: "user", content: "Keep" }],
  })

  expect(result.instructions).toBe("Top\n\nBase\n\nBottom\n\nSummarize.")
})

test("Responses force append merges into edge output_text blocks with a separator", () => {
  configure([
    { mode: "append", prompt: "Top" },
    { mode: "append", prompt: "Bottom", position: "end" },
  ])
  const payload: ResponsesPayload = {
    model: MODEL,
    input: [
      {
        role: "system",
        content: [
          { type: "output_text", text: "First", annotations: [] },
          { type: "output_text", text: "Last", annotations: [] },
        ],
      },
      { role: "user", content: "Hello" },
    ],
  } as unknown as ResponsesPayload

  forceResponsesSystemPrompt(payload, MODEL)

  const [systemItem] = payload.input as Array<unknown>
  expect(systemItem).toEqual({
    role: "system",
    content: [
      { type: "output_text", text: "Top\n\nFirst", annotations: [] },
      { type: "output_text", text: "Last\n\nBottom", annotations: [] },
    ],
  })
})

test.each(["start", "end"] as const)(
  "Responses force append at %s refills an emptied edge block, separating only end text",
  (position) => {
    configure([
      { mode: "replace", find: "Remove me", replacement: "" },
      { mode: "append", prompt: "Added", position },
    ])
    const edge = { type: "input_text", text: "Remove me" }
    const kept = { type: "input_text", text: "Client system" }
    const payload: ResponsesPayload = {
      model: MODEL,
      input: [
        {
          role: "system",
          content: position === "end" ? [kept, edge] : [edge, kept],
        },
        { role: "user", content: "Hello" },
      ],
    }

    forceResponsesSystemPrompt(payload, MODEL)

    const [systemItem] = payload.input as Array<{ content: unknown }>
    const added = {
      type: "input_text",
      text: position === "end" ? "\n\nAdded" : "Added",
    }
    expect(systemItem.content).toEqual(
      position === "end" ? [kept, added] : [added, kept],
    )
  },
)

test("Chat and Messages force append at the end keep a separator when refilling an emptied last block", () => {
  configure([
    { mode: "replace", find: "Remove me", replacement: "" },
    { mode: "append", prompt: "Added", position: "end" },
  ])
  const chat: { messages: Array<Message> } = {
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "Client system" },
          { type: "text", text: "Remove me" },
        ],
      },
      { role: "user", content: "Hello" },
    ],
  }
  const messages: AnthropicMessagesPayload = {
    model: MODEL,
    system: [
      { type: "text", text: "Client system" },
      { type: "text", text: "Remove me", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "Hello" }],
  }

  forceChatSystemPrompt(chat, MODEL)
  forceMessagesSystemPrompt(messages, MODEL)

  expect(chat.messages[0].content).toEqual([
    { type: "text", text: "Client system" },
    { type: "text", text: "\n\nAdded" },
  ])
  expect(messages.system).toEqual([
    { type: "text", text: "Client system" },
    {
      type: "text",
      text: "\n\nAdded",
      cache_control: { type: "ephemeral" },
    },
  ])
})

test("Messages replaces all system blocks and custom instruction turns with metadata intact", () => {
  configure([
    { mode: "replace", find: "OLD", replacement: "NEW" },
    { mode: "append", prompt: "Top" },
  ])
  const payload: AnthropicMessagesPayload = {
    model: MODEL,
    system: [
      {
        type: "text",
        text: "OLD",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      { type: "text", text: "OLD OLD" },
    ],
    messages: [{ role: "user", content: "OLD" }],
  }
  const original = structuredClone(payload)

  forceMessagesSystemPrompt(payload, MODEL)

  expect(payload.system).toEqual([
    {
      type: "text",
      text: "Top\n\nNEW",
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    { type: "text", text: "NEW NEW" },
  ])
  expect(payload.messages).toEqual(original.messages)
  expect(original.system).toEqual([
    {
      type: "text",
      text: "OLD",
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    { type: "text", text: "OLD OLD" },
  ])
})

test("Responses replaces both instructions and system/developer inputs", () => {
  configure([{ mode: "replace", find: "OLD", replacement: "NEW" }])
  const payload: ResponsesPayload = {
    model: MODEL,
    instructions: "OLD",
    input: [
      { role: "system", content: "OLD OLD" },
      { role: "developer", content: [{ type: "input_text", text: "OLD" }] },
      { role: "user", content: "OLD" },
      { type: "function_call_output", call_id: "call", output: "OLD" },
    ],
  }

  forceResponsesSystemPrompt(payload, MODEL)

  expect(payload.instructions).toBe("NEW")
  expect(payload.input).toEqual([
    { role: "system", content: "NEW NEW" },
    { role: "developer", content: [{ type: "input_text", text: "NEW" }] },
    { role: "user", content: "OLD" },
    { type: "function_call_output", call_id: "call", output: "OLD" },
  ])
})

test("Responses clear empties instructions and input instructions before append", () => {
  configure([
    { mode: "clear", prompt: "" },
    { mode: "append", prompt: "Fresh" },
  ])
  const payload: ResponsesPayload = {
    model: MODEL,
    instructions: "Discard",
    input: [
      { role: "developer", content: "Discard" },
      { role: "user", content: "Keep" },
    ],
  }

  forceResponsesSystemPrompt(payload, MODEL)

  expect(payload.instructions).toBe("Fresh")
  expect(payload.input).toEqual([{ role: "user", content: "Keep" }])
})

test("find and replace does nothing when no system text matches", () => {
  configure([{ mode: "replace", find: "absent", replacement: "New" }])
  const payload: AnthropicMessagesPayload = {
    model: MODEL,
    messages: [{ role: "user", content: "absent" }],
  }
  const original = structuredClone(payload)

  forceMessagesSystemPrompt(payload, MODEL)

  expect(payload).toEqual(original)
})

test("compaction chains affect configured prompts and client history while retaining summary instructions", () => {
  configure([
    { mode: "clear", prompt: "OLD" },
    { mode: "replace", find: "OLD", replacement: "NEW" },
    { mode: "append", prompt: "Top" },
  ])

  const result = forceCompactionSystemPrompt({
    requestedModel: MODEL,
    instructions: "Summarize OLD history safely.",
    input: [
      { role: "system", content: "Discard OLD" },
      { role: "user", content: "Keep OLD" },
    ],
  })

  expect(result.instructions).toBe(
    "Top\n\nNEW\n\nSummarize OLD history safely.",
  )
  expect(result.input).toEqual([{ role: "user", content: "Keep OLD" }])
})

test("replacement growth is rejected before allocating an oversized system prompt", () => {
  configure([{ mode: "replace", find: "a", replacement: "x".repeat(100_000) }])
  const payload: ResponsesPayload = {
    model: MODEL,
    instructions: "a".repeat(10_000),
    input: "Hello",
  }

  expect(() => forceResponsesSystemPrompt(payload, MODEL)).toThrow(
    LocalHTTPError,
  )
})

test.each([false, true])(
  "a deleted Claude block retains cache metadata only when refilled by a later rule (%s)",
  (append) => {
    const rules: Array<unknown> = [
      { mode: "replace", find: "OLD", replacement: "" },
    ]
    if (append) rules.push({ mode: "append", prompt: "New" })
    configure(rules)
    const payload: AnthropicMessagesPayload = {
      model: MODEL,
      system: [
        { type: "text", text: "OLD", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Keep" },
      ],
      messages: [{ role: "user", content: "Hello" }],
    }

    forceMessagesSystemPrompt(payload, MODEL)

    expect(payload.system).toEqual(
      append ?
        [
          { type: "text", text: "New", cache_control: { type: "ephemeral" } },
          { type: "text", text: "Keep" },
        ]
      : [{ type: "text", text: "Keep" }],
    )
  },
)

test("a clear rule's new prompt counts toward the chain's growth limit", () => {
  configure([
    { mode: "clear", prompt: "a".repeat(100_000) },
    { mode: "replace", find: "a", replacement: "x".repeat(21) },
  ])
  const payload: ResponsesPayload = { model: MODEL, input: "Hello" }

  expect(() => forceResponsesSystemPrompt(payload, MODEL)).toThrow(
    LocalHTTPError,
  )
})
