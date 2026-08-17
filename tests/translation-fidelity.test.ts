import { expect, test } from "bun:test"

import { createEndpointTranslationError } from "~/lib/error"
import {
  anthropicResponseToChat,
  chatPayloadToAnthropic,
} from "~/routes/chat-completions/anthropic-bridge"
import {
  checkChatToMessagesTranslation,
  checkChatToResponsesTranslation,
} from "~/routes/chat-completions/translation-fidelity"
import {
  checkResponsesToChatTranslation,
  checkResponsesToMessagesTranslation,
} from "~/routes/responses/translation-fidelity"

test("allows Chat to Responses with encrypted reasoning and structured tool output", () => {
  expect(
    checkChatToResponsesTranslation({
      model: "gpt-current",
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_text: "thinking",
          reasoning_opaque: "rs_1",
          encrypted_content: "encrypted",
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "text", text: "done" }],
        },
      ],
    }),
  ).toEqual({ supported: true, blockers: [] })
})

test("normalizes deprecated Chat tool controls before Responses checks", () => {
  const payload = {
    model: "gpt-current",
    messages: [
      { role: "user" as const, content: "hello" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "legacy_lookup",
            type: "function" as const,
            function: { name: "legacy_lookup", arguments: "{}" },
          },
        ],
      },
      { role: "tool" as const, tool_call_id: "legacy_lookup", content: "done" },
    ],
    functions: [{ name: "legacy_lookup", parameters: {} }],
    function_call: { name: "legacy_lookup" },
  }

  expect(checkChatToResponsesTranslation(payload)).toEqual({
    supported: true,
    blockers: [],
  })
  expect(payload).toHaveProperty("functions")
  expect(payload).toHaveProperty("function_call")
})

test("normalizes deprecated Chat controls before Messages checks", () => {
  const payload = {
    model: "claude-current",
    messages: [{ role: "user" as const, content: "hello" }],
    functions: [{ name: "legacy_lookup", parameters: {} }],
    function_call: { name: "legacy_lookup" },
  }

  expect(checkChatToMessagesTranslation(payload)).toEqual({
    supported: true,
    blockers: [],
  })
  expect(payload).toHaveProperty("functions")
  expect(payload).toHaveProperty("function_call")
})

test("rejects Chat to Responses unsupported content and malformed tool results in order", () => {
  expect(
    checkChatToResponsesTranslation({
      model: "gpt-current",
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: "private" } } as never,
            { type: "refusal", refusal: "no" } as never,
          ],
        },
        { role: "tool", content: "orphan" },
        { role: "tool", tool_call_id: "missing_call", content: "orphan" },
      ],
    }),
  ).toEqual({
    supported: false,
    blockers: ["message_content_part", "tool_result_pairing"],
  })
})

test("rejects Chat content parts that Responses cannot preserve for the message role", () => {
  expect(
    checkChatToResponsesTranslation({
      model: "gpt-current",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AA==" },
            },
          ],
        },
      ],
    }),
  ).toEqual({ supported: false, blockers: ["message_content_part"] })
})

test("rejects Chat to Messages when an OpenAI-only custom tool cannot map", () => {
  expect(
    checkChatToMessagesTranslation({
      model: "claude-current",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "custom", format: { type: "grammar" } } as never],
    }),
  ).toEqual({
    supported: false,
    blockers: ["custom_tool_grammar"],
  })
})

test("rejects Chat to Messages unsupported reasoning tools and prediction in order", () => {
  expect(
    checkChatToMessagesTranslation({
      model: "claude-current",
      messages: [
        {
          role: "assistant",
          content: null,
          encrypted_content: "private-encrypted-state",
        },
      ],
      tools: [
        { type: "file_search", vector_store_ids: ["private-store"] } as never,
      ],
      prediction: { type: "content", content: "private-prediction" },
    }),
  ).toEqual({
    supported: false,
    blockers: ["opaque_reasoning", "hosted_tool:file_search", "prediction"],
  })
})

