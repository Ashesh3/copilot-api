import * as Sentry from "@sentry/bun"
import { expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import {
  forwardError,
  HTTPError,
  inspectSafeHttpError,
  LocalHTTPError,
} from "../src/lib/error"

function captureContextValue(
  captureException: ReturnType<typeof spyOn<typeof Sentry, "captureException">>,
) {
  return captureException.mock.calls.at(-1)?.[1]
}

async function forwardOpenAIError(error: unknown): Promise<Response> {
  const app = new Hono()
  app.get("/error", async (c) => await forwardError(c, error))
  return await app.request("/error")
}

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

test("returns a sanitized upstream validation reason for HTTP 400 responses", async () => {
  const app = new Hono()
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  app.get("/invalid-request", () => {
    throw new HTTPError(
      "Failed to create responses",
      Response.json(
        {
          error: {
            code: "invalid_request_body",
            message: JSON.stringify({
              code: "invalid-argument",
              error:
                "Invalid request content: A tool_choice was set on the request but no tools were specified.",
            }),
          },
        },
        { status: 400 },
      ),
    )
  })
  app.onError(async (error, c) => await forwardError(c, error))

  try {
    const response = await app.request("/invalid-request")

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request_body",
        message:
          "Invalid request content: A tool_choice was set on the request but no tools were specified.",
        type: "invalid_request_error",
      },
    })
    const captureContext = captureException.mock.calls[0]?.[1]
    const fingerprint =
      typeof captureContext === "object" && "fingerprint" in captureContext ?
        captureContext.fingerprint
      : undefined
    expect(fingerprint).toEqual([
      "http-error",
      "/invalid-request",
      "400",
      "invalid_request_body",
      "tool_choice_without_tools",
    ])
  } finally {
    captureException.mockRestore()
  }
})

test("redacts secrets from upstream validation reasons returned to clients", async () => {
  const app = new Hono()

  app.get("/invalid-secret", () => {
    throw new HTTPError(
      "Failed to create responses",
      Response.json(
        {
          error: {
            code: "invalid_request_body",
            message: "Invalid authorization token Bearer private-token-value",
          },
        },
        { status: 400 },
      ),
    )
  })
  app.onError(async (error, c) => await forwardError(c, error))

  const response = await app.request("/invalid-secret")
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(body).not.toContain("private-token-value")
  expect(JSON.parse(body)).toEqual({
    error: {
      message: "Failed to create responses",
      type: "error",
    },
  })
})

test("does not forward unrecognized upstream validation text", async () => {
  const app = new Hono()

  app.get("/unknown-validation", () => {
    throw new HTTPError(
      "Failed to create responses",
      Response.json(
        {
          error: {
            code: "invalid_request_body",
            message: "Invalid value copied from user-controlled input",
          },
        },
        { status: 400 },
      ),
    )
  })
  app.onError(async (error, c) => await forwardError(c, error))

  const response = await app.request("/unknown-validation")

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      message: "Failed to create responses",
      type: "error",
    },
  })
})

test("does not forward an allowlisted validation prefix with an arbitrary suffix", async () => {
  const app = new Hono()

  app.get("/tainted-validation", () => {
    throw new HTTPError(
      "Failed to create responses",
      Response.json(
        {
          error: {
            code: "invalid_request_body",
            message:
              "Unsupported parameter: 'temperature' is not supported with this model. diagnostics=private-suffix",
          },
        },
        { status: 400 },
      ),
    )
  })
  app.onError(async (error, c) => await forwardError(c, error))

  const response = await app.request("/tainted-validation")
  const body = await response.text()

  expect(body).not.toContain("private-suffix")
  expect(JSON.parse(body)).toEqual({
    error: {
      message: "Failed to create responses",
      type: "error",
    },
  })
})

test("does not expose upstream response bodies in logs or Sentry", async () => {
  const errorOutput: Array<unknown> = []
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )
  const app = new Hono()
  app.get("/private-upstream", () => {
    throw new HTTPError(
      "Failed upstream request",
      Response.json(
        { error: { message: "upstream-private-marker" } },
        { status: 500 },
      ),
    )
  })
  app.onError(async (error, c) => await forwardError(c, error))

  try {
    await app.request("/private-upstream")
    for (const call of errorSpy.mock.calls) errorOutput.push(...call)
    expect(
      JSON.stringify([errorOutput, captureException.mock.calls]),
    ).not.toContain("upstream-private-marker")
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})

