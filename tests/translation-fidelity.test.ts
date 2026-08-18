/* eslint-disable max-lines */
import { expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { createEndpointTranslationError, LocalHTTPError } from "~/lib/error"
import {
  anthropicResponseToChat,
  chatPayloadToAnthropic,
} from "~/routes/chat-completions/anthropic-bridge"
import { chatCompletionsToResponses } from "~/routes/chat-completions/responses-fallback"
import {
  checkChatNativeRequirements,
  checkChatToMessagesTranslation,
  checkChatToResponsesTranslation,
} from "~/routes/chat-completions/translation-fidelity"
import { responsesToChatCompletions } from "~/routes/responses/handler"
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

test("uses normalized deprecated controls in the direct Chat to Responses converter", () => {
  const payload = {
    model: "gpt-current",
    messages: [{ role: "user" as const, content: "hello" }],
    functions: [{ name: "legacy_lookup", parameters: {} }],
    function_call: { name: "legacy_lookup" },
  }

  const translated = chatCompletionsToResponses(payload)

  expect(translated.tools).toEqual([
    {
      type: "function",
      name: "legacy_lookup",
      description: null,
      parameters: { type: "object", properties: {} },
      strict: false,
    },
  ])
  expect(translated.tool_choice).toEqual({
    type: "function",
    name: "legacy_lookup",
  })
  expect(payload).toHaveProperty("functions")
  expect(payload).toHaveProperty("function_call")
})

test("uses normalized deprecated controls in the direct Chat to Messages converter", async () => {
  const payload = {
    model: "claude-current",
    messages: [{ role: "user" as const, content: "hello" }],
    functions: [{ name: "legacy_lookup", parameters: {} }],
    function_call: { name: "legacy_lookup" },
  }

  const translated = await chatPayloadToAnthropic(payload)

  expect(translated.tools).toEqual([
    {
      name: "legacy_lookup",
      input_schema: { type: "object", properties: {} },
    },
  ])
  expect(translated.tool_choice).toEqual({
    type: "tool",
    name: "legacy_lookup",
  })
  expect(payload).toHaveProperty("functions")
  expect(payload).toHaveProperty("function_call")
})

test.each([
  {
    name: "scalar content",
    payload: {
      model: "gpt-current",
      messages: [{ role: "user", content: { text: "hello" } }],
    },
  },
  {
    name: "non-array tools",
    payload: {
      model: "gpt-current",
      messages: [{ role: "user", content: "hello" }],
      tools: { type: "function" },
    },
  },
  {
    name: "forced choice without tools",
    payload: {
      model: "gpt-current",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      tool_choice: "required",
    },
  },
  {
    name: "missing named function",
    payload: {
      model: "gpt-current",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "missing" } },
    },
  },
])("rejects $name before either Chat translator", ({ payload }) => {
  const malformed = payload as unknown as ChatCompletionsPayload & {
    model: string
  }

  expect(() => chatCompletionsToResponses(malformed)).toThrow(LocalHTTPError)
  expect(() => chatPayloadToAnthropic(malformed)).toThrow(LocalHTTPError)
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

test("rejects every unmapped Chat to Responses request concept in first-seen order", () => {
  expect(
    checkChatToResponsesTranslation({
      model: "gpt-current",
      messages: [
        {
          role: "assistant",
          content: "answer",
          name: "private-name",
          reasoning_text: "unsealed reasoning",
          reasoning_opaque: "unsealed-state",
        },
      ],
      stop: ["stop-private"],
      n: 2,
      stream_options: { include_usage: false },
      frequency_penalty: 0.5,
      presence_penalty: 0.5,
      logit_bias: { 1: 1 },
      logprobs: true,
      top_logprobs: 3,
      prediction: { type: "content", content: "private-prediction" },
      thinking_budget: 2048,
      seed: 7,
      response_format: { type: "future_format" },
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: { type: "future_choice" },
    }),
  ).toEqual({
    supported: false,
    blockers: [
      "message_name",
      "reasoning_state",
      "stop",
      "n",
      "stream_options",
      "frequency_penalty",
      "presence_penalty",
      "logit_bias",
      "logprobs",
      "top_logprobs",
      "prediction",
      "seed",
      "thinking_budget",
      "response_format",
      "tool_choice",
    ],
  })
})

test("maps exact Chat controls into the direct Responses payload", () => {
  const translated = chatCompletionsToResponses({
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    max_completion_tokens: 321,
    reasoning_effort: "high",
    user: "user-safe",
    snippy: { enabled: false },
  })

  expect(translated.max_output_tokens).toBe(321)
  expect(translated.reasoning).toMatchObject({ effort: "high" })
  expect(translated.user).toBe("user-safe")
  expect(translated.snippy).toEqual({ enabled: false })
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

test("rejects Chat file_id sources before the Messages converter can replace them", async () => {
  const payload = {
    model: "claude-current",
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Read this file." },
          {
            type: "file" as const,
            file: { filename: "review.pdf", file_id: "file_review_1" },
          },
        ],
      },
    ],
  }

  expect(checkChatToMessagesTranslation(payload)).toEqual({
    supported: false,
    blockers: ["file_source:file_id"],
  })
  let thrown: unknown
  try {
    await chatPayloadToAnthropic(payload)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(LocalHTTPError)
})

test("preserves base64 PDF documents from user and tool content on Messages", async () => {
  const document = {
    type: "document" as const,
    source: {
      type: "base64" as const,
      media_type: "application/pdf",
      data: "AA==",
    },
    title: "review.pdf",
  }
  const payload = {
    model: "claude-current",
    messages: [
      { role: "user" as const, content: [document] },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call_review",
            type: "function" as const,
            function: { name: "review", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "call_review",
        content: [document],
      },
    ],
  } as unknown as Parameters<typeof checkChatToMessagesTranslation>[0]

  expect(checkChatToMessagesTranslation(payload)).toEqual({
    supported: true,
    blockers: [],
  })
  const translated = await chatPayloadToAnthropic(payload)
  expect(translated.messages[0]).toEqual({ role: "user", content: [document] })
  expect(translated.messages[2]).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "call_review",
        content: [document],
      },
    ],
  })
})

