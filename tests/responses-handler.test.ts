import { expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import {
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

test("converts non-apply_patch custom tools for chat completions fallback only", () => {
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

  const chatCompletionsPayload = responsesToChatCompletions(payload)

  expect(chatCompletionsPayload.tools).toEqual([
    {
      type: "function",
      function: {
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
    },
  ])
})

test("preserves custom tool calls and results in chat completions fallback", () => {
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

test("keeps ordinary custom tool history out of chat completions fallback", () => {
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

  expect(responsesToChatCompletions(payload).messages).toEqual([])
})
