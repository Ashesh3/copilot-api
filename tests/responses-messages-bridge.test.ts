import { expect, test } from "bun:test"

import type { AnthropicResponse } from "~/routes/messages/anthropic-types"

import { LocalHTTPError } from "~/lib/error"
import { chatPayloadToAnthropic } from "~/routes/chat-completions/anthropic-bridge"
import {
  convertOpenAIContentPartToAnthropic,
  convertOpenAIToolsToAnthropic,
} from "~/routes/chat-completions/anthropic-conversion"
import { emitResponsesResultAsStream } from "~/routes/messages/web-search-helpers"
import {
  anthropicResponseToResponsesResult,
  responsesPayloadToAnthropic,
} from "~/routes/responses/messages-bridge"

/* eslint-disable max-lines */

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

test.each([
  { temperature: 0.4, topP: undefined },
  { temperature: undefined, topP: 0.8 },
])(
  "maps Responses sampling reasoning output format and user metadata",
  async ({ temperature, topP }) => {
    const payload = await responsesPayloadToAnthropic({
      model: "claude-current",
      input: "Return JSON.",
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      user: "user-safe",
      reasoning: { effort: "high", summary: "auto" },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
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
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      metadata: { user_id: "user-safe" },
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
        task_budget: { type: "tokens", total: 4000, remaining: 2500 },
      },
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    })
  },
)

test.each([
  { name: "temperature", temperature: 0.4, topP: undefined },
  { name: "top_p", temperature: undefined, topP: 0.8 },
])(
  "round-trips accepted Responses $name request controls",
  async ({ temperature, topP }) => {
    const request = {
      model: "claude-current",
      input: "Return JSON.",
      max_output_tokens: 512,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      reasoning: { effort: "high", summary: "auto" as const },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object", properties: {} },
        },
      },
      tools: [
        {
          type: "function" as const,
          name: "lookup",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
      tool_choice: { type: "function", name: "lookup" },
      parallel_tool_calls: false,
    }
    const anthropic = await responsesPayloadToAnthropic(request)
    const response: AnthropicResponse = {
      id: "msg_round_trip",
      type: "message",
      role: "assistant",
      model: "resolved",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    expect(anthropic).toMatchObject({
      max_tokens: 512,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
      output_config: {
        effort: "high",
        format: request.text.format,
      },
      tool_choice: {
        type: "tool",
        name: "lookup",
        disable_parallel_tool_use: true,
      },
    })
    expect(
      anthropicResponseToResponsesResult(response, "requested", request),
    ).toMatchObject({
      model: "requested",
      parallel_tool_calls: false,
      temperature: temperature ?? null,
      top_p: topP ?? null,
      tool_choice: request.tool_choice,
      tools: request.tools,
      max_output_tokens: 512,
      reasoning: request.reasoning,
      text: request.text,
    })
  },
)

test("round-trips integer reasoning request context", async () => {
  const request = {
    model: "claude-current",
    input: "Think.",
    reasoning: { effort: 2048, summary: "auto" as const },
  }
  const response: AnthropicResponse = {
    id: "msg_integer",
    type: "message",
    role: "assistant",
    model: "resolved",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }

  expect(await responsesPayloadToAnthropic(request)).toMatchObject({
    thinking: { type: "enabled", budget_tokens: 2048 },
  })
  expect(
    anthropicResponseToResponsesResult(response, "requested", request),
  ).toMatchObject({ reasoning: request.reasoning })
})

test("maps integer Responses reasoning effort to a Messages thinking budget", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: "Think carefully.",
    reasoning: { effort: 2048, summary: "auto" },
  })

  expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
})

test.each(["concise", "detailed", "future_private_summary"])(
  "refuses unmapped reasoning summary %s before Messages wire/result echo",
  async (summary) => {
    const request = {
      model: "claude-current",
      input: "Think carefully.",
      reasoning: { effort: "high", summary },
    }
    const error = await responsesPayloadToAnthropic(request as never).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(LocalHTTPError)
    expect((error as LocalHTTPError).clientBody).toMatchObject({
      error: {
        code: "endpoint_translation_unsupported",
        param: "reasoning_summary",
      },
    })
  },
)

test("accepts implicit Responses messages with omitted content", async () => {
  const payload = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [{ role: "user" }],
  })

  expect(payload.messages).toEqual([{ role: "user", content: "" }])
})

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
])("refuses explicit Responses message with $name", async ({ item }) => {
  const error = await responsesPayloadToAnthropic({
    model: "claude-current",
    input: [item],
  } as never).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param: "message_role" },
  })
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
      content: [
        { type: "text", text: "I will look it up." },
        { type: "tool_use", id: "call_1", name: "lookup", input: {} },
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

test("groups multiple function calls and results into legal Anthropic turns", async () => {
  const request = {
    model: "claude-current",
    input: [
      {
        type: "function_call" as const,
        call_id: "call_1",
        name: "lookup",
        arguments: '{"query":"one"}',
      },
      {
        type: "function_call" as const,
        call_id: "call_2",
        name: "lookup",
        arguments: '{"query":"two"}',
      },
      {
        type: "function_call_output" as const,
        call_id: "call_1",
        output: "first",
      },
      {
        type: "function_call_output" as const,
        call_id: "call_2",
        output: "second",
      },
    ],
  }

  const payload = await responsesPayloadToAnthropic(request)

  expect(payload.messages).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "lookup",
          input: { query: "one" },
        },
        {
          type: "tool_use",
          id: "call_2",
          name: "lookup",
          input: { query: "two" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "first" },
        { type: "tool_result", tool_use_id: "call_2", content: "second" },
      ],
    },
  ])
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
])("refuses incomplete tool group: $name", async ({ input }) => {
  const error = await responsesPayloadToAnthropic({
    model: "claude-current",
    input,
  } as never).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "tool_result_pairing",
    },
  })
})

