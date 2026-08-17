import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { LocalHTTPError } from "~/lib/error"
import { normalizeChatCompletionsRequest } from "~/routes/chat-completions/chat-contract"

function expectValidationError(
  action: () => unknown,
  options: { code: string; message?: string; param: string },
): void {
  try {
    action()
    throw new Error("Expected Chat request validation to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect(error).toHaveProperty("response.status", 400)
    expect(error).toHaveProperty("clientBody.error.code", options.code)
    if (options.message) {
      expect(error).toHaveProperty("clientBody.error.message", options.message)
    }
    expect(error).toHaveProperty("clientBody.error.param", options.param)
    expect(error).toHaveProperty(
      "clientBody.error.type",
      "invalid_request_error",
    )
  }
}

test("preserves supported Chat fields and stop shapes on an immutable clone", () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    max_completion_tokens: 256,
    prediction: { type: "content", content: "known" },
    reasoning_effort: "high",
    thinking_budget: 1024,
    top_logprobs: 3,
    stop: ["END", "DONE"],
  }

  const normalized = normalizeChatCompletionsRequest(payload)

  expect(normalized).toMatchObject({
    max_completion_tokens: 256,
    prediction: { type: "content", content: "known" },
    reasoning_effort: "high",
    thinking_budget: 1024,
    top_logprobs: 3,
    stop: ["END", "DONE"],
  })
  expect(normalized).not.toBe(payload)
  expect(normalized.messages).not.toBe(payload.messages)
  expect(normalized.prediction).not.toBe(payload.prediction)

  normalized.messages[0].content = "changed"
  const normalizedPrediction = normalized.prediction
  if (!normalizedPrediction) throw new Error("Expected normalized prediction")
  normalizedPrediction.content = "changed"
  expect(payload.messages[0].content).toBe("hello")
  expect(payload.prediction?.content).toBe("known")
})

test("preserves string and null stop values", () => {
  const stringStop = normalizeChatCompletionsRequest({
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    stop: "END",
  })
  const nullStop = normalizeChatCompletionsRequest({
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    stop: null,
  })

  expect(stringStop.stop).toBe("END")
  expect(nullStop.stop).toBeNull()
})

test("converts deprecated functions and function_call to modern controls", () => {
  const normalized = normalizeChatCompletionsRequest({
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    functions: [
      {
        name: "legacy",
        description: "Legacy lookup",
        parameters: {},
      },
    ],
    function_call: { name: "legacy" },
  })

  expect(normalized.tools).toEqual([
    {
      type: "function",
      function: {
        name: "legacy",
        description: "Legacy lookup",
        parameters: { type: "object", properties: {} },
      },
    },
  ])
  expect(normalized.tool_choice).toEqual({
    type: "function",
    function: { name: "legacy" },
  })
  expect(normalized).not.toHaveProperty("functions")
  expect(normalized).not.toHaveProperty("function_call")
})

test("appends legacy functions after modern tools and keeps modern tool_choice", () => {
  const normalized = normalizeChatCompletionsRequest({
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "modern",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    tool_choice: "required",
    functions: [{ name: "legacy", parameters: { type: "object" } }],
    function_call: { name: "legacy" },
  })

  expect(normalized.tools?.map((tool) => tool.function.name)).toEqual([
    "modern",
    "legacy",
  ])
  expect(normalized.tools?.[1]?.function.parameters).toEqual({
    type: "object",
    properties: {},
  })
  expect(normalized.tool_choice).toBe("required")
  expect(normalized).not.toHaveProperty("functions")
  expect(normalized).not.toHaveProperty("function_call")
})

test("repairs only function tool parameter schemas", () => {
  const normalized = normalizeChatCompletionsRequest({
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { type: "web_search" },
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "", properties: null },
        },
      },
    ],
  } as unknown as ChatCompletionsPayload)

  expect(normalized.tools?.[0] as unknown).toEqual({ type: "web_search" })
  expect(normalized.tools?.[1]).toEqual({
    type: "function",
    function: {
      name: "lookup",
      parameters: { type: "object", properties: {} },
    },
  })
})

test("maps deprecated string function_call values", () => {
  for (const functionCall of ["none", "auto"] as const) {
    const normalized = normalizeChatCompletionsRequest({
      model: "gpt-current",
      messages: [{ role: "user", content: "hello" }],
      function_call: functionCall,
    })
    expect(normalized.tool_choice).toBe(functionCall)
    expect(normalized).not.toHaveProperty("function_call")
  }
})

describe("Chat request validation", () => {
  test("rejects a null request body with a safe local error", () => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest(
          null as unknown as ChatCompletionsPayload,
        ),
      {
        code: "invalid_type",
        message: "The request body must be a JSON object.",
        param: "body",
      },
    )
  })

  test("rejects an unusable request body with the same safe local error", () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()

    expectValidationError(
      () =>
        normalizeChatCompletionsRequest(
          proxy as unknown as ChatCompletionsPayload,
        ),
      {
        code: "invalid_type",
        message: "The request body must be a JSON object.",
        param: "body",
      },
    )
  })

  test("rejects max_tokens with max_completion_tokens", () => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 128,
          max_completion_tokens: 128,
        }),
      { code: "invalid_request", param: "max_tokens" },
    )
  })

  test("rejects an empty model", () => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "  ",
          messages: [{ role: "user", content: "hello" }],
        }),
      { code: "invalid_value", param: "model" },
    )
  })

  test("rejects empty messages", () => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [],
        }),
      { code: "invalid_value", param: "messages" },
    )
  })

  test("rejects malformed deprecated functions", () => {
    const malformedPayloads = [
      { functions: "lookup" },
      { functions: [null] },
      { functions: [{}] },
      { functions: [{ name: "" }] },
      { functions: [{ name: "lookup", description: 42 }] },
    ]

    for (const malformed of malformedPayloads) {
      expectValidationError(
        () =>
          normalizeChatCompletionsRequest({
            model: "gpt-current",
            messages: [{ role: "user", content: "hello" }],
            ...malformed,
          } as unknown as ChatCompletionsPayload),
        { code: "invalid_type", param: "functions" },
      )
    }
  })

  test("rejects malformed deprecated functions even with modern tools", () => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [{ role: "user", content: "hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "modern",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          functions: [{ name: "" }],
        }),
      { code: "invalid_type", param: "functions" },
    )
  })

  test("rejects malformed deprecated function_call", () => {
    const malformedValues = ["required", "lookup", {}, { name: "" }, 42]

    for (const functionCall of malformedValues) {
      expectValidationError(
        () =>
          normalizeChatCompletionsRequest({
            model: "gpt-current",
            messages: [{ role: "user", content: "hello" }],
            function_call: functionCall,
          } as unknown as ChatCompletionsPayload),
        { code: "invalid_value", param: "function_call" },
      )
    }
  })

  test("rejects malformed deprecated function_call despite modern tool_choice", () => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [{ role: "user", content: "hello" }],
          tool_choice: "required",
          function_call: "required",
        }),
      { code: "invalid_value", param: "function_call" },
    )
  })
})
