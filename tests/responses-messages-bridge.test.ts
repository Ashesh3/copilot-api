import { expect, test } from "bun:test"

import type { AnthropicResponse } from "~/routes/messages/anthropic-types"

import { LocalHTTPError } from "~/lib/error"
import { chatPayloadToAnthropic } from "~/routes/chat-completions/anthropic-bridge"
import {
  convertOpenAIContentPartToAnthropic,
  convertOpenAIToolsToAnthropic,
} from "~/routes/chat-completions/anthropic-conversion"
import {
  anthropicResponseToResponsesResult,
  responsesPayloadToAnthropic,
} from "~/routes/responses/messages-bridge"

test("maps text image document function tools and results to Messages", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    instructions: "Be concise.",
    max_output_tokens: 512,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Summarize" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,AA==",
            detail: "auto",
          },
          {
            type: "input_file",
            filename: "doc.pdf",
            file_data: "data:application/pdf;base64,AA==",
          },
        ],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ],
    tool_choice: "auto",
  })

  expect(payload).toMatchObject({
    model: "claude-current",
    max_tokens: 512,
    system: "Be concise.",
    tool_choice: { type: "auto" },
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        input_schema: { type: "object", properties: {} },
      },
    ],
  })
  expect(payload.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AA==" },
        },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "AA==",
          },
          title: "doc.pdf",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "lookup",
          input: {},
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "done" },
      ],
    },
  ])
})

test("maps Responses sampling reasoning output format and user metadata", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: "Return JSON.",
    temperature: 0.4,
    top_p: 0.8,
    user: "user-safe",
    reasoning: { effort: "high", summary: "auto" },
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
    },
    task_budget: { type: "tokens", total: 4000, remaining: 2500 },
    parallel_tool_calls: false,
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ],
  })

  expect(payload).toMatchObject({
    temperature: 0.4,
    top_p: 0.8,
    metadata: { user_id: "user-safe" },
    output_config: {
      effort: "high",
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
      task_budget: { type: "tokens", total: 4000, remaining: 2500 },
    },
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  })
})

test("maps integer Responses reasoning effort to a Messages thinking budget", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: "Think carefully.",
    reasoning: { effort: 2048, summary: "auto" },
  })

  expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
})

test("accepts implicit Responses messages with omitted content", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [{ role: "user" }],
  })

  expect(payload.messages).toEqual([{ role: "user", content: "" }])
})

test("preserves separate assistant text and function calls in input order", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [
      { type: "message", role: "assistant", content: "I will look it up." },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
  })

  expect(payload.messages).toEqual([
    {
      role: "assistant",
      content: [{ type: "text", text: "I will look it up." }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "lookup", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "done" },
      ],
    },
  ])
})

test.each([
  {
    name: "invalid function call",
    payload: {
      model: "claude-current",
      input: [{ type: "function_call", call_id: "call_1", name: "lookup" }],
    },
    param: "function_call",
  },
  {
    name: "unknown tool declaration",
    payload: {
      model: "claude-current",
      input: "hello",
      tools: [{ type: "future_private_tool", secret: "do-not-log" }],
    },
    param: "tool_semantics",
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
    param: "function_tool",
  },
])("refuses Responses to Messages $name", async ({ payload, param }) => {
  const error = await responsesPayloadToAnthropic(payload as never).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param },
  })
  expect(JSON.stringify((error as LocalHTTPError).clientBody)).not.toContain(
    "private",
  )
})

test("refuses opaque Responses reasoning before Messages conversion", async () => {
  const error = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [
      {
        type: "reasoning",
        encrypted_content: "private-state",
        summary: [],
      },
    ],
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "opaque_reasoning",
    },
  })
})

test("converts Anthropic text thinking tools usage stop and model alias", () => {
  const response: AnthropicResponse = {
    id: "msg_native_1",
    type: "message",
    role: "assistant",
    model: "resolved-claude-model",
    content: [
      { type: "thinking", thinking: "considering", signature: "sig-native" },
      { type: "text", text: "answer" },
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: { query: "status" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 3,
    },
  }

  const result = anthropicResponseToResponsesResult(response, "claude-current")
  expect(typeof result.created_at).toBe("number")
  expect({ ...result, created_at: 1 }).toEqual({
    id: "msg_native_1",
    object: "response",
    created_at: 1,
    model: "claude-current",
    output: [
      {
        id: "rs_msg_native_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "considering" }],
        encrypted_content: "sig-native",
        status: "completed",
      },
      {
        id: "msg_msg_native_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
      {
        id: "fc_call_1",
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"query":"status"}',
        status: "completed",
      },
    ],
    output_text: "answer",
    status: "completed",
    usage: {
      input_tokens: 19,
      output_tokens: 7,
      total_tokens: 26,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  })
})

test("maps Anthropic max-token and refusal stops to Responses status", () => {
  const base: AnthropicResponse = {
    id: "msg_stop",
    type: "message",
    role: "assistant",
    model: "resolved",
    content: [],
    stop_reason: "max_tokens",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  }

  expect(anthropicResponseToResponsesResult(base, "requested")).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  })
  expect(
    anthropicResponseToResponsesResult(
      { ...base, stop_reason: "refusal" },
      "requested",
    ),
  ).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "content_filter" },
  })
})

test.each([
  {
    name: "unknown typed content",
    payload: {
      model: "claude-current",
      messages: [
        {
          role: "user",
          content: [{ type: "future_private_content", secret: "do-not-log" }],
        },
      ],
    },
    param: "message_content_part",
  },
  {
    name: "unknown typed tool",
    payload: {
      model: "claude-current",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "future_private_tool", secret: "do-not-log" }],
    },
    param: "tool_semantics",
  },
])("fails closed on Chat to Messages $name", async ({ payload, param }) => {
  const error = await chatPayloadToAnthropic(payload as never).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param },
  })
  expect(JSON.stringify((error as LocalHTTPError).clientBody)).not.toContain(
    "private",
  )
})

test("shared Anthropic conversion helpers reject unknown content and tools", async () => {
  const contentError = await convertOpenAIContentPartToAnthropic({
    type: "future_private_content",
    secret: "private",
  } as never).catch((caught: unknown) => caught)
  expect(contentError).toBeInstanceOf(LocalHTTPError)
  expect((contentError as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "message_content_part",
    },
  })

  expect(() =>
    convertOpenAIToolsToAnthropic([
      { type: "future_private_tool", secret: "private" },
    ] as never),
  ).toThrow(LocalHTTPError)
})