test.each([
  {
    name: "result order differs from call order",
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
      { type: "function_call_output", call_id: "call_2", output: "second" },
      { type: "function_call_output", call_id: "call_1", output: "first" },
    ],
  },
])("refuses unrepresentable function grouping: $name", async ({ input }) => {
  const error = await responsesPayloadToAnthropic({
    model: "claude-current",
    input,
  } as never).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: {
      code: "endpoint_translation_unsupported",
      param: "tool_result_pairing",
    },
  })
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

test.each([
  {
    name: "meaningful status",
    payload: {
      model: "claude-current",
      input: [
        {
          type: "message",
          role: "user",
          content: "hello",
          status: "incomplete",
        },
      ],
    },
    param: "item_status",
  },
  {
    name: "wrong text direction",
    payload: {
      model: "claude-current",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "output_text", text: "answer" }],
        },
      ],
    },
    param: "content_direction",
  },
  {
    name: "unsupported image source",
    payload: {
      model: "claude-current",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:text/plain;base64,AA==",
              detail: "auto",
            },
          ],
        },
      ],
    },
    param: "input_image",
  },
  {
    name: "orphan tool result",
    payload: {
      model: "claude-current",
      input: [
        { type: "function_call_output", call_id: "call_1", output: "done" },
      ],
    },
    param: "tool_result_pairing",
  },
  {
    name: "non-object function arguments",
    payload: {
      model: "claude-current",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "[]",
        },
      ],
    },
    param: "function_arguments",
  },
  {
    name: "undeclared named tool choice",
    payload: {
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
    },
    param: "tool_choice",
  },
])("direct bridge refuses $name", async ({ payload, param }) => {
  const error = await responsesPayloadToAnthropic(payload as never).catch(
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(LocalHTTPError)
  expect((error as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "endpoint_translation_unsupported", param },
  })
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

test("preserves interleaved Anthropic blocks and every thinking signature", () => {
  const response: AnthropicResponse = {
    id: "msg_interleaved",
    type: "message",
    role: "assistant",
    model: "resolved",
    content: [
      { type: "thinking", thinking: "first", signature: "sig-first" },
      { type: "text", text: "alpha" },
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: { query: "one" },
      },
      { type: "thinking", thinking: "second", signature: "sig-second" },
      { type: "text", text: "omega" },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  }

  const result = anthropicResponseToResponsesResult(response, "requested")
  expect(result.output.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
    "function_call",
    "reasoning",
    "message",
  ])
  expect(result.output_text).toBe("alphaomega")
  expect(result.output).toMatchObject([
    {
      id: "rs_msg_interleaved",
      encrypted_content: "sig-first",
      summary: [{ type: "summary_text", text: "first" }],
    },
    {
      id: "msg_msg_interleaved",
      content: [{ type: "output_text", text: "alpha", annotations: [] }],
    },
    { id: "fc_call_1", call_id: "call_1" },
    {
      id: "rs_msg_interleaved_1",
      encrypted_content: "sig-second",
      summary: [{ type: "summary_text", text: "second" }],
    },
    {
      id: "msg_msg_interleaved_1",
      content: [{ type: "output_text", text: "omega", annotations: [] }],
    },
  ])
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

test("emits reasoning lifecycle and the result's terminal status", async () => {
  const writes: Array<{ event?: string; data: string }> = []
  const result = anthropicResponseToResponsesResult(
    {
      id: "msg_stream_reasoning",
      type: "message",
      role: "assistant",
      model: "resolved",
      content: [
        {
          type: "thinking",
          thinking: "considering",
          signature: "sig-stream",
        },
      ],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    "requested",
  )

  await emitResponsesResultAsStream(
    {
      writeSSE: (data) => {
        writes.push(data)
        return Promise.resolve()
      },
    },
    result,
  )

  expect(writes.map((entry) => entry.event)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.output_item.done",
    "response.incomplete",
  ])
  const parsedWrites = writes.map(
    (entry) => JSON.parse(entry.data) as Record<string, unknown>,
  )
  expect(parsedWrites).toMatchObject([
    {},
    {},
    { delta: "considering", summary_index: 0 },
    { text: "considering", summary_index: 0 },
    {},
    { type: "response.incomplete", response: { status: "incomplete" } },
  ])
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

test.each([
  {
    name: "non-image data URI",
    part: {
      type: "image_url",
      image_url: { url: "data:text/plain;base64,AA==", detail: "auto" },
    },
  },
  {
    name: "malformed PDF file",
    part: {
      type: "file",
      file: {
        filename: "document.pdf",
        file_data: "data:text/plain;base64,AA==",
      },
    },
  },
])(
  "shared Anthropic converter refuses $name instead of omitting it",
  async ({ part }) => {
    const error = await convertOpenAIContentPartToAnthropic(
      part as never,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LocalHTTPError)
    expect((error as LocalHTTPError).clientBody).toMatchObject({
      error: {
        code: "endpoint_translation_unsupported",
        param: "message_content_part",
      },
    })
  },
)
