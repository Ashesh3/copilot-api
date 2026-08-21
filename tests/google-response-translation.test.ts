import { expect, test } from "bun:test"

import {
  createGoogleStreamState,
  translateChunkToGoogle,
  translateOpenAIToGoogle,
  translateResponsesResultToGoogle,
  translateResponsesStreamEventToGoogle,
} from "../src/routes/google-ai/response-translation"

test("uses an immutable public Google model override", () => {
  const translated = translateOpenAIToGoogle(
    {
      id: "id",
      object: "chat.completion",
      created: 1,
      model: "upstream-private-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
    },
    "public-requested-model",
  )
  expect(translated.modelVersion).toBe("public-requested-model")
})

test("preserves modelVersion and promptFeedback on non-streaming chat completions translations", () => {
  const translated = translateOpenAIToGoogle({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini-2025-01-01",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "blocked",
        },
        finish_reason: "content_filter",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  })

  expect(translated.modelVersion).toBe("gpt-4o-mini-2025-01-01")
  expect(translated.promptFeedback).toEqual({ blockReason: "SAFETY" })
})

test("preserves modelVersion on streaming chat completions translations", () => {
  const translated = translateChunkToGoogle(
    {
      id: "chunk-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o-mini-2025-01-01",
      choices: [
        {
          index: 0,
          delta: { content: "hello" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    createGoogleStreamState(),
  )

  expect(translated?.modelVersion).toBe("gpt-4o-mini-2025-01-01")
})

test("preserves modelVersion and promptFeedback on non-streaming Responses translations", () => {
  const translated = translateResponsesResultToGoogle({
    id: "resp_1",
    object: "response",
    created_at: 1,
    model: "gpt-4o-mini-2025-01-01",
    output: [],
    output_text: "",
    status: "incomplete",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
    error: null,
    incomplete_details: { reason: "content_filter" },
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  })

  expect(translated.modelVersion).toBe("gpt-4o-mini-2025-01-01")
  expect(translated.promptFeedback).toEqual({ blockReason: "SAFETY" })
})

test("preserves modelVersion and promptFeedback on streaming Responses translations", () => {
  const translated = translateResponsesStreamEventToGoogle(
    {
      type: "response.incomplete",
      sequence_number: 1,
      response: {
        id: "resp_1",
        object: "response",
        created_at: 1,
        model: "gpt-4o-mini-2025-01-01",
        output: [],
        output_text: "",
        status: "incomplete",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
        error: null,
        incomplete_details: { reason: "content_filter" },
        instructions: null,
        metadata: null,
        parallel_tool_calls: true,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
      },
    } as Parameters<typeof translateResponsesStreamEventToGoogle>[0],
    createGoogleStreamState(),
  )

  expect(translated).toMatchObject({
    kind: "success",
    chunk: {
      modelVersion: "gpt-4o-mini-2025-01-01",
      promptFeedback: { blockReason: "SAFETY" },
    },
  })
})

test.each(["stop", "tool_calls"] as const)(
  "flushes split tool calls in index order on Chat %s",
  (finishReason) => {
    const state = createGoogleStreamState()

    expect(
      translateChunkToGoogle(
        {
          id: "chunk-tools-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: "call_1",
                    type: "function",
                    function: { name: "get_", arguments: '{"city":"' },
                  },
                  {
                    index: 0,
                    id: "call_0",
                    type: "function",
                    function: { name: "find_", arguments: '{"q":"' },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        state,
      ),
    ).toBeNull()

    const terminal = translateChunkToGoogle(
      {
        id: "chunk-tools-2",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: "docs", arguments: 'test"}' },
                },
                {
                  index: 1,
                  function: { name: "weather", arguments: 'Paris"}' },
                },
              ],
            },
            finish_reason: finishReason,
            logprobs: null,
          },
        ],
      },
      state,
    )

    expect(terminal?.candidates[0]?.finishReason).toBe("STOP")
    expect(terminal?.candidates[0]?.content.parts).toEqual([
      {
        functionCall: {
          name: "find_docs",
          args: { q: "test" },
        },
      },
      {
        functionCall: {
          name: "get_weather",
          args: { city: "Paris" },
        },
      },
    ])
  },
)

