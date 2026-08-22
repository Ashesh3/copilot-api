import { describe, expect, test } from "bun:test"

import {
  classifyCompatibilityRetry,
  type CompatibilityRetryEndpoint,
} from "../src/services/copilot/compatibility-retry"
import {
  claimCompatibilityRetry,
  createRetryBudget,
} from "../src/services/copilot/transport-retry"

const errorResponse = (code: string, message: string, extra?: object) =>
  Response.json({ ...extra, error: { code, message } }, { status: 400 })

async function normalize(options: {
  body: Record<string, unknown>
  endpoint: CompatibilityRetryEndpoint
  response: Response
}) {
  const source = structuredClone(options.body)
  const decision = await classifyCompatibilityRetry(options)
  expect(decision.kind).not.toBe("none")
  if (decision.kind === "none") throw new Error("expected retry decision")
  const retry = structuredClone(options.body)
  expect(decision.normalize(retry)).toBe(true)
  expect(options.body).toEqual(source)
  expect(decision.normalize(retry)).toBe(false)
  return { kind: decision.kind, retry }
}

describe("compatibility retry classifier", () => {
  test("removes only unsupported temperature from a Chat wire clone", async () => {
    const body = { model: "m", temperature: 0, top_p: 0.5, messages: [] }
    const result = await normalize({
      body,
      endpoint: "/chat/completions",
      response: errorResponse(
        "invalid_request_body",
        "Unsupported parameter: 'temperature' is not supported with this model.",
      ),
    })
    expect(result).toEqual({
      kind: "unsupported_temperature",
      retry: { model: "m", top_p: 0.5, messages: [] },
    })
  })

  test("removes only unsupported top_p from a Responses wire clone", async () => {
    const body = { model: "m", temperature: 0.2, top_p: null, input: [] }
    const result = await normalize({
      body,
      endpoint: "/responses",
      response: errorResponse(
        "invalid_request_body",
        "Unsupported parameter: 'top_p' is not supported with this model.",
      ),
    })
    expect(result.retry).toEqual({ model: "m", temperature: 0.2, input: [] })
  })

  test("removes tool controls only when tools are absent or empty", async () => {
    for (const endpoint of ["/chat/completions", "/responses"] as const) {
      const result = await normalize({
        body: {
          model: "m",
          tool_choice: "required",
          parallel_tool_calls: false,
          tools: [],
        },
        endpoint,
        response: errorResponse(
          "invalid_request_body",
          "Invalid request content: A tool_choice was set on the request but no tools were specified.",
        ),
      })
      expect(result.retry).toEqual({ model: "m", tools: [] })
    }
  })

  test("recognizes encrypted compaction without mutating its clone", async () => {
    const body = {
      model: "m",
      input: [{ type: "compaction", encrypted_content: "opaque" }],
    }
    const source = structuredClone(body)
    const response = errorResponse(
      "invalid_encrypted_content",
      "Encrypted content opaque could not be decrypted or parsed.",
    )
    const decision = await classifyCompatibilityRetry({
      body,
      endpoint: "/responses",
      response,
    })
    expect(decision.kind).toBe("encrypted_compaction_verification")
    if (decision.kind === "none") throw new Error("expected retry decision")
    const retry = structuredClone(body)
    expect(decision.normalize(retry)).toBe(true)
    expect(retry).toEqual(source)
    expect(body).toEqual(source)
    expect(await response.text()).toContain("opaque")
  })

  test("strips only assistant thinking blocks for exact native Messages errors", async () => {
    const body = {
      model: "claude",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret", signature: "bad" },
            {
              type: "text",
              text: "kept",
              cache_control: { type: "ephemeral" },
            },
            { type: "tool_use", id: "call", name: "tool", input: {} },
          ],
        },
      ],
      tools: [{ name: "tool", input_schema: { type: "object" } }],
    }
    const result = await normalize({
      body,
      endpoint: "/v1/messages",
      response: Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Invalid signature in thinking block",
          },
        },
        { status: 400 },
      ),
    })
    expect(result.retry).toEqual({
      model: "claude",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "kept",
              cache_control: { type: "ephemeral" },
            },
            { type: "tool_use", id: "call", name: "tool", input: {} },
          ],
        },
      ],
      tools: [{ name: "tool", input_schema: { type: "object" } }],
    })
  })

  test("rejects every near miss and leaves the original response readable", async () => {
    const exact =
      "Unsupported parameter: 'temperature' is not supported with this model."
    const cases: Array<{
      body?: Record<string, unknown>
      endpoint?: CompatibilityRetryEndpoint
      response: Response
    }> = [
      { response: new Response("not json", { status: 400 }) },
      { response: Response.json([], { status: 400 }) },
      {
        response: Response.json(
          { error: { code: "invalid_request_body" } },
          { status: 400 },
        ),
      },
      { response: errorResponse("invalid_request_body", `${exact} extra`) },
      { response: errorResponse("invalid_request_body", exact.toLowerCase()) },
      { response: errorResponse("other", exact) },
      {
        body: { model: "m" },
        response: errorResponse("invalid_request_body", exact),
      },
      {
        endpoint: "/v1/messages",
        response: errorResponse("invalid_request_body", exact),
      },
      { response: errorResponse("invalid_request_body", "Bad Request") },
      { response: errorResponse("invalid_request_body", "Invalid signature") },
      {
        body: { model: "m", tool_choice: "required", tools: [{}] },
        response: errorResponse(
          "invalid_request_body",
          "Invalid request content: A tool_choice was set on the request but no tools were specified.",
        ),
      },
      {
        body: {
          model: "m",
          messages: [
            { role: "assistant", content: [{ type: "text", text: "x" }] },
          ],
        },
        endpoint: "/v1/messages",
        response: errorResponse(
          "invalid_request_body",
          "Invalid `signature` in thinking block",
        ),
      },
      {
        response: errorResponse("invalid_request_body", exact),
        body: { temperature: 1 },
        endpoint: "/responses",
      },
    ]
    const non400 = cases.at(-1)
    if (!non400) throw new Error("Expected non-400 fixture")
    non400.response = errorResponse("invalid_request_body", exact)
    Object.defineProperty(non400.response, "status", { value: 422 })

    for (const item of cases) {
      const response = item.response
      const decision = await classifyCompatibilityRetry({
        body: item.body ?? { model: "m", temperature: 1 },
        endpoint: item.endpoint ?? "/chat/completions",
        response,
      })
      expect(decision).toEqual({ kind: "none" })
      expect(response.bodyUsed).toBe(false)
    }
  })
})

test("compatibility retry budget can be claimed only once and shares total sends", () => {
  const budget = createRetryBudget({ extraSends: 2 })
  expect(claimCompatibilityRetry(budget)).toBe(true)
  expect(budget).toEqual({ compatibilityRetryUsed: true, remaining: 1 })
  expect(claimCompatibilityRetry(budget)).toBe(false)

  const exhausted = createRetryBudget({ extraSends: 0 })
  expect(claimCompatibilityRetry(exhausted)).toBe(false)
  expect(exhausted).toEqual({ compatibilityRetryUsed: false, remaining: 0 })
})
