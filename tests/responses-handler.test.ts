import { expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import { LocalHTTPError } from "../src/lib/error"
import {
  assertResponsesChatFallbackTranslation,
  responsesToChatCompletions,
  useFunctionApplyPatch,
} from "../src/routes/responses/handler"

test("keeps non-apply_patch custom tools unchanged on the native responses path", () => {
  const payload = {
    model: "gpt-4o",
    input: "Hello",
    tools: [
      {
        type: "custom",
        name: "run_sql",
        description: "Execute a SQL query",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ],
  } as ResponsesPayload

  useFunctionApplyPatch(payload)

  expect(payload.tools).toEqual([
    {
      type: "custom",
      name: "run_sql",
      description: "Execute a SQL query",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  ])
})

test("rejects custom tool semantics in chat completions fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: "Hello",
    tools: [
      {
        type: "custom",
        name: "run_sql",
        description: "Execute a SQL query",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ],
  } as ResponsesPayload

  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
})

test("preserves custom tool calls and results for compaction fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_custom",
        name: "exec",
        input: "run canonical command",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_custom",
        output: "canonical result",
      },
    ],
  } as ResponsesPayload

  const result = responsesToChatCompletions(payload, {
    preserveCustomToolContext: true,
  })

  expect(result.messages).toEqual([
    {
      role: "assistant",
      content: "[Custom tool call call_custom: exec(run canonical command)]",
    },
    {
      role: "user",
      content: "[Custom tool result call_custom: canonical result]",
    },
  ])
})

test("rejects ordinary computer output but preserves it for compaction", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "computer_call_output",
        call_id: "call_computer",
        output: "canonical computer result",
      },
    ],
  } as ResponsesPayload

  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
  expect(
    responsesToChatCompletions(payload, { preserveCustomToolContext: true })
      .messages,
  ).toEqual([
    {
      role: "user",
      content:
        "[Computer tool result call_computer: canonical computer result]",
    },
  ])
})

test("maps Responses parallel tools reasoning and user controls to Chat", () => {
  const result = responsesToChatCompletions({
    model: "gpt-4o",
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
  })

  expect(result.parallel_tool_calls).toBe(false)
  expect(result.reasoning_effort).toBe("high")
  expect(result.user).toBe("user-safe")
})

test("compaction fallback still rejects unrelated lossy Responses state", () => {
  expect(() =>
    assertResponsesChatFallbackTranslation(
      {
        model: "gpt-4o",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_custom",
            name: "exec",
            input: "run",
          },
        ],
        tools: [{ type: "namespace", name: "private_namespace" }],
      },
      true,
    ),
  ).toThrow(LocalHTTPError)
})

test("rejects ordinary custom tool history in chat completions fallback", () => {
  const payload = {
    model: "gpt-4o",
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_ordinary_custom",
        name: "exec",
        input: "ordinary command",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_ordinary_custom",
        output: "ordinary result",
      },
    ],
  } as ResponsesPayload

  expect(() => responsesToChatCompletions(payload)).toThrow(LocalHTTPError)
})

test("rejects a lossy Responses to Chat fallback before conversion", () => {
  expect(() =>
    responsesToChatCompletions({
      model: "chat-only",
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-encrypted-state",
          summary: [],
        },
      ],
    }),
  ).toThrow(LocalHTTPError)

  try {
    responsesToChatCompletions({
      model: "chat-only",
      input: [
        {
          type: "reasoning",
          encrypted_content: "private-encrypted-state",
          summary: [],
        },
      ],
    })
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect((error as LocalHTTPError).clientBody).toEqual({
      error: {
        code: "endpoint_translation_unsupported",
        message:
          "The selected Copilot model cannot accept this request without losing required protocol data.",
        param: "opaque_reasoning",
        type: "invalid_request_error",
      },
    })
  }
})
