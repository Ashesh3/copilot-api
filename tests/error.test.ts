import { expect, test } from "bun:test"
import { Hono } from "hono"

import { forwardError, HTTPError } from "../src/lib/error"

test("returns a clear quota exhausted message for upstream 402 responses", async () => {
  const app = new Hono()

  app.get("/quota", () => {
    throw new HTTPError(
      "Failed to create chat completions",
      new Response(
        JSON.stringify({
          error: {
            message: "interaction quota exhausted",
          },
        }),
        {
          status: 402,
          headers: { "content-type": "application/json" },
        },
      ),
    )
  })

  app.onError(async (error, c) => {
    return await forwardError(c, error)
  })

  const response = await app.request("/quota")
  const body = await response.json()

  expect(response.status).toBe(402)
  expect(body).toEqual({
    error: {
      message: "Copilot quota exhausted",
      type: "error",
    },
  })
})

test("returns a clear version compatibility message for upstream 466 responses", async () => {
  const app = new Hono()

  app.get("/compatibility", () => {
    throw new HTTPError(
      "Failed to create chat completions",
      new Response("Client version too old", {
        status: 466,
        headers: { "content-type": "text/plain" },
      }),
    )
  })

  app.onError(async (error, c) => {
    return await forwardError(c, error)
  })

  const response = await app.request("/compatibility")
  const body = await response.json()

  expect(response.status).toBe(466)
  expect(body).toEqual({
    error: {
      message: "Copilot client version mismatch",
      type: "error",
    },
  })
})

test("does not forward raw upstream error bodies to clients", async () => {
  const app = new Hono()

  app.get("/internal-error", () => {
    throw new HTTPError(
      "Failed to create chat completions",
      new Response("request_id=req_123 internal upstream failure", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    )
  })

  app.onError(async (error, c) => {
    return await forwardError(c, error)
  })

  const response = await app.request("/internal-error")
  const body = await response.json()

  expect(response.status).toBe(500)
  expect(body).toEqual({
    error: {
      message: "Failed to create chat completions",
      type: "error",
    },
  })
})
