/* eslint-disable max-lines -- error ownership and hostile-boundary integration matrix */
import * as Sentry from "@sentry/bun"
import { expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import {
  forwardError,
  HTTPError,
  inspectHttpError,
  LocalHTTPError,
  snapshotHttpErrorMetadata,
} from "../src/lib/error"

function captureContextValue(
  captureException: ReturnType<typeof spyOn<typeof Sentry, "captureException">>,
): { extra?: Record<string, unknown> } | undefined {
  return captureException.mock.calls.at(-1)?.[1] as
    | { extra?: Record<string, unknown> }
    | undefined
}

async function forwardOpenAIError(error: unknown): Promise<Response> {
  const app = new Hono()
  app.get("/error", async (c) => await forwardError(c, error))
  return await app.request("/error")
}

const UTF8_ENCODER = new TextEncoder()

async function responseBytes(response: Response): Promise<Array<number>> {
  return Array.from(new Uint8Array(await response.arrayBuffer()))
}

test.each([
  {
    body: UTF8_ENCODER.encode('{"error":{"message":"exact-json"}}'),
    contentType: "application/json",
    name: "JSON",
  },
  {
    body: UTF8_ENCODER.encode("exact plain text"),
    contentType: "text/plain",
    name: "plain text",
  },
  {
    body: UTF8_ENCODER.encode("<html><body>exact</body></html>"),
    contentType: "text/html",
    name: "HTML",
  },
  {
    body: UTF8_ENCODER.encode("  leading\r\ntrailing  \r\n"),
    contentType: "text/plain; charset=utf-8",
    name: "whitespace and CRLF",
  },
  {
    body: Uint8Array.from([0xef, 0xbb, 0xbf, ...UTF8_ENCODER.encode("text")]),
    contentType: "text/plain",
    name: "UTF-8 BOM text",
  },
  {
    body: Uint8Array.from([0x00, 0xff, 0x80, 0x41, 0x0d, 0x0a]),
    contentType: "application/octet-stream",
    name: "binary",
  },
] as const)("forwards exact upstream $name bytes", async (fixture) => {
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  try {
    const response = await forwardOpenAIError(
      new HTTPError(
        "Failed to create responses",
        new Response(fixture.body.slice(), {
          headers: { "content-type": fixture.contentType },
          status: 502,
        }),
      ),
    )
    const expectedBytes = Array.from(fixture.body)
    const expectedBody =
      fixture.contentType === "application/octet-stream" ?
        expectedBytes
      : new TextDecoder(undefined, { ignoreBOM: true }).decode(fixture.body)
    const structuredLog: unknown = errorSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "object"
        && call[0] !== null
        && "upstreamResponseBody" in call[0],
    )?.[0]
    const captureContext = captureContextValue(captureException)

    expect(response.status).toBe(502)
    expect(response.headers.get("content-type")).toBe(fixture.contentType)
    expect(await responseBytes(response)).toEqual(expectedBytes)
    expect(structuredLog).toEqual({
      upstreamResponseBody: expectedBody,
      upstreamResponseBodyBytes: expectedBytes,
      upstreamResponseContentType: fixture.contentType,
    })
    expect(captureContext?.extra).toMatchObject({
      upstreamResponseBody: expectedBody,
      upstreamResponseBodyBytes: expectedBytes,
      upstreamResponseContentType: fixture.contentType,
    })
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})

test("forwards a non-empty upstream 402 response exactly", async () => {
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
  const body = await response.text()

  expect(response.status).toBe(402)
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(body).toBe('{"error":{"message":"interaction quota exhausted"}}')
})

test("uses a clear quota exhausted fallback for an empty upstream 402", async () => {
  const response = await forwardOpenAIError(
    new HTTPError(
      "Failed to create chat completions",
      new Response(null, { status: 402 }),
    ),
  )

  expect(response.status).toBe(402)
  expect(await response.json()).toEqual({
    error: { message: "Copilot quota exhausted", type: "error" },
  })
})

test("forwards a non-empty upstream 466 response exactly", async () => {
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
  const body = await response.text()

  expect(response.status).toBe(466)
  expect(response.headers.get("content-type")).toBe("text/plain")
  expect(body).toBe("Client version too old")
})

test("uses a clear version compatibility fallback for an empty upstream 466", async () => {
  const response = await forwardOpenAIError(
    new HTTPError(
      "Failed to create chat completions",
      new Response(null, { status: 466 }),
    ),
  )

  expect(response.status).toBe(466)
  expect(await response.json()).toEqual({
    error: { message: "Copilot client version mismatch", type: "error" },
  })
})

test("forwards raw upstream error bodies to clients", async () => {
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
  const body = await response.text()

  expect(response.status).toBe(500)
  expect(body).toBe("request_id=req_123 internal upstream failure")
})

test("returns the original serialized upstream validation body", async () => {
  const app = new Hono()
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  const upstreamBody = {
    error: {
      code: "invalid_request_body",
      message: JSON.stringify({
        code: "invalid-argument",
        error:
          "Invalid request content: A tool_choice was set on the request but no tools were specified.",
      }),
    },
  }
  app.get("/invalid-request", () => {
    throw new HTTPError(
      "Failed to create responses",
      Response.json(upstreamBody, { status: 400 }),
    )
  })
  app.onError(async (error, c) => await forwardError(c, error))

  try {
    const response = await app.request("/invalid-request")

    expect(response.status).toBe(400)
    expect(await response.text()).toBe(JSON.stringify(upstreamBody))
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

test("forwards secret-looking upstream validation reasons unchanged", async () => {
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
  expect(body).toBe(
    '{"error":{"code":"invalid_request_body","message":"Invalid authorization token Bearer private-token-value"}}',
  )
})

test("forwards unrecognized upstream validation text unchanged", async () => {
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
  expect(await response.text()).toBe(
    '{"error":{"code":"invalid_request_body","message":"Invalid value copied from user-controlled input"}}',
  )
})

test("forwards an allowlisted validation prefix with its exact suffix", async () => {
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

  expect(body).toBe(
    '{"error":{"code":"invalid_request_body","message":"Unsupported parameter: \'temperature\' is not supported with this model. diagnostics=private-suffix"}}',
  )
})

test("reports exact upstream response bodies in logs and Sentry", async () => {
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
    const response = await app.request("/private-upstream")
    const body = await response.text()
    for (const call of errorSpy.mock.calls) errorOutput.push(...call)
    const expectedBody = '{"error":{"message":"upstream-private-marker"}}'
    const expectedBytes = Array.from(UTF8_ENCODER.encode(expectedBody))
    const structuredLog = errorOutput.find(
      (value) =>
        typeof value === "object"
        && value !== null
        && "upstreamResponseBody" in value,
    )

    expect(body).toBe(expectedBody)
    expect(structuredLog).toMatchObject({
      upstreamResponseBody: expectedBody,
      upstreamResponseBodyBytes: expectedBytes,
    })
    expect(captureContextValue(captureException)?.extra).toMatchObject({
      upstreamResponseBody: expectedBody,
      upstreamResponseBodyBytes: expectedBytes,
    })
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
  const upstreamBody = {
    error: {
      code: "invalid_request_body",
      message:
        "Invalid request content: A tool_choice was set on the request but no tools were specified.",
    },
  }
  const upstream = Response.json(upstreamBody, {
    status: 400,
    headers: { "retry-after": "17" },
  })
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
    const expectedBody = JSON.stringify(upstreamBody)
    const expectedBytes = Array.from(UTF8_ENCODER.encode(expectedBody))
    const diagnostics = JSON.stringify([
      body,
      errorSpy.mock.calls,
      captureException.mock.calls,
    ])

    expect(response.status).toBe(400)
    expect(body).toBe(expectedBody)
    expect(errorSpy.mock.calls).toContainEqual([
      {
        upstreamResponseBody: expectedBody,
        upstreamResponseBodyBytes: expectedBytes,
        upstreamResponseContentType: "application/json;charset=utf-8",
      },
    ])
    expect(getterCalls).toBe(0)
    expect(errorSpy.mock.calls).toContainEqual([
      "[400] Failed to create responses",
    ])
    const context = captureContextValue(captureException)
    expect(context).toMatchObject({
      tags: { status: "400" },
      extra: {
        status: 400,
        upstreamResponseBody: expectedBody,
        upstreamResponseBodyBytes: expectedBytes,
        upstreamResponseContentType: "application/json;charset=utf-8",
        validationClass: "tool_choice_without_tools",
      },
    })
    expect(captureException.mock.calls.at(-1)?.[0]).toMatchObject({
      message: "Failed to create responses",
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
  const upstreamBody = { error: { message: "unclassified" } }
  const upstream = Response.json(upstreamBody, {
    status: 429,
  })
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
    const body = await response.text()
    const expectedBody = JSON.stringify(upstreamBody)
    const expectedBytes = Array.from(UTF8_ENCODER.encode(expectedBody))

    expect(response.status).toBe(429)
    expect(body).toBe(expectedBody)
    expect(messageReads).toBe(0)
    expect(statusReads).toBe(0)
    expect(errorSpy.mock.calls).toContainEqual([
      "[429] Failed to create responses",
    ])
    expect(captureContextValue(captureException)).toMatchObject({
      tags: { status: "429" },
      extra: {
        status: 429,
        upstreamResponseBody: expectedBody,
        upstreamResponseBodyBytes: expectedBytes,
      },
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
  const inspectionPromise = inspectHttpError(
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

test("caches one owned upstream inspection across repeated concurrent reads", async () => {
  const error = new HTTPError(
    "Failed to create responses",
    new Response("read-once-body", {
      headers: { "content-type": "text/plain" },
      status: 502,
    }),
  )

  const [first, second, third] = await Promise.all([
    inspectHttpError(error),
    inspectHttpError(error),
    inspectHttpError(error),
  ])

  expect(first).toBe(second)
  expect(second).toBe(third)
  expect(first).toMatchObject({
    kind: "upstream",
    bodyText: "read-once-body",
    contentType: "text/plain",
    status: 502,
  })
})

test.each(["replace", "delete", "getter"] as const)(
  "owns the upstream response before a later error.response %s",
  async (mutation) => {
    const originalBody = "constructor-owned-body"
    const error = new HTTPError(
      "Failed to create responses",
      new Response(originalBody, {
        headers: { "content-type": "text/plain" },
        status: 429,
      }),
    )
    let getterCalls = 0
    if (mutation === "replace") {
      error.response = new Response("replacement-body", { status: 503 })
    } else if (mutation === "delete") {
      Reflect.deleteProperty(error, "response")
    } else {
      Object.defineProperty(error, "response", {
        configurable: true,
        get() {
          getterCalls += 1
          throw new Error("response-getter-private-marker")
        },
      })
    }

    const inspection = await inspectHttpError(error)

    expect(inspection).toMatchObject({
      kind: "upstream",
      bodyText: originalBody,
      contentType: "text/plain",
      status: 429,
    })
    expect(getterCalls).toBe(0)
  },
)

test("does not invent a content type for an exact raw upstream body", async () => {
  const response = await forwardOpenAIError(
    new HTTPError(
      "Failed to create responses",
      new Response(Uint8Array.from([1, 2, 3]), { status: 502 }),
    ),
  )

  expect(response.headers.get("content-type")).toBeNull()
  expect(await responseBytes(response)).toEqual([1, 2, 3])
})

test.each(["used", "locked", "unreadable"] as const)(
  "falls back without a sentinel body for a %s native upstream response",
  async (mode) => {
    let response: Response
    let cancelBody: (() => Promise<void>) | undefined
    if (mode === "unreadable") {
      response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("unreadable-private-marker"))
          },
        }),
        { status: 502 },
      )
    } else {
      response = new Response("unavailable-private-marker", { status: 502 })
      if (mode === "used") await response.text()
      else {
        const reader = response.body?.getReader()
        if (reader) cancelBody = async () => await reader.cancel()
      }
    }

    try {
      const forwarded = await forwardOpenAIError(
        new HTTPError("Failed to create responses", response),
      )
      const body = await forwarded.text()

      expect(forwarded.status).toBe(502)
      expect(JSON.parse(body)).toEqual({
        error: { message: "Failed to create responses", type: "error" },
      })
      expect(body).not.toContain("unavailable-private-marker")
      expect(body).not.toContain("unreadable-private-marker")
      expect(body).not.toContain("unable to read")
    } finally {
      await cancelBody?.()
    }
  },
)

test("does not report body fields for an empty upstream response", async () => {
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  try {
    await forwardOpenAIError(
      new HTTPError(
        "Failed to create responses",
        new Response(null, { status: 502 }),
      ),
    )
    const diagnostics = JSON.stringify([
      errorSpy.mock.calls,
      captureException.mock.calls,
    ])

    expect(diagnostics).not.toContain("upstreamResponseBody")
    expect(captureContextValue(captureException)?.extra).toEqual({
      status: 502,
    })
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
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
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  app.get("/client-disconnect", () => {
    throw new HTTPError(
      "Failed to create chat completions",
      new Response("", { status: 499, statusText: "status code 499" }),
    )
  })

  app.onError(async (error, c) => {
    return await forwardError(c, error)
  })

  try {
    const response = await app.request("/client-disconnect")
    const body = await response.text()

    expect(response.status).toBe(499)
    expect(body).toBe("")
    expect(errorSpy).not.toHaveBeenCalled()
    expect(captureException).not.toHaveBeenCalled()
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
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

test.each(["replace", "delete"] as const)(
  "owns local HTTP status before a later response %s",
  async (mutation) => {
    const clientBody = {
      error: {
        code: "invalid_value",
        message: "The model field must be a non-empty string.",
        param: "model",
        type: "invalid_request_error",
      },
    }
    const error = new LocalHTTPError(
      clientBody.error.message,
      Response.json(clientBody, { status: 400 }),
      clientBody,
    )
    if (mutation === "replace") {
      error.response = Response.json(
        { error: { message: "replacement-response-private-marker" } },
        { status: 503 },
      )
    } else {
      Reflect.deleteProperty(error, "response")
    }

    const inspection = await inspectHttpError(error)

    expect(inspection.status).toBe(400)
    expect(inspection.safeMessage).toBe(clientBody.error.message)
    expect(inspection.localError).toEqual(clientBody.error)
  },
)

test("never reads a redefined local HTTP response", () => {
  const clientBody = {
    error: {
      code: "invalid_value",
      message: "The model field must be a non-empty string.",
      param: "model",
      type: "invalid_request_error",
    },
  }
  const error = new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
  let getterCalls = 0
  Object.defineProperty(error, "response", {
    configurable: true,
    get() {
      getterCalls += 1
      throw new Error("local-response-getter-private-marker")
    },
  })

  const inspection = snapshotHttpErrorMetadata(error)

  expect(inspection.status).toBe(400)
  expect(inspection.safeMessage).toBe(clientBody.error.message)
  expect(getterCalls).toBe(0)
})

test("owns safe local HTTP headers before response replacement", async () => {
  const clientBody = {
    error: {
      code: "invalid_value",
      message: "The model field must be a non-empty string.",
      param: "model",
      type: "invalid_request_error",
    },
  }
  const error = new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, {
      headers: { "retry-after": "17" },
      status: 400,
    }),
    clientBody,
  )
  error.response = Response.json(
    { error: { message: "replacement-response-private-marker" } },
    { headers: { "retry-after": "99" }, status: 503 },
  )

  const inspection = await inspectHttpError(error)

  expect(inspection.status).toBe(400)
  expect(inspection.responseHeaders).toEqual({ "retry-after": "17" })
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