test.each([
  { name: "null", file_id: null, supported: true },
  { name: "blank", file_id: "   ", supported: true },
  { name: "nonempty", file_id: "file_review_1", supported: false },
])(
  "treats $name file_id alongside PDF data correctly",
  ({ file_id, supported }) => {
    const check = checkChatToMessagesTranslation({
      model: "claude-current",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                filename: "review.pdf",
                file_data: "data:application/pdf;base64,AA==",
                file_id,
              },
            },
          ],
        },
      ],
    } as never)

    expect(check).toEqual(
      supported ?
        { supported: true, blockers: [] }
      : { supported: false, blockers: ["file_source:file_id"] },
    )
  },
)

test.each([
  { name: "missing file data", file: { filename: "missing.pdf" } },
  {
    name: "malformed file data",
    file: { filename: "malformed.pdf", file_data: "not-a-data-uri" },
  },
  {
    name: "non-PDF file data",
    file: {
      filename: "image.png",
      file_data: "data:image/png;base64,AA==",
    },
  },
])("rejects $name on the Messages bridge", ({ file }) => {
  expect(
    checkChatToMessagesTranslation({
      model: "claude-current",
      messages: [
        {
          role: "user",
          content: [{ type: "file", file }],
        },
      ],
    }),
  ).toEqual({
    supported: false,
    blockers: ["file_source:file_data"],
  })
})

test.each([
  { name: "missing file object", part: { type: "file" } },
  { name: "primitive file object", part: { type: "file", file: "private" } },
])("rejects $name on the Messages bridge", ({ part }) => {
  expect(
    checkChatToMessagesTranslation({
      model: "claude-current",
      messages: [{ role: "user", content: [part] }],
    } as never),
  ).toEqual({
    supported: false,
    blockers: ["file_source:file_data"],
  })
})

test("allows only payload concepts the native Chat endpoint preserves", () => {
  expect(
    checkChatNativeRequirements({
      model: "chat-current",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    }),
  ).toEqual({ supported: true, blockers: [] })

  expect(
    checkChatNativeRequirements({
      model: "chat-current",
      messages: [
        {
          role: "assistant",
          content: "answer",
          reasoning_text: null,
          reasoning_opaque: null,
          encrypted_content: null,
        },
      ],
    }),
  ).toEqual({ supported: true, blockers: [] })

  expect(
    checkChatNativeRequirements({
      model: "chat-current",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: { filename: "review.pdf", file_id: "file_review_1" },
            },
          ],
        },
      ],
      tools: [
        { type: "custom", format: { type: "grammar", syntax: "lark" } },
        { type: "web_search" },
      ] as never,
    }),
  ).toEqual({
    supported: false,
    blockers: [
      "message_content_part:file",
      "native_tool:custom",
      "native_tool:web_search",
    ],
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
    blockers: ["unsigned_reasoning", "hosted_tool:file_search", "prediction"],
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

test("rejects every unsigned or incomplete Chat reasoning combination for Messages", () => {
  const cases = [
    { reasoning_text: "thinking" },
    { reasoning_opaque: "native-signature" },
    { reasoning_text: "thinking", reasoning_opaque: "" },
    { reasoning_text: "", reasoning_opaque: "native-signature" },
    { reasoning_text: "   ", reasoning_opaque: "native-signature" },
    { reasoning_text: "thinking", reasoning_opaque: "   " },
    {
      reasoning_text: "thinking",
      reasoning_opaque: "responses-state@item-id",
    },
    {
      reasoning_text: "thinking",
      reasoning_opaque: "native-signature",
      encrypted_content: "openai-encrypted-state",
    },
  ]

  for (const reasoning of cases) {
    expect(
      checkChatToMessagesTranslation({
        model: "claude-current",
        messages: [{ role: "assistant", content: null, ...reasoning }],
      }),
    ).toEqual({ supported: false, blockers: ["unsigned_reasoning"] })
  }
})

test("rejects role-incompatible Chat content on the Messages bridge", () => {
  expect(
    checkChatToMessagesTranslation({
      model: "claude-current",
      messages: [
        {
          role: "system",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AA==" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "file",
              file: {
                filename: "private.pdf",
                file_data: "data:application/pdf;base64,AA==",
              },
            },
          ],
        },
      ],
    }),
  ).toEqual({ supported: false, blockers: ["message_content_part"] })
})

