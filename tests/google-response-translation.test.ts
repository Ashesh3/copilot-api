import { expect, test } from "bun:test"

import {
  createGoogleStreamState,
  translateChunkToGoogle,
  translateOpenAIToGoogle,
  translateResponsesResultToGoogle,
  translateResponsesStreamEventToGoogle,
} from "../src/routes/google-ai/response-translation"

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

  expect(translated?.modelVersion).toBe("gpt-4o-mini-2025-01-01")
  expect(translated?.promptFeedback).toEqual({ blockReason: "SAFETY" })
})
