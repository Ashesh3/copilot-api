import { expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { LocalHTTPError } from "~/lib/error"
import {
  applyResponsesReasoningDefaults,
  prepareResponsesRequest,
} from "~/services/copilot/responses-contract"

function captureValidationError(payload: ResponsesPayload): LocalHTTPError {
  try {
    prepareResponsesRequest(payload)
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    return error as LocalHTTPError
  }
  throw new Error("Expected Responses validation error")
}

const ALWAYS_BLOCKED_RESPONSES_TOOLS = [
  "code_interpreter",
  "computer_use",
  "computer_use_preview",
  "file_search",
  "local_shell",
  "mcp",
  "mcp_list_tools",
]

const FORWARDED_RESPONSES_TOOLS = [
  "function",
  "custom",
  "namespace",
  "shell",
  "apply_patch",
  "programmatic_tool_calling",
  "web_search",
  "computer",
  "image_generation",
  "client_future_tool",
]

test("preserves the reviewed current Responses field inventory", () => {
  const result = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "stable prefix",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
    ],
    context_management: [{ type: "truncate" }],
    truncation: "auto",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "in_memory",
    metadata: { trace: "value" },
    user: "user-1",
    snippy: { enabled: false },
  })
  expect(result.body).toMatchObject({
    context_management: [{ type: "truncate" }],
    truncation: "auto",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "in_memory",
    metadata: { trace: "value" },
    user: "user-1",
    snippy: { enabled: false },
  })
  expect(JSON.stringify(result.body)).toContain("prompt_cache_breakpoint")
})

test("keeps reasoning disabled without requesting summaries or encrypted state", () => {
  const body = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: "hello",
    reasoning: { effort: "none" },
    include: ["code_interpreter_call.outputs"],
  }).body

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.reasoning).toEqual({ effort: "none" })
  expect(body.include).toEqual(["code_interpreter_call.outputs"])
})

test("removes encrypted reasoning inclusion when reasoning is disabled", () => {
  const body = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    reasoning: { effort: "none", summary: "detailed" },
    include: ["reasoning.encrypted_content", "code_interpreter_call.outputs"],
  }).body

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.reasoning).toEqual({ effort: "none" })
  expect(body.include).toEqual(["code_interpreter_call.outputs"])
})

test("preserves integer reasoning effort", () => {
  const body = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    reasoning: { effort: 2048 },
  }).body

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.reasoning).toEqual({ effort: 2048, summary: "auto" })
  expect(body.include).toContain("reasoning.encrypted_content")
})

test("adds encrypted reasoning inclusion once", () => {
  const body = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    include: ["reasoning.encrypted_content"],
  }).body
  const preparedInclude = body.include

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.include).toEqual(["reasoning.encrypted_content"])
  expect(body.include).not.toBe(preparedInclude)
})

test("treats null reasoning as absent", () => {
  const body = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    reasoning: null,
  }).body

  applyResponsesReasoningDefaults({
    body,
    defaultEffort: "medium",
    implicitDefault: false,
  })

  expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" })
})

test.each(["compaction", "truncate"])(
  "accepts %s context management",
  (type) => {
    const body = prepareResponsesRequest({
      model: "gpt-current",
      input: "hello",
      context_management: [
        { type, threshold: 4096, future_nested: { enabled: true } },
      ],
    }).body

    expect(body.context_management).toEqual([
      { type, threshold: 4096, future_nested: { enabled: true } },
    ])
  },
)

test("accepts null context management without forwarding it", () => {
  const body = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    context_management: null,
  }).body

  expect(body).not.toHaveProperty("context_management")
})

test("rejects unsupported context management types locally", () => {
  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    context_management: [{ type: "future_unknown" }],
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "unsupported_value", param: "context_management" },
  })
})

test.each([1, null, undefined])(
  "rejects unsupported context management type %p locally",
  (type) => {
    const error = captureValidationError({
      model: "gpt-current",
      input: "hello",
      context_management: [{ type } as unknown as Record<string, unknown>],
    })

    expect(error.clientBody).toMatchObject({
      error: { code: "unsupported_value", param: "context_management" },
    })
  },
)

test.each([{ value: "truncate" }, { value: [null] }] as const)(
  "rejects invalid context management shape",
  ({ value }) => {
    const error = captureValidationError({
      model: "gpt-current",
      input: "hello",
      context_management:
        value as unknown as ResponsesPayload["context_management"],
    })

    expect(error.clientBody).toMatchObject({
      error: { code: "invalid_type", param: "context_management" },
    })
  },
)

test.each([
  ["store", { store: true }],
  ["background", { background: true }],
  ["previous_response_id", { previous_response_id: "resp_external" }],
  ["service_tier", { service_tier: "priority" }],
] as const)("rejects unsupported stateful control %s", (param, extra) => {
  expect(() =>
    prepareResponsesRequest({
      model: "gpt-5.6-sol",
      input: "hello",
      ...extra,
    }),
  ).toThrow(LocalHTTPError)
  try {
    prepareResponsesRequest({ model: "gpt-5.6-sol", input: "hello", ...extra })
  } catch (error) {
    expect((error as LocalHTTPError).clientBody).toMatchObject({
      error: { code: "unsupported_value", param },
    })
  }
})

