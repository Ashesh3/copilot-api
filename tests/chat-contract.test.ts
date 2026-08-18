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

test("keeps undefined object fields while validating JSON serializability", () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    stop: undefined,
  }

  const normalized = normalizeChatCompletionsRequest(payload)

  expect(normalized).toHaveProperty("stop", undefined)
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
  for (const functionCall of ["none"] as const) {
    const normalized = normalizeChatCompletionsRequest({
      model: "gpt-current",
      messages: [{ role: "user", content: "hello" }],
      function_call: functionCall,
    })
    expect(normalized.tool_choice).toBe(functionCall)
    expect(normalized).not.toHaveProperty("function_call")
  }

  const normalizedAuto = normalizeChatCompletionsRequest({
    model: "gpt-current",
    messages: [{ role: "user", content: "hello" }],
    functions: [{ name: "lookup", parameters: {} }],
    function_call: "auto",
  })
  expect(normalizedAuto.tool_choice).toBe("auto")
  expect(normalizedAuto).not.toHaveProperty("function_call")
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

  test("rejects BigInt values with the same safe local error", () => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [{ role: "user", content: "hello" }],
          metadata: { count: 1n },
        } as unknown as ChatCompletionsPayload),
      {
        code: "invalid_type",
        message: "The request body must be a JSON object.",
        param: "body",
      },
    )
  })

  test("rejects cyclic values with the same safe local error", () => {
    const payload = {
      model: "gpt-current",
      messages: [{ role: "user", content: "hello" }],
    } as unknown as ChatCompletionsPayload & { self?: unknown }
    payload.self = payload

    expectValidationError(() => normalizeChatCompletionsRequest(payload), {
      code: "invalid_type",
      message: "The request body must be a JSON object.",
      param: "body",
    })
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

describe("Chat route-invariant shape validation", () => {
  test.each([
    { name: "numeric scalar", content: 7 },
    { name: "object scalar", content: { text: "hello" } },
  ])("rejects $name message content", ({ content }) => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [{ role: "user", content }],
        } as unknown as ChatCompletionsPayload),
      { code: "invalid_type", param: "messages" },
    )
  })

  test("accepts string null and valid content arrays", () => {
    for (const content of [
      "hello",
      null,
      [{ type: "text", text: "hello" }],
      [
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,AA==",
            detail: "auto",
          },
        },
      ],
      [
        {
          type: "file",
          file: {
            filename: "review.pdf",
            file_data: "data:application/pdf;base64,AA==",
          },
        },
      ],
      [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "AA==",
          },
        },
      ],
    ]) {
      expect(
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [{ role: "user", content }],
        } as ChatCompletionsPayload).messages[0].content as unknown,
      ).toEqual(content as unknown)
    }
  })

  test.each([
    { name: "primitive part", content: [7] },
    { name: "typeless part", content: [{ text: "hello" }] },
    { name: "invalid text", content: [{ type: "text", text: 7 }] },
    {
      name: "invalid image",
      content: [{ type: "image_url", image_url: { url: "" } }],
    },
    {
      name: "invalid document",
      content: [{ type: "document", source: "private" }],
    },
  ])("rejects a $name content record", ({ content }) => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [{ role: "user", content }],
        } as unknown as ChatCompletionsPayload),
      { code: "invalid_type", param: "messages" },
    )
  })

  test.each([
    { name: "object", tools: { type: "function" } },
    { name: "string", tools: "private-tools" },
  ])("rejects non-array $name tools", ({ tools }) => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [{ role: "user", content: "hello" }],
          tools,
        } as unknown as ChatCompletionsPayload),
      { code: "invalid_type", param: "tools" },
    )
  })

  test.each([
    { name: "absent", toolChoice: undefined },
    { name: "null", toolChoice: null },
    { name: "none", toolChoice: "none" },
  ])("accepts $name tool choice without usable tools", ({ toolChoice }) => {
    const normalized = normalizeChatCompletionsRequest({
      model: "gpt-current",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    } as ChatCompletionsPayload)

    expect(normalized.tool_choice).toBe(toolChoice)
  })

  test.each([
    { name: "auto", toolChoice: "auto" },
    { name: "required", toolChoice: "required" },
    {
      name: "named function",
      toolChoice: { type: "function", function: { name: "lookup" } },
    },
  ])("rejects $name tool choice without usable tools", ({ toolChoice }) => {
    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          model: "gpt-current",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          tool_choice: toolChoice,
        } as ChatCompletionsPayload),
      { code: "invalid_value", param: "tool_choice" },
    )
  })

  test("requires named function choices to match a usable tool", () => {
    const payload = {
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
    } satisfies ChatCompletionsPayload

    expect(
      normalizeChatCompletionsRequest({
        ...payload,
        tool_choice: { type: "function", function: { name: "lookup" } },
      }).tool_choice,
    ).toEqual({ type: "function", function: { name: "lookup" } })

    expectValidationError(
      () =>
        normalizeChatCompletionsRequest({
          ...payload,
          tool_choice: { type: "function", function: { name: "missing" } },
        }),
      { code: "invalid_value", param: "tool_choice" },
    )
  })
})
