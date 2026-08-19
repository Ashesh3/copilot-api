import { expect, test } from "bun:test"
import { Hono } from "hono"

import { HTTPError, LocalHTTPError } from "~/lib/error"
import { forwardMessagesError } from "~/routes/messages/error"

const app = new Hono()

app.get("/error", async (c) => {
  const kind = c.req.query("kind")
  if (kind === "local") {
    const body = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "max_tokens is required for Messages requests.",
      },
    }
    return await forwardMessagesError(
      c,
      new LocalHTTPError(
        body.error.message,
        Response.json(body, { status: 400 }),
        body,
      ),
    )
  }
  if (kind === "invalid-local") {
    const body = {
      error: {
        type: "invalid_request_error",
        message: "local-openai-private-marker",
      },
    }
    return await forwardMessagesError(
      c,
      new LocalHTTPError(
        body.error.message,
        Response.json(body, { status: 400 }),
        body,
      ),
    )
  }
  if (kind === "runtime") {
    return await forwardMessagesError(c, new Error("runtime-private-marker"))
  }
  return await forwardMessagesError(
    c,
    new HTTPError(
      "upstream-runtime-private-marker",
      Response.json(
        { error: { message: "private-upstream-marker" } },
        {
          status: Number(kind),
          statusText: "private-status-marker",
        },
      ),
    ),
  )
})

test("preserves a local Anthropic error body", async () => {
  const response = await app.request("/error?kind=local", {
    headers: { "x-request-id": "req-local" },
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "max_tokens is required for Messages requests.",
    },
  })
})

test.each([
  [400, "invalid_request_error", "The Copilot Messages request was rejected."],
  [401, "authentication_error", "Copilot authentication failed."],
  [402, "api_error", "Copilot quota exhausted."],
  [403, "permission_error", "The Copilot Messages request is not permitted."],
  [
    404,
    "not_found_error",
    "The requested Copilot Messages resource was not found.",
  ],
  [413, "request_too_large", "The Copilot Messages request is too large."],
  [429, "rate_limit_error", "Copilot rate limit exceeded."],
  [466, "api_error", "Copilot client version mismatch."],
  [500, "api_error", "The Copilot Messages request failed."],
] as const)(
  "maps HTTP %s to Anthropic error type %s",
  async (status, type, message) => {
    const response = await app.request(`/error?kind=${status}`, {
      headers: { "x-request-id": "req-safe" },
    })

    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({
      type: "error",
      request_id: "req-safe",
      error: { type, message },
    })
  },
)

test("does not preserve a non-Anthropic local body", async () => {
  const response = await app.request("/error?kind=invalid-local", {
    headers: { "x-request-id": "req-invalid-local" },
  })
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(JSON.parse(body)).toEqual({
    type: "error",
    request_id: "req-invalid-local",
    error: {
      type: "invalid_request_error",
      message: "The Copilot Messages request was rejected.",
    },
  })
  expect(body).not.toContain("local-openai-private-marker")
})

test("returns a fixed Anthropic error for unexpected runtime failures", async () => {
  const response = await app.request("/error?kind=runtime", {
    headers: { "x-request-id": "req-runtime" },
  })
  const body = await response.text()

  expect(response.status).toBe(500)
  expect(JSON.parse(body)).toEqual({
    type: "error",
    request_id: "req-runtime",
    error: {
      type: "api_error",
      message: "The Copilot Messages request failed.",
    },
  })
  expect(body).not.toContain("runtime-private-marker")
})