test("rejects exact hosted tool variants and unmapped Chat to Messages controls", () => {
  expect(
    checkChatToMessagesTranslation({
      model: "claude-current",
      messages: [{ role: "user", content: "hello", name: "private-name" }],
      tools: [{ type: "web_search_20250305", name: "private-search" } as never],
      n: 2,
      stream_options: { include_usage: false },
      frequency_penalty: 0.5,
      presence_penalty: 0.5,
      logit_bias: { 1: 1 },
      logprobs: true,
      top_logprobs: 3,
      prediction: { type: "content", content: "private-prediction" },
      seed: 7,
      snippy: { enabled: true },
    }),
  ).toEqual({
    supported: false,
    blockers: [
      "message_name",
      "hosted_tool:web_search",
      "n",
      "stream_options",
      "frequency_penalty",
      "presence_penalty",
      "logit_bias",
      "logprobs",
      "top_logprobs",
      "prediction",
      "seed",
      "snippy",
    ],
  })
})

test("maps exact Chat controls into the direct Messages payload", async () => {
  const translated = await chatPayloadToAnthropic({
    model: "claude-current",
    messages: [{ role: "user", content: "hello" }],
    max_completion_tokens: 321,
    parallel_tool_calls: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "result",
        schema: { type: "object" },
      },
    },
    thinking_budget: 2048,
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  })

  expect(translated.max_tokens).toBe(321)
  expect(translated.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
  expect(translated.output_config?.format).toEqual({
    type: "json_schema",
    name: "result",
    schema: { type: "object" },
  })
  expect(translated.tool_choice).toEqual({
    type: "auto",
    disable_parallel_tool_use: true,
  })
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

test("rejects ordinary computer output and every unmapped Responses to Chat control", () => {
  expect(
    checkResponsesToChatTranslation({
      model: "chat-only",
      input: [
        {
          type: "computer_call_output",
          call_id: "private-call",
          output: "private-output",
        },
      ],
      prompt: { id: "private-prompt" },
      conversation_id: "private-conversation",
      metadata: { private: "value" },
      user: "user-safe",
      safety_identifier: "private-safety",
      prompt_cache_key: "private-cache-key",
      prompt_cache_options: { mode: "explicit" },
      prompt_cache_retention: "in_memory",
      reasoning: { effort: "high", summary: "detailed" },
      include: ["reasoning.encrypted_content"],
      context_management: [{ type: "truncate" }],
      truncation: "auto",
      multi_agent: { agents: [] },
      snippy: { enabled: false },
      generate: false,
      task_budget: { type: "tokens", total: 100 },
      copilot_cache_control: { type: "ephemeral" },
    }),
  ).toEqual({
    supported: false,
    blockers: [
      "tool_semantics:computer_call_output",
      "prompt",
      "conversation_id",
      "metadata",
      "safety_identifier",
      "prompt_cache_key",
      "prompt_cache_options",
      "prompt_cache_retention",
      "context_management",
      "truncation",
      "multi_agent",
      "snippy",
      "generate",
      "task_budget",
      "copilot_cache_control",
      "reasoning_summary",
      "include",
    ],
  })
})

test("allows exact Responses to Chat controls that have direct mappings", () => {
  expect(
    checkResponsesToChatTranslation({
      model: "chat-only",
      input: "hello",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
      parallel_tool_calls: false,
      reasoning: { effort: "high" },
      user: "user-safe",
    }),
  ).toEqual({ supported: true, blockers: [] })
})

test.each([
  {
    name: "missing call arguments",
    payload: {
      model: "chat-only",
      input: [{ type: "function_call", call_id: "call_1", name: "lookup" }],
    },
    blocker: "function_call",
  },
  {
    name: "unknown tool declaration",
    payload: {
      model: "chat-only",
      input: "hello",
      tools: [{ type: "future_private_tool", secret: "private" }],
    },
    blocker: "tool_semantics",
  },
  {
    name: "malformed function declaration",
    payload: {
      model: "chat-only",
      input: "hello",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: "private-schema",
          strict: false,
        },
      ],
    },
    blocker: "function_tool",
  },
])("rejects Responses to Chat $name", ({ payload, blocker }) => {
  expect(checkResponsesToChatTranslation(payload as never)).toEqual({
    supported: false,
    blockers: [blocker],
  })
})