test("accepts stateless false and null values without forwarding them", () => {
  const body = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: "hello",
    store: false,
    background: false,
    previous_response_id: null,
  }).body
  expect(body.store).toBe(false)
  expect(body).not.toHaveProperty("background")
  expect(body).not.toHaveProperty("previous_response_id")
})

test("omits unknown top-level fields but preserves unknown nested fields", () => {
  const body = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi", future_nested: 1 }],
        future_item: 2,
      },
    ],
    future_top_level: 3,
  }).body
  expect(body).not.toHaveProperty("future_top_level")
  expect(JSON.stringify(body.input)).toContain("future_nested")
  expect(JSON.stringify(body.input)).toContain("future_item")
})

test.each([
  ["store", "yes"],
  ["background", 1],
] as const)("rejects invalid boolean stateful control %s", (param, value) => {
  const error = captureValidationError({
    model: "gpt-5.6-sol",
    input: "hello",
    [param]: value,
  })
  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param },
  })
})

test.each([
  ["previous_response_id", 1],
  ["service_tier", false],
] as const)("rejects invalid typed stateful control %s", (param, value) => {
  const error = captureValidationError({
    model: "gpt-5.6-sol",
    input: "hello",
    [param]: value,
  })
  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param },
  })
})

test("rejects an empty previous_response_id as unsupported", () => {
  const error = captureValidationError({
    model: "gpt-5.6-sol",
    input: "hello",
    previous_response_id: "",
  })
  expect(error.clientBody).toMatchObject({
    error: { code: "unsupported_value", param: "previous_response_id" },
  })
})

test("accepts null stateful controls without forwarding them", () => {
  const body = prepareResponsesRequest({
    model: "gpt-5.6-sol",
    input: "hello",
    store: null,
    background: null,
    previous_response_id: null,
    service_tier: null,
  }).body

  expect(body).not.toHaveProperty("store")
  expect(body).not.toHaveProperty("background")
  expect(body).not.toHaveProperty("previous_response_id")
  expect(body).not.toHaveProperty("service_tier")
})

test.each(ALWAYS_BLOCKED_RESPONSES_TOOLS)(
  "rejects blocked native Responses tool %s",
  (type) => {
    const error = captureValidationError({
      model: "gpt-current",
      input: "hello",
      tools: [{ type }],
    })

    expect(error.clientBody).toEqual({
      error: {
        code: "unsupported_value",
        message:
          "The Copilot Responses endpoint does not support one or more requested tools.",
        param: "tools",
        type: "invalid_request_error",
      },
    })
  },
)

test.each(FORWARDED_RESPONSES_TOOLS)(
  "preserves upstream-authorized Responses tool class %s",
  (type) => {
    const tool =
      type === "function" ?
        {
          type,
          name: "run",
          description: "Run a command",
          parameters: { type: "object", properties: {} },
          strict: false,
        }
      : { type, name: "run", future_option: { enabled: true } }
    const body = prepareResponsesRequest({
      model: "gpt-current",
      input: "hello",
      tools: [tool],
    }).body

    expect((body.tools as Array<Record<string, unknown>>)[0]).toEqual(tool)
  },
)

test.each([
  { name: "non-array tools", tools: "function" },
  { name: "null tool item", tools: [null] },
  { name: "array tool item", tools: [[]] },
  { name: "primitive tool item", tools: ["function"] },
  { name: "missing tool type", tools: [{ name: "run" }] },
  { name: "non-string tool type", tools: [{ type: 1 }] },
])("rejects malformed Responses $name", ({ tools }) => {
  const error = captureValidationError({
    model: "gpt-current",
    input: "hello",
    tools: tools as unknown as ResponsesPayload["tools"],
  })

  expect(error.clientBody).toMatchObject({
    error: { code: "invalid_type", param: "tools" },
  })
})

test.each([
  { name: "omitted", tools: undefined },
  { name: "null", tools: null },
  { name: "empty", tools: [] },
])("removes Responses tool controls when tools are $name", ({ tools }) => {
  const body = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    tools: tools as ResponsesPayload["tools"],
    tool_choice: "required",
    parallel_tool_calls: true,
  }).body

  expect(body).not.toHaveProperty("tools")
  expect(body).not.toHaveProperty("tool_choice")
  expect(body).not.toHaveProperty("parallel_tool_calls")
})

test("preserves Responses tool controls when a real tool is available", () => {
  const body = prepareResponsesRequest({
    model: "gpt-current",
    input: "hello",
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object" },
        strict: false,
      },
    ],
    tool_choice: "required",
    parallel_tool_calls: true,
  }).body

  expect(body.tool_choice).toBe("required")
  expect(body.parallel_tool_calls).toBe(true)
})

test("prepares a new top-level body without mutating caller values", () => {
  const payload: ResponsesPayload = {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: {},
        strict: false,
      },
    ],
    store: false,
    background: false,
  }

  const result = prepareResponsesRequest(payload)

  expect(result.body).not.toBe(payload)
  expect(result.body.input).not.toBe(payload.input)
  expect(payload.tools?.[0]).toMatchObject({ parameters: {} })
  expect(result.body.tools?.[0]).toMatchObject({
    parameters: { type: "object", properties: {} },
  })
})