test("allows Chat reasoning already encoded as an Anthropic signature", () => {
  expect(
    checkChatToMessagesTranslation({
      model: "claude-current",
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_text: "thinking",
          reasoning_opaque: "native-signature",
        },
      ],
    }),
  ).toEqual({ supported: true, blockers: [] })
})

test("rejects Responses to Chat when opaque reasoning would be lost", () => {
  expect(
    checkResponsesToChatTranslation({
      model: "chat-only",
      input: [
        {
          type: "reasoning",
          encrypted_content: "encrypted",
          summary: [],
        },
      ],
    }),
  ).toEqual({ supported: false, blockers: ["opaque_reasoning"] })
})

test("rejects Responses to Chat unsupported item tool phase and context semantics", () => {
  expect(
    checkResponsesToChatTranslation({
      model: "chat-only",
      input: [
        { type: "item_reference", id: "private-item" },
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "work" }],
        },
      ],
      tools: [
        { type: "namespace", name: "private_namespace" },
        { type: "custom", name: "private_custom" },
        { type: "programmatic_tool_calling", name: "private_program" },
      ],
      context_management: [{ type: "truncate", keep: 10 }],
    }),
  ).toEqual({
    supported: false,
    blockers: [
      "item_reference",
      "content_phase",
      "tool_semantics:namespace",
      "tool_semantics:custom",
      "tool_semantics:programmatic_tool_calling",
      "context_management",
    ],
  })
})

test("rejects Responses to Messages for item references and unsupported hosted tools", () => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [{ type: "item_reference", id: "item_1" }],
      tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }],
    }),
  ).toEqual({
    supported: false,
    blockers: ["item_reference", "hosted_tool:file_search"],
  })
})

test("rejects Responses to Messages opaque reasoning custom grammar and multi-agent config", () => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-encrypted-state",
          summary: [],
        },
      ],
      tools: [
        {
          type: "custom",
          name: "private_tool",
          format: { type: "grammar", syntax: "private-grammar" },
        },
      ],
      multi_agent: { agents: [{ name: "private-agent" }] },
    }),
  ).toEqual({
    supported: false,
    blockers: ["opaque_reasoning", "custom_tool_grammar", "multi_agent"],
  })
})

test("creates one fixed safe translation error using only the first blocker", async () => {
  const error = createEndpointTranslationError({
    blockers: ["opaque_reasoning", "hosted_tool:file_search"],
    code: "endpoint_translation_unsupported",
    source: "responses",
  })

  expect(error.response.status).toBe(400)
  expect(error.clientBody).toEqual({
    error: {
      code: "endpoint_translation_unsupported",
      message:
        "The selected Copilot model cannot accept this request without losing required protocol data.",
      param: "opaque_reasoning",
      type: "invalid_request_error",
    },
  })
  expect(await error.response.clone().json()).toEqual(error.clientBody)
  expect(JSON.stringify(error.clientBody)).not.toContain("file_search")
})

test("uses request_shape when a route failure has no blockers", () => {
  const error = createEndpointTranslationError({
    blockers: [],
    code: "endpoint_translation_unsupported",
    source: "chat",
  })

  expect(error.clientBody).toMatchObject({
    error: { param: "request_shape" },
  })
})

test("round-trips signed thinking through the Chat to Messages bridge", async () => {
  const payload = await chatPayloadToAnthropic({
    model: "claude-current",
    messages: [
      {
        role: "assistant",
        content: null,
        reasoning_text: "prior thought",
        reasoning_opaque: "native-signature",
      },
    ],
  })

  expect(payload.messages).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "prior thought",
          signature: "native-signature",
        },
      ],
    },
  ])

  const chat = anthropicResponseToChat(
    {
      id: "msg_reasoning",
      type: "message",
      role: "assistant",
      model: "claude-current",
      content: [
        {
          type: "thinking",
          thinking: "next thought",
          signature: "next-native-signature",
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    "claude-alias",
  )

  expect(chat.choices[0].message).toMatchObject({
    reasoning_text: "next thought",
    reasoning_opaque: "next-native-signature",
  })
})