test("rejects nested Responses details that Chat cannot preserve", () => {
  expect(
    checkResponsesToChatTranslation({
      model: "chat-only",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "hello",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AA==",
              detail: "high",
            },
            {
              type: "input_file",
              filename: "private.pdf",
              file_url: "https://private.invalid/file.pdf",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
    }),
  ).toEqual({
    supported: false,
    blockers: [
      "prompt_cache_breakpoint",
      "image_detail",
      "file_url",
      "strict_function_tool",
    ],
  })
})

test.each([
  {
    name: "image file_id",
    content: { type: "input_image", file_id: "private-file", detail: "auto" },
    blocker: "input_image:file_id",
  },
  {
    name: "empty image",
    content: { type: "input_image", detail: "auto" },
    blocker: "input_image",
  },
  {
    name: "refusal",
    content: { type: "refusal", refusal: "private-refusal" },
    blocker: "content_type",
  },
  {
    name: "future content",
    content: { type: "future_content", value: "private-future" },
    blocker: "content_type",
  },
])(
  "rejects Responses to Chat $name content instead of dropping it",
  ({ content, blocker }) => {
    const payload = {
      model: "chat-only",
      input: [{ type: "message", role: "user", content: [content] }],
    } as ResponsesPayload

    expect(checkResponsesToChatTranslation(payload)).toEqual({
      supported: false,
      blockers: [blocker],
    })
    expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
  },
)

test.each([
  {
    name: "file_id image",
    output: [
      { type: "input_text", text: "kept" },
      { type: "input_image", file_id: "private-file", detail: "auto" },
    ],
    blocker: "input_image:file_id",
  },
  {
    name: "refusal",
    output: [
      { type: "input_text", text: "kept" },
      { type: "refusal", refusal: "private" },
    ],
    blocker: "content_type",
  },
  {
    name: "future content",
    output: [
      { type: "input_text", text: "kept" },
      { type: "future_SECRET_output", value: "private" },
    ],
    blocker: "content_type",
  },
  {
    name: "primitive content",
    output: [{ type: "input_text", text: "kept" }, 7],
    blocker: "content_type",
  },
])(
  "rejects Responses to Chat function output $name without partial loss",
  ({ output, blocker }) => {
    const payload = {
      model: "chat-only",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output,
        },
      ],
    } as ResponsesPayload

    expect(checkResponsesToChatTranslation(payload)).toEqual({
      supported: false,
      blockers: [blocker],
    })
    expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
  },
)

test.each([
  { type: "future_item", value: "private" },
  { value: "missing-type-private" },
])("rejects Responses to Chat unknown input item %#", (item) => {
  const payload = {
    model: "chat-only",
    input: [item],
  } as ResponsesPayload

  expect(checkResponsesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: ["input_item"],
  })
  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
})

test.each([null, 7, "private-primitive"])(
  "rejects primitive Responses to Chat input item %#",
  (item) => {
    const payload = {
      model: "chat-only",
      input: [item],
    } as unknown as ResponsesPayload

    expect(checkResponsesToChatTranslation(payload)).toEqual({
      supported: false,
      blockers: ["input_item"],
    })
    expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
  },
)

test.each([null, 7, "private-content"])(
  "rejects primitive Responses to Chat content part %#",
  (content) => {
    const payload = {
      model: "chat-only",
      input: [{ type: "message", role: "user", content: [content] }],
    } as unknown as ResponsesPayload

    expect(checkResponsesToChatTranslation(payload)).toEqual({
      supported: false,
      blockers: ["content_type"],
    })
    expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
  },
)

test("does not expose a caller-provided unknown content type in blockers or errors", () => {
  const secretType = "future_SECRET_token_123"
  const payload = {
    model: "chat-only",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: secretType, value: "private" }],
      },
    ],
  } as ResponsesPayload

  expect(checkResponsesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: ["content_type"],
  })
  try {
    responsesToChatCompletions(payload)
  } catch (error) {
    expect(JSON.stringify((error as LocalHTTPError).clientBody)).not.toContain(
      secretType,
    )
  }
})

test("rejects numeric Responses reasoning effort instead of dropping it in Chat", () => {
  for (const effort of [0, 2048]) {
    const payload = {
      model: "chat-only",
      input: "hello",
      reasoning: { effort },
    } as ResponsesPayload

    expect(checkResponsesToChatTranslation(payload)).toEqual({
      supported: false,
      blockers: ["numeric_reasoning_effort"],
    })
    expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
  }
})

