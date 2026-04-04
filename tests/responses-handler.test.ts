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
