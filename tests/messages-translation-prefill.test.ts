import { afterEach, expect, test } from "bun:test"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { setModelSettingsForTest } from "~/lib/model-settings"
import { prepareChatCandidates } from "~/routes/chat-completions/chat-candidates"
import { prepareChatCompletionsRequest } from "~/routes/chat-completions/chat-contract"
import { prepareResponsesCandidates } from "~/routes/responses/fallback-candidates"
import { responsesPayloadToAnthropic } from "~/routes/responses/messages-bridge"
import { rewriteUnsupportedAnthropicPrefill } from "~/services/copilot/anthropic-prefill"
import { rewriteUnsupportedAssistantPrefill } from "~/services/copilot/create-chat-completions"

import { useProtocolDatabase } from "./helpers/protocol-database"

useProtocolDatabase()

afterEach(() => {
  setModelSettingsForTest([])
})

const MODEL = "claude-opus-5.5"

const model = {
  id: MODEL,
  name: "Claude Opus 5.5",
  object: "model",
  preview: false,
  vendor: "anthropic",
  version: "1",
  model_picker_enabled: true,
  supported_endpoints: ["/chat/completions", "/v1/messages"],
  capabilities: {
    family: "claude",
    limits: { max_output_tokens: 4096 },
    object: "model_capabilities",
    supports: {},
    tokenizer: "cl100k_base",
    type: "chat",
  },
} satisfies Model

const responsesSource = {
  model: MODEL,
  input: [
    { type: "message", role: "user", content: "Reply with JSON." },
    { type: "message", role: "assistant", content: "{" },
  ],
}

function finalTurn(message: AnthropicMessage | Message | undefined) {
  const content = message?.content
  const text =
    typeof content === "string" ? content : (
      content?.map((block) => (block as { text?: string }).text).join("")
    )
  return { role: message?.role, text }
}

/** The final turn of every Copilot payload the gateway translates. */
async function translatedFinalTurns() {
  const responses = await prepareResponsesCandidates({
    adaptationSource: structuredClone(responsesSource),
    nativeBody: {
      body: structuredClone(responsesSource) as Parameters<
        typeof prepareResponsesCandidates
      >[0]["nativeBody"]["body"],
      normalizationClasses: [],
    },
    preservedSource: {
      source: structuredClone(responsesSource),
      normalizationClasses: [],
    },
    selectedModel: model,
  })
  const bridged = await responsesPayloadToAnthropic(
    structuredClone(responsesSource) as Parameters<
      typeof responsesPayloadToAnthropic
    >[0],
  )
  const chat = await prepareChatCandidates({
    source: prepareChatCompletionsRequest({
      model: MODEL,
      messages: [
        { role: "user", content: "Reply with JSON." },
        { role: "assistant", content: "{" },
      ],
    }).source,
    selectedModel: model,
    nativeMessagesOptions: {},
  })
  return {
    responsesToChat: finalTurn(responses.chat?.payload.messages.at(-1)),
    responsesToMessages: finalTurn(responses.messages?.payload.messages.at(-1)),
    responsesBridge: finalTurn(bridged.messages.at(-1)),
    chatToMessages: finalTurn(chat.messages.payload.messages.at(-1)),
  }
}

test("sends a final assistant message as user text when prefill is unsupported", async () => {
  const userTurn = { role: "user", text: "{" } as const

  expect(await translatedFinalTurns()).toEqual({
    responsesToChat: userTurn,
    responsesToMessages: userTurn,
    responsesBridge: userTurn,
    chatToMessages: userTurn,
  })
})

test("keeps the final assistant message when model settings allow prefill", async () => {
  setModelSettingsForTest([{ model: MODEL, supportsAssistantPrefill: true }])
  const assistantTurn = { role: "assistant", text: "{" } as const

  expect(await translatedFinalTurns()).toEqual({
    responsesToChat: assistantTurn,
    responsesToMessages: assistantTurn,
    responsesBridge: assistantTurn,
    chatToMessages: assistantTurn,
  })
})

function rewriteChat(last: Message): Message | undefined {
  const payload: ChatCompletionsPayload = {
    model: MODEL,
    messages: [{ role: "user", content: "Go." }, structuredClone(last)],
  }
  rewriteUnsupportedAssistantPrefill(payload)
  return payload.messages.at(-1)
}

function rewriteMessages(last: AnthropicMessage): AnthropicMessage | undefined {
  const payload: AnthropicMessagesPayload = {
    model: MODEL,
    max_tokens: 32,
    messages: [{ role: "user", content: "Go." }, structuredClone(last)],
  }
  rewriteUnsupportedAnthropicPrefill(payload)
  return payload.messages.at(-1)
}

test("leaves final tool-call and reasoning-only turns unchanged", () => {
  const chatTurns: Array<Message> = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
      ],
    },
    { role: "assistant", content: null, reasoning_opaque: "opaque-state" },
  ]
  const messagesTurns: Array<AnthropicMessage> = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }],
    },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "", signature: "sig" }],
    },
  ]

  for (const turn of chatTurns) expect(rewriteChat(turn)).toEqual(turn)
  for (const turn of messagesTurns) expect(rewriteMessages(turn)).toEqual(turn)
})

test("sends a final text turn as user text without its reasoning", () => {
  expect(
    rewriteChat({
      role: "assistant",
      content: "Done.",
      reasoning_text: "thought",
      reasoning_opaque: "opaque-state",
    }),
  ).toEqual({ role: "user", content: "Done." })
  expect(
    rewriteMessages({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "thought", signature: "sig" },
        { type: "text", text: "Done." },
      ],
    }),
  ).toEqual({ role: "user", content: [{ type: "text", text: "Done." }] })
})