test.each([
  { tool_choice: "validated", blocker: "tool_choice" },
  { tool_choice: { type: "future_choice" }, blocker: "tool_choice" },
  { tool_choice: { type: "function" }, blocker: "tool_choice" },
  { text: { format: { type: "future_format" } }, blocker: "text_format" },
  { text: { format: { type: "json_schema" } }, blocker: "text_format" },
])("rejects unsupported Responses to Chat control %#", (extra) => {
  const { blocker, ...payloadExtra } = extra
  const payload = {
    model: "chat-only",
    input: "hello",
    ...payloadExtra,
  } as ResponsesPayload

  expect(checkResponsesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: [blocker],
  })
  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
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

test("canonicalizes versioned hosted tools in Responses to Messages blockers", () => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: "hello",
      tools: [{ type: "web_search_20250305", name: "private-search" }],
    }),
  ).toEqual({
    supported: false,
    blockers: ["hosted_tool:web_search"],
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

test("rejects every unmapped Responses to Messages top-level control", () => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: "hello",
      prompt: { id: "private-prompt" },
      conversation_id: "private-conversation",
      metadata: { private: "value" },
      user: "user-safe",
      safety_identifier: "private-safety",
      prompt_cache_key: "private-cache-key",
      prompt_cache_options: { mode: "explicit" },
      prompt_cache_retention: "in_memory",
      include: ["code_interpreter_call.outputs"],
      context_management: [{ type: "truncate" }],
      truncation: "auto",
      multi_agent: { agents: [] },
      snippy: { enabled: false },
      generate: false,
      copilot_cache_control: { type: "ephemeral" },
      tool_choice: "validated",
    }),
  ).toEqual({
    supported: false,
    blockers: [
      "prompt",
      "conversation_id",
      "metadata",
      "safety_identifier",
      "prompt_cache_key",
      "prompt_cache_options",
      "prompt_cache_retention",
      "context_management",
      "truncation",
      "multi_agent",
      "snippy",
      "generate",
      "copilot_cache_control",
      "include",
      "tool_choice",
    ],
  })
})

test("allows exact Responses to Messages controls in the forthcoming bridge subset", () => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: "hello",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
      parallel_tool_calls: false,
      reasoning: { effort: "high", summary: "auto" },
      text: { format: { type: "json_object" } },
      task_budget: { type: "tokens", total: 100 },
      user: "user-safe",
      include: ["reasoning.encrypted_content"],
    }),
  ).toEqual({ supported: true, blockers: [] })
})

test.each(["concise", "detailed", "future_private_summary"])(
  "rejects unmapped Responses to Messages reasoning summary %s",
  (summary) => {
    expect(
      checkResponsesToMessagesTranslation({
        model: "claude-current",
        input: "hello",
        reasoning: { effort: "high", summary: summary as never },
      }),
    ).toEqual({ supported: false, blockers: ["reasoning_summary"] })
  },
)

test("allows integer Responses reasoning effort on the Messages bridge", () => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: "hello",
      reasoning: { effort: 2048, summary: "auto" },
    }),
  ).toEqual({ supported: true, blockers: [] })
})

test.each([
  {
    name: "missing call arguments",
    payload: {
      model: "claude-current",
      input: [{ type: "function_call", call_id: "call_1", name: "lookup" }],
    },
    blocker: "function_call",
  },
  {
    name: "unknown tool declaration",
    payload: {
      model: "claude-current",
      input: "hello",
      tools: [{ type: "future_private_tool", secret: "private" }],
    },
    blocker: "tool_semantics",
  },
  {
    name: "malformed function declaration",
    payload: {
      model: "claude-current",
      input: "hello",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: "private-schema",
          strict: false,
        },
      ],
    },
    blocker: "function_tool",
  },
])("rejects Responses to Messages $name", ({ payload, blocker }) => {
  expect(checkResponsesToMessagesTranslation(payload as never)).toEqual({
    supported: false,
    blockers: [blocker],
  })
})

test("rejects nested Responses details that Messages cannot preserve", () => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "hello",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,AA==",
              detail: "high",
            },
            {
              type: "input_file",
              filename: "private.pdf",
              file_url: "https://private.invalid/file.pdf",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
    }),
  ).toEqual({
    supported: false,
    blockers: [
      "prompt_cache_breakpoint",
      "image_detail",
      "file_url",
      "strict_function_tool",
    ],
  })
})

test.each([
  {
    name: "assistant image content",
    item: {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "input_image",
          image_url: "data:image/png;base64,AA==",
          detail: "auto",
        },
      ],
    },
    blocker: "message_content_role",
  },
  {
    name: "system file content",
    item: {
      type: "message",
      role: "system",
      content: [
        {
          type: "input_file",
          filename: "doc.pdf",
          file_data: "data:application/pdf;base64,AA==",
        },
      ],
    },
    blocker: "message_content_role",
  },
  {
    name: "file_id source",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_file", filename: "doc.pdf", file_id: "file_1" }],
    },
    blocker: "input_file:file_id",
  },
  {
    name: "malformed file data",
    item: {
      type: "message",
      role: "user",
      content: [
        { type: "input_file", filename: "doc.pdf", file_data: "private" },
      ],
    },
    blocker: "input_file",
  },
  {
    name: "invalid message status",
    item: {
      type: "message",
      role: "user",
      content: "hello",
      status: "future_private_status",
    },
    blocker: "item_status",
  },
  {
    name: "missing function output call id",
    item: { type: "function_call_output", call_id: "", output: "done" },
    blocker: "tool_result_pairing",
  },
])("rejects Responses to Messages $name", ({ item, blocker }) => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [item],
    } as unknown as ResponsesPayload),
  ).toEqual({ supported: false, blockers: [blocker] })
})