test("does not expose an upstream-derived HTTP error message", async () => {
  const errorOutput: Array<unknown> = []
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )
  const app = new Hono()
  app.get("/private-error-message", () => {
    throw new HTTPError(
      "upstream-message-private-marker",
      Response.json(
        { error: { message: "different-private-body" } },
        { status: 500, statusText: "private-status-marker" },
      ),
    )
  })
  app.onError(async (error, c) => await forwardError(c, error))

  try {
    const response = await app.request("/private-error-message")
    for (const call of errorSpy.mock.calls) errorOutput.push(...call)
    const diagnostics = JSON.stringify([
      errorOutput,
      captureException.mock.calls,
      await response.text(),
    ])
    expect(diagnostics).not.toContain("upstream-message-private-marker")
    expect(diagnostics).not.toContain("private-status-marker")
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})

test("uses one guarded HTTP snapshot for OpenAI output logs and Sentry", async () => {
  const privateMarkers = [
    "http-message-getter-private-marker",
    "http-status-getter-private-marker",
    "http-headers-getter-private-marker",
    "http-body-getter-private-marker",
  ]
  let getterCalls = 0
  const upstream = Response.json(
    {
      error: {
        code: "invalid_request_body",
        message:
          "Invalid request content: A tool_choice was set on the request but no tools were specified.",
      },
    },
    { status: 400, headers: { "retry-after": "17" } },
  )
  for (const [key, marker] of [
    ["status", privateMarkers[1]],
    ["headers", privateMarkers[2]],
    ["body", privateMarkers[3]],
  ] as const) {
    Object.defineProperty(upstream, key, {
      configurable: true,
      get() {
        getterCalls += 1
        throw new Error(marker)
      },
    })
  }
  const error = new HTTPError("Failed to create responses", upstream)
  Object.defineProperty(error, "message", {
    configurable: true,
    get() {
      getterCalls += 1
      throw new Error(privateMarkers[0])
    },
  })
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  try {
    const response = await forwardOpenAIError(error)
    const body = await response.text()
    const diagnostics = JSON.stringify([
      body,
      errorSpy.mock.calls,
      captureException.mock.calls,
    ])

    expect(response.status).toBe(400)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "invalid_request_body",
        message:
          "Invalid request content: A tool_choice was set on the request but no tools were specified.",
        type: "invalid_request_error",
      },
    })
    expect(getterCalls).toBe(0)
    expect(errorSpy.mock.calls).toContainEqual([
      "[400] Upstream request failed",
    ])
    const context = captureContextValue(captureException)
    expect(context).toMatchObject({
      tags: { status: "400" },
      extra: { status: 400, validationClass: "tool_choice_without_tools" },
    })
    expect(captureException.mock.calls.at(-1)?.[0]).toMatchObject({
      message: "Upstream request failed",
    })
    for (const marker of privateMarkers) {
      expect(diagnostics).not.toContain(marker)
    }
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})

test("uses the first immutable HTTP values when later reads would alternate", async () => {
  const upstream = Response.json(
    { error: { message: "unclassified" } },
    {
      status: 429,
    },
  )
  const error = new HTTPError("Failed to create responses", upstream)
  const originalMessage = Object.getOwnPropertyDescriptor(error, "message")
  let messageReads = 0
  let statusReads = 0
  Object.defineProperty(error, "message", {
    configurable: true,
    get() {
      messageReads += 1
      return messageReads === 1 ?
          "Failed to create responses"
        : "alternating-message-private-marker"
    },
  })
  Object.defineProperty(upstream, "status", {
    configurable: true,
    get() {
      statusReads += 1
      return statusReads === 1 ? 429 : 500
    },
  })
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  try {
    const response = await forwardOpenAIError(error)

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: { message: "Upstream request failed", type: "error" },
    })
    expect(messageReads).toBe(0)
    expect(statusReads).toBe(0)
    expect(errorSpy.mock.calls).toContainEqual([
      "[429] Upstream request failed",
    ])
    expect(captureContextValue(captureException)).toMatchObject({
      tags: { status: "429" },
      extra: { status: 429 },
    })
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
    if (originalMessage)
      Object.defineProperty(error, "message", originalMessage)
  }
})