test("classifies Responses completed and failed events as distinct terminal results", () => {
  const completed = translateResponsesStreamEventToGoogle(
    {
      type: "response.completed",
      sequence_number: 1,
      response: {
        id: "resp_completed",
        object: "response",
        created_at: 1,
        model: "gpt-4o-mini",
        output: [],
        output_text: "",
        status: "completed",
        usage: null,
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: true,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
      },
    } as Parameters<typeof translateResponsesStreamEventToGoogle>[0],
    createGoogleStreamState(),
  )
  const failed = translateResponsesStreamEventToGoogle(
    {
      type: "response.failed",
      sequence_number: 2,
      response: {
        id: "resp_failed",
        object: "response",
        created_at: 1,
        model: "gpt-4o-mini",
        output: [],
        output_text: "",
        status: "failed",
        usage: null,
        error: {
          code: "upstream_error",
          message: "  exact received failure\r\n",
          status: 529,
          upstream_status: 529,
          content_type: "text/plain; charset=utf-8",
          body_bytes: [32, 32, 101],
        },
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: true,
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
      },
    } as Parameters<typeof translateResponsesStreamEventToGoogle>[0],
    createGoogleStreamState(),
  )

  expect(completed).toMatchObject({
    kind: "success",
    chunk: { candidates: [{ finishReason: "STOP" }] },
  })
  expect(failed).toEqual({
    kind: "received_failure",
    failure: {
      error: {
        code: 529,
        message: "  exact received failure\r\n",
        status: "INTERNAL",
        body_bytes: [32, 32, 101],
        content_type: "text/plain; charset=utf-8",
        upstream_status: 529,
      },
    },
  })
})

test("classifies a top-level Responses error as a received Google failure", () => {
  const translated = translateResponsesStreamEventToGoogle(
    {
      type: "error",
      sequence_number: 1,
      code: "upstream_error",
      message: "exact top-level error",
      param: null,
      status: 524,
      upstream_status: 524,
      content_type: "text/plain",
      body_bytes: [101, 114, 114],
    } as Parameters<typeof translateResponsesStreamEventToGoogle>[0],
    createGoogleStreamState(),
  )

  expect(translated).toEqual({
    kind: "received_failure",
    failure: {
      error: {
        code: 524,
        message: "exact top-level error",
        status: "INTERNAL",
        body_bytes: [101, 114, 114],
        content_type: "text/plain",
        upstream_status: 524,
      },
    },
  })
})

test("preserves a nested top-level Responses error with top-level status fallback", () => {
  const translated = translateResponsesStreamEventToGoogle(
    {
      type: "error",
      sequence_number: 2,
      status: 531,
      error: {
        message: "  nested exact body\r\n",
        body_bytes: [32, 32, 110],
        content_type: "text/plain; charset=utf-8",
      },
    } as unknown as Parameters<typeof translateResponsesStreamEventToGoogle>[0],
    createGoogleStreamState(),
  )

  expect(translated).toEqual({
    kind: "received_failure",
    failure: {
      error: {
        code: 531,
        message: "  nested exact body\r\n",
        status: "INTERNAL",
        body_bytes: [32, 32, 110],
        content_type: "text/plain; charset=utf-8",
        upstream_status: 531,
      },
    },
  })
})

test("classifies a Responses incomplete event as a successful Google terminal", () => {
  const incompleteResponse = {
    id: "resp_incomplete",
    object: "response",
    created_at: 1,
    model: "gpt-4o-mini",
    output: [],
    output_text: "",
    status: "incomplete",
    usage: null,
    error: null,
    incomplete_details: { reason: "max_output_tokens" },
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
  const translated = translateResponsesStreamEventToGoogle(
    {
      type: "response.incomplete",
      sequence_number: 1,
      response: incompleteResponse,
    } as Parameters<typeof translateResponsesStreamEventToGoogle>[0],
    createGoogleStreamState(),
  )

  expect(translated).toMatchObject({
    kind: "success",
    chunk: { candidates: [{ finishReason: "MAX_TOKENS" }] },
  })
})