test.each(["in_progress", "completed", "incomplete"])(
  "rejects Responses to Messages meaningful item status %s",
  (status) => {
    expect(
      checkResponsesToMessagesTranslation({
        model: "claude-current",
        input: [{ type: "message", role: "user", content: "hello", status }],
      } as ResponsesPayload),
    ).toEqual({ supported: false, blockers: ["item_status"] })
  },
)

test.each([
  {
    name: "output_text in a user message",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "output_text", text: "answer" }],
    },
  },
  {
    name: "input_text in an assistant message",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "input_text", text: "prompt" }],
    },
  },
])("rejects Responses to Messages $name", ({ item }) => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [item],
    } as ResponsesPayload),
  ).toEqual({ supported: false, blockers: ["content_direction"] })
})

test.each([undefined, null, 7, { private: true }])(
  "rejects Responses to Messages input_text scalar %#",
  (text) => {
    expect(
      checkResponsesToMessagesTranslation({
        model: "claude-current",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", ...(text === undefined ? {} : { text }) },
            ],
          },
        ],
      } as ResponsesPayload),
    ).toEqual({ supported: false, blockers: ["content_text"] })
  },
)

test.each([undefined, null, 7, { private: true }])(
  "rejects Responses to Messages output_text scalar %#",
  (text) => {
    expect(
      checkResponsesToMessagesTranslation({
        model: "claude-current",
        input: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", ...(text === undefined ? {} : { text }) },
            ],
          },
        ],
      } as ResponsesPayload),
    ).toEqual({ supported: false, blockers: ["content_text"] })
  },
)

test.each([
  "data:text/plain;base64,AA==",
  "data:image/svg+xml;base64,AA==",
  "not-an-image-source",
])("rejects Responses to Messages image source %s", (imageUrl) => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: imageUrl, detail: "auto" },
          ],
        },
      ],
    }),
  ).toEqual({ supported: false, blockers: ["input_image"] })
})

test.each([
  {
    name: "orphan result",
    input: [{ type: "function_call_output", call_id: "call_1", output: "x" }],
  },
  {
    name: "mismatched result",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_2", output: "x" },
    ],
  },
  {
    name: "duplicate result",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "x" },
      { type: "function_call_output", call_id: "call_1", output: "y" },
    ],
  },
])("rejects Responses to Messages $name", ({ input }) => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input,
    } as unknown as ResponsesPayload),
  ).toEqual({ supported: false, blockers: ["tool_result_pairing"] })
})

test.each([
  {
    name: "partial results at EOF",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "first" },
    ],
  },
  {
    name: "calls without results at EOF",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
    ],
  },
  {
    name: "partial results interrupted by a message",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "first" },
      { type: "message", role: "user", content: "continue" },
    ],
  },
])(
  "rejects Responses to Messages incomplete tool group: $name",
  ({ input }) => {
    expect(
      checkResponsesToMessagesTranslation({
        model: "claude-current",
        input,
      } as unknown as ResponsesPayload),
    ).toEqual({ supported: false, blockers: ["tool_result_pairing"] })
  },
)

test("accepts a complete two-call two-result group", () => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "call_2",
          name: "lookup",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_1", output: "first" },
        { type: "function_call_output", call_id: "call_2", output: "second" },
      ],
    }),
  ).toEqual({ supported: true, blockers: [] })
})

test.each(["[]", "1", '"text"', "not-json"])(
  "rejects Responses to Messages function arguments %s",
  (argumentsText) => {
    expect(
      checkResponsesToMessagesTranslation({
        model: "claude-current",
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: argumentsText,
          },
        ],
      }),
    ).toEqual({ supported: false, blockers: ["function_arguments"] })
  },
)

test("rejects named Messages tool choice for an undeclared tool", () => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: "hello",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
      tool_choice: { type: "function", name: "missing" },
    }),
  ).toEqual({ supported: false, blockers: ["tool_choice"] })
})

test.each([
  {
    name: "temperature with top_p",
    payload: { temperature: 0.4, top_p: 0.8 },
  },
  {
    name: "temperature with integer reasoning",
    payload: { temperature: 0.4, reasoning: { effort: 2048, summary: "auto" } },
  },
  {
    name: "top_p with integer reasoning",
    payload: { top_p: 0.8, reasoning: { effort: 2048, summary: "auto" } },
  },
])("rejects Responses to Messages incompatible $name", ({ payload }) => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: "hello",
      ...payload,
    }),
  ).toEqual({ supported: false, blockers: ["sampling"] })
})

test.each([
  {
    name: "image file_id",
    content: { type: "input_image", file_id: "private-file", detail: "auto" },
    blocker: "input_image:file_id",
  },
  {
    name: "empty image",
    content: { type: "input_image", detail: "auto" },
    blocker: "input_image",
  },
  {
    name: "refusal",
    content: { type: "refusal", refusal: "private-refusal" },
    blocker: "content_type",
  },
  {
    name: "future content",
    content: { type: "future_content", value: "private-future" },
    blocker: "content_type",
  },
])("rejects Responses to Messages $name content", ({ content, blocker }) => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [{ type: "message", role: "user", content: [content] }],
    } as ResponsesPayload),
  ).toEqual({ supported: false, blockers: [blocker] })
})