test("falls back consistently when an HTTP response is a hostile proxy", async () => {
  const privateMarker = "http-response-proxy-private-marker"
  let trapCalls = 0
  const hostileResponse = new Proxy(
    Response.json({ error: { message: privateMarker } }, { status: 429 }),
    {
      get() {
        trapCalls += 1
        throw new Error(privateMarker)
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1
        throw new Error(privateMarker)
      },
      getPrototypeOf() {
        trapCalls += 1
        throw new Error(privateMarker)
      },
    },
  )
  const error = new HTTPError(
    "Failed to create chat completions",
    hostileResponse,
  )
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  try {
    const response = await forwardOpenAIError(error)
    const body = await response.text()
    const diagnostics = JSON.stringify([
      body,
      errorSpy.mock.calls,
      captureException.mock.calls,
    ])

    expect(response.status).toBe(500)
    expect(JSON.parse(body)).toEqual({
      error: {
        message: "Failed to create chat completions",
        type: "error",
      },
    })
    expect(trapCalls).toBe(0)
    expect(errorSpy.mock.calls).toContainEqual([
      "[500] Failed to create chat completions",
    ])
    expect(captureContextValue(captureException)).toMatchObject({
      tags: { status: "500" },
      extra: { status: 500 },
    })
    expect(diagnostics).not.toContain(privateMarker)
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})

test("owns safe HTTP status and headers before awaiting the body", async () => {
  const upstream = Response.json(
    { error: { message: "unclassified" } },
    {
      status: 429,
      headers: {
        "retry-after": "17",
        "x-quota-snapshot-chat": "remaining=0;limit=100",
      },
    },
  )
  const inspectionPromise = inspectSafeHttpError(
    new HTTPError("Failed to create chat completions", upstream),
  )
  upstream.headers.set("retry-after", "99")
  upstream.headers.set("x-quota-snapshot-chat", "remaining=99;limit=100")

  const inspection = await inspectionPromise

  expect(inspection.status).toBe(429)
  expect(inspection.responseHeaders).toEqual({
    "retry-after": "17",
    "x-quota-snapshot-chat": "remaining=0;limit=100",
  })
})

test("forwards only the safe headers owned by the OpenAI inspection", async () => {
  const upstream = Response.json(
    {},
    {
      status: 429,
      headers: {
        "retry-after": "17",
        "x-quota-snapshot-chat": "remaining=0;limit=100",
        "x-private-upstream": "private-header-marker",
      },
    },
  )

  const response = await forwardOpenAIError(
    new HTTPError("Failed to create chat completions", upstream),
  )

  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("17")
  expect(response.headers.get("x-quota-snapshot-chat")).toBe(
    "remaining=0;limit=100",
  )
  expect(response.headers.get("x-private-upstream")).toBeNull()
})

test("treats a revoked HTTP error proxy as an unexpected OpenAI failure", async () => {
  const { proxy, revoke } = Proxy.revocable(
    new HTTPError(
      "Failed to create responses",
      Response.json(
        { error: { message: "revoked-error-private-marker" } },
        {
          status: 429,
        },
      ),
    ),
    {},
  )
  revoke()

  const response = await forwardOpenAIError(proxy)
  const body = await response.text()

  expect(response.status).toBe(500)
  expect(JSON.parse(body)).toEqual({
    error: {
      code: "internal_error",
      message: "Internal server error",
      type: "server_error",
    },
  })
  expect(body).not.toContain("revoked-error-private-marker")
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

test("returns and reports a fixed envelope for unexpected runtime errors", async () => {
  const privateMarker = "runtime-private-marker"
  const errorOutput: Array<unknown> = []
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )
  const app = new Hono()
  app.get("/unexpected", () => {
    throw new Error(privateMarker)
  })
  app.onError(async (error, c) => await forwardError(c, error))

  try {
    const response = await app.request("/unexpected")
    for (const call of errorSpy.mock.calls) errorOutput.push(...call)
    const body = await response.text()
    expect(response.status).toBe(500)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error",
        type: "server_error",
      },
    })
    expect(
      JSON.stringify([body, errorOutput, captureException.mock.calls]),
    ).not.toContain(privateMarker)
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})
