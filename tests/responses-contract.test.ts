import { expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { LocalHTTPError } from "~/lib/error"
import { prepareResponsesRequest } from "~/services/copilot/responses-contract"

function captureValidationError(payload: ResponsesPayload): LocalHTTPError {
  try {
    prepareResponsesRequest(payload)
  } catch (error) {
    expect(error).toBeInstanceOf(LocalHTTPError)
    return error as LocalHTTPError
  }
  throw new Error("Expected Responses validation error")
}

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