test.each([
  {
    name: "file_id image",
    output: [
      { type: "input_text", text: "kept" },
      { type: "input_image", file_id: "private-file", detail: "auto" },
    ],
    blocker: "input_image:file_id",
  },
  {
    name: "refusal",
    output: [
      { type: "input_text", text: "kept" },
      { type: "refusal", refusal: "private" },
    ],
    blocker: "content_type",
  },
  {
    name: "future content",
    output: [
      { type: "input_text", text: "kept" },
      { type: "future_SECRET_output", value: "private" },
    ],
    blocker: "content_type",
  },
  {
    name: "primitive content",
    output: [{ type: "input_text", text: "kept" }, 7],
    blocker: "content_type",
  },
])(
  "rejects Responses to Messages function output $name",
  ({ output, blocker }) => {
    expect(
      checkResponsesToMessagesTranslation({
        model: "claude-current",
        input: [
          {
            type: "function_call_output",
            call_id: "call_1",
            output,
          },
        ],
      } as ResponsesPayload),
    ).toEqual({
      supported: false,
      blockers: ["tool_result_pairing", blocker],
    })
  },
)

test.each([
  { type: "future_item", value: "private" },
  { value: "missing-type-private" },
])("rejects Responses to Messages unknown input item %#", (item) => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [item],
    } as ResponsesPayload),
  ).toEqual({ supported: false, blockers: ["input_item"] })
})

test.each([null, 7, "private-primitive"])(
  "rejects primitive Responses to Messages input item %#",
  (item) => {
    expect(
      checkResponsesToMessagesTranslation({
        model: "claude-current",
        input: [item],
      } as unknown as ResponsesPayload),
    ).toEqual({ supported: false, blockers: ["input_item"] })
  },
)

test.each([null, 7, "private-content"])(
  "rejects primitive Responses to Messages content part %#",
  (content) => {
    expect(
      checkResponsesToMessagesTranslation({
        model: "claude-current",
        input: [{ type: "message", role: "user", content: [content] }],
      } as unknown as ResponsesPayload),
    ).toEqual({ supported: false, blockers: ["content_type"] })
  },
)

test.each([
  "custom_tool_call",
  "custom_tool_call_output",
  "programmatic_tool_call",
  "programmatic_tool_call_output",
  "computer_call_output",
])("rejects Responses to Messages unsupported item family %s", (type) => {
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [{ type, call_id: "private-call" }],
    }),
  ).toEqual({
    supported: false,
    blockers: [`tool_semantics:${type}`],
  })
})

test.each([
  { tool_choice: "validated", blocker: "tool_choice" },
  { tool_choice: { type: "future_choice" }, blocker: "tool_choice" },
  { tool_choice: { type: "function" }, blocker: "tool_choice" },
  { text: { format: { type: "future_format" } }, blocker: "text_format" },
])("rejects unsupported Responses to Messages control %#", (extra) => {
  const { blocker, ...payloadExtra } = extra
  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: "hello",
      ...payloadExtra,
    } as ResponsesPayload),
  ).toEqual({ supported: false, blockers: [blocker] })
})

test("scans Responses input before tools and top-level controls", () => {
  expect(
    checkResponsesToChatTranslation({
      model: "chat-only",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "refusal", refusal: "private" }],
        },
      ],
      tools: [{ type: "custom", name: "private-tool" }],
      prompt: { id: "private-prompt" },
    }),
  ).toEqual({
    supported: false,
    blockers: ["content_type", "tool_semantics:custom", "prompt"],
  })
})

test("preserves true first-seen order across Responses input items", () => {
  expect(
    checkResponsesToChatTranslation({
      model: "chat-only",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "future_content", value: "private" }],
        },
        {
          type: "reasoning",
          encrypted_content: "private-state",
          summary: [],
        },
      ],
    }),
  ).toEqual({
    supported: false,
    blockers: ["content_type", "opaque_reasoning"],
  })

  expect(
    checkResponsesToMessagesTranslation({
      model: "claude-current",
      input: [
        { type: "future_item", value: "private" },
        {
          type: "custom_tool_call",
          call_id: "call_1",
          name: "private-tool",
        },
      ],
    }),
  ).toEqual({
    supported: false,
    blockers: ["input_item", "tool_semantics:custom_tool_call"],
  })
})

