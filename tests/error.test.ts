import * as Sentry from "@sentry/bun"
import { expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import { forwardError, HTTPError, LocalHTTPError } from "../src/lib/error"

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

test("returns an empty 499 response for upstream client disconnects", async () => {
  const app = new Hono()

  app.get("/client-disconnect", () => {
    throw new HTTPError(
      "Failed to create chat completions",
      new Response("", { status: 499, statusText: "status code 499" }),
    )
  })

  app.onError(async (error, c) => {
    return await forwardError(c, error)
  })

  const response = await app.request("/client-disconnect")
  const body = await response.text()

  expect(response.status).toBe(499)
  expect(body).toBe("")
})

test("returns an explicitly safe local error body without exposing upstream bodies", async () => {
  const app = new Hono()
  const clientBody = {
    error: {
      code: "compaction_payload_too_large",
      message: "Preserved content is too large",
      type: "error",
    },
  }

  app.get("/local-error", () => {
    throw new LocalHTTPError(
      "Compaction payload is too large",
      Response.json({ internal: "not exposed" }, { status: 413 }),
      clientBody,
    )
  })
  app.onError(async (error, c) => await forwardError(c, error))

  const response = await app.request("/local-error")

  expect(response.status).toBe(413)
  expect(await response.json()).toEqual(clientBody)
})

test("redacts affinity identifiers from HTTP error diagnostics", async () => {
  const rawIds = [
    "error-root-session-private",
    "error-root-thread-private",
    "error-conversation-private",
    "error-prompt-cache-private",
    "error-safety-private",
    "error-client-session-private",
    "error-client-thread-private",
    "error-claude-session-private",
  ]
  const payload = {
    session_id: rawIds[0],
    thread_id: rawIds[1],
    conversation_id: rawIds[2],
    prompt_cache_key: rawIds[3],
    safety_identifier: rawIds[4],
    client_metadata: JSON.stringify({
      session_id: rawIds[5],
      thread_id: rawIds[6],
    }),
    metadata: {
      user_id: JSON.stringify({ session_id: rawIds[7] }),
    },
  }
  const errorOutput: Array<unknown> = []
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )
  const app = new Hono()
  app.get("/affinity-error", () => {
    throw new HTTPError(
      "Failed upstream request",
      Response.json({ error: "failed" }, { status: 500 }),
      payload,
    )
  })
  app.onError(async (error, c) => await forwardError(c, error))

  try {
    await app.request("/affinity-error")
    for (const call of errorSpy.mock.calls) errorOutput.push(...call)
    const diagnosticOutput = JSON.stringify([
      errorOutput,
      captureException.mock.calls,
    ])
    for (const rawId of rawIds) {
      expect(diagnosticOutput).not.toContain(rawId)
    }
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})
