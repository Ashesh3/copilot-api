import { expect, test } from "bun:test"
import { Hono } from "hono"

import { HTTPError } from "~/lib/error"
import { forwardMessagesError } from "~/routes/messages/error"

// Claude Code parses this form to decide how much history to compact.
const CLAUDE_CODE_PROMPT_TOO_LONG =
  /prompt is too long\D*(\d+)\s*tokens?\s*>\s*(\d+)/i

interface AnthropicErrorBody {
  type: string
  request_id?: string
  error: { type: string; message: string; code?: string }
}

async function forwardAnthropicError(
  error: unknown,
  requestId = "req-overflow",
): Promise<Response> {
  const route = new Hono()
  route.get("/error", async (c) => await forwardMessagesError(c, error))
  return await route.request("/error", {
    headers: { "x-request-id": requestId },
  })
}

test("restates a Copilot prompt token limit as a Messages prompt-too-long error", async () => {
  const response = await forwardAnthropicError(
    new HTTPError(
      "Failed to create responses",
      Response.json(
        {
          error: {
            message: "prompt token count of 204543 exceeds the limit of 200000",
            code: "model_max_prompt_tokens_exceeded",
          },
        },
        { status: 400 },
      ),
    ),
  )

  expect(response.status).toBe(400)
  const body = (await response.json()) as AnthropicErrorBody
  expect(body).toEqual({
    type: "error",
    request_id: "req-overflow",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: 204543 tokens > 200000 maximum",
      code: "model_max_prompt_tokens_exceeded",
    },
  })
  expect(
    CLAUDE_CODE_PROMPT_TOO_LONG.exec(body.error.message)?.slice(1),
  ).toEqual(["204543", "200000"])
})

test("restates a provider context window overflow as prompt-too-long", async () => {
  const response = await forwardAnthropicError(
    new HTTPError(
      "Failed to create responses",
      Response.json(
        {
          error: {
            message:
              "Your input exceeds the context window of this model. Please reduce your input and try again.",
            type: "invalid_request_error",
            param: "input",
            code: "context_length_exceeded",
          },
        },
        { status: 400 },
      ),
    ),
  )

  expect(response.status).toBe(400)
  expect((await response.json()) as AnthropicErrorBody).toMatchObject({
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "prompt is too long: Your input exceeds the context window of this model. Please reduce your input and try again.",
    },
  })
})

test("restates a Chat Completions maximum context length error with its counts", async () => {
  const response = await forwardAnthropicError(
    new HTTPError(
      "Failed to create chat completions",
      Response.json(
        {
          error: {
            message:
              "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens. Please reduce the length of the messages.",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      ),
    ),
  )

  expect(response.status).toBe(400)
  const body = (await response.json()) as AnthropicErrorBody
  expect(body.error.message).toBe(
    "prompt is too long: 130512 tokens > 128000 maximum",
  )
  expect(
    CLAUDE_CODE_PROMPT_TOO_LONG.exec(body.error.message)?.slice(1),
  ).toEqual(["130512", "128000"])
})

test("forwards Anthropic prompt-too-long and unrelated upstream errors as sent", async () => {
  for (const body of [
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 210000 tokens > 200000 maximum",
        code: "model_max_prompt_tokens_exceeded",
      },
    },
    { error: { message: "Invalid tool schema", code: "invalid_request_body" } },
  ]) {
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    const response = await forwardAnthropicError(
      new HTTPError(
        "Failed to create responses",
        new Response(bytes.slice(), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    )

    expect(response.status).toBe(400)
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(bytes),
    )
  }
})