test.each([
  {
    name: "numeric message content",
    item: { type: "message", role: "user", content: 7 },
    blocker: "content_type",
  },
  {
    name: "secret object message content",
    item: {
      type: "message",
      role: "user",
      content: { type: "SECRET_message_content", value: "private" },
    },
    blocker: "content_type",
  },
  {
    name: "numeric function output",
    item: { type: "function_call_output", call_id: "call_1", output: 7 },
    blocker: "content_type",
  },
  {
    name: "secret object function output",
    item: {
      type: "function_call_output",
      call_id: "call_1",
      output: { type: "SECRET_output", value: "private" },
    },
    blocker: "content_type",
  },
])("rejects explicit malformed Responses $name", ({ item, blocker }) => {
  const payload = { model: "chat-only", input: [item] } as ResponsesPayload
  const messagesBlockers =
    item.type === "function_call_output" ?
      ["tool_result_pairing", blocker]
    : [blocker]

  expect(checkResponsesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: [blocker],
  })
  expect(checkResponsesToMessagesTranslation(payload)).toEqual({
    supported: false,
    blockers: messagesBlockers,
  })
  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
  expect(
    JSON.stringify(checkResponsesToChatTranslation(payload)),
  ).not.toContain("SECRET_")
})

test("rejects omitted function output on both Responses translation targets", () => {
  const payload = {
    model: "chat-only",
    input: [{ type: "function_call_output", call_id: "call_1" }],
  } as ResponsesPayload

  expect(checkResponsesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: ["content_type"],
  })
  expect(checkResponsesToMessagesTranslation(payload)).toEqual({
    supported: false,
    blockers: ["tool_result_pairing", "content_type"],
  })

  try {
    responsesToChatCompletions(payload)
    throw new TypeError("Expected translation to reject before conversion")
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect((error as LocalHTTPError).clientBody).toEqual({
      error: {
        code: "endpoint_translation_unsupported",
        message:
          "The selected Copilot model cannot accept this request without losing required protocol data.",
        param: "content_type",
        type: "invalid_request_error",
      },
    })
  }
})

test("keeps omitted message content under its permitted Responses semantics", () => {
  const payload = {
    model: "chat-only",
    input: [{ type: "message", role: "user" }],
  } as ResponsesPayload

  expect(checkResponsesToChatTranslation(payload)).toEqual({
    supported: true,
    blockers: [],
  })
  expect(checkResponsesToMessagesTranslation(payload)).toEqual({
    supported: true,
    blockers: [],
  })
  expect(responsesToChatCompletions(payload).messages).toEqual([
    { role: "user", content: "" },
  ])
})

test.each(["user", "assistant", "system", "developer"] as const)(
  "treats a valid role-only %s record as an implicit Responses message",
  (role) => {
    const payload = {
      model: "chat-only",
      input: [{ role }],
    } as ResponsesPayload

    expect(checkResponsesToChatTranslation(payload)).toEqual({
      supported: true,
      blockers: [],
    })
    expect(checkResponsesToMessagesTranslation(payload)).toEqual({
      supported: true,
      blockers: [],
    })
  },
)

test.each([
  { name: "missing role", item: { type: "message", content: "hello" } },
  {
    name: "unknown role",
    item: { type: "message", role: "future_private_role", content: "hello" },
  },
  {
    name: "numeric role",
    item: { type: "message", role: 7, content: "hello" },
  },
])("rejects explicit Responses message with $name", ({ item }) => {
  const payload = { model: "chat-only", input: [item] } as ResponsesPayload

  expect(checkResponsesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: ["message_role"],
  })
  expect(checkResponsesToMessagesTranslation(payload)).toEqual({
    supported: false,
    blockers: ["message_role"],
  })
})

test.each([
  { name: "missing role", item: {} },
  { name: "unknown role", item: { role: "future_private_role" } },
  { name: "numeric role", item: { role: 7 } },
])("rejects malformed implicit Responses message with $name", ({ item }) => {
  const payload = { model: "chat-only", input: [item] } as ResponsesPayload

  expect(checkResponsesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: ["input_item"],
  })
  expect(checkResponsesToMessagesTranslation(payload)).toEqual({
    supported: false,
    blockers: ["input_item"],
  })
})

test("rejects unknown typed Chat content and tools before Messages conversion", () => {
  const contentPayload = {
    model: "claude-current",
    messages: [
      {
        role: "user" as const,
        content: [{ type: "future_private_content", secret: "do-not-log" }],
      },
    ],
  }
  expect(checkChatToMessagesTranslation(contentPayload as never)).toEqual({
    supported: false,
    blockers: ["message_content_part"],
  })

  const toolPayload = {
    model: "claude-current",
    messages: [{ role: "user" as const, content: "hello" }],
    tools: [{ type: "future_private_tool", secret: "do-not-log" }],
  }
  expect(checkChatToMessagesTranslation(toolPayload as never)).toEqual({
    supported: false,
    blockers: ["tool_semantics"],
  })
})

test("blocks accepted Responses client_metadata on both translation targets", () => {
  const payload = {
    model: "gpt-current",
    input: "hello",
    client_metadata: { session_id: "private-session" },
  } as ResponsesPayload

  expect(checkResponsesToChatTranslation(payload)).toEqual({
    supported: false,
    blockers: ["client_metadata"],
  })
  expect(checkResponsesToMessagesTranslation(payload)).toEqual({
    supported: false,
    blockers: ["client_metadata"],
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
