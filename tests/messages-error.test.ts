import * as Sentry from "@sentry/bun"
import { expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import { HTTPError, LocalHTTPError } from "~/lib/error"
import {
  createAnthropicStreamError,
  forwardMessagesError,
} from "~/routes/messages/error"

const app = new Hono()
const UTF8_ENCODER = new TextEncoder()

async function responseBytes(response: Response): Promise<Array<number>> {
  return Array.from(new Uint8Array(await response.arrayBuffer()))
}

async function forwardAnthropicError(
  error: unknown,
  requestId = "req-hostile",
): Promise<Response> {
  const route = new Hono()
  route.get("/error", async (c) => await forwardMessagesError(c, error))
  return await route.request("/error", {
    headers: { "x-request-id": requestId },
  })
}

function localError(clientBody: unknown, status = 400): LocalHTTPError {
  return new LocalHTTPError(
    "local-safe-message",
    Response.json({}, { status }),
    clientBody as Record<string, unknown>,
  )
}

function fixedInvalidRequestBody(requestId = "req-hostile") {
  return {
    type: "error",
    request_id: requestId,
    error: {
      type: "invalid_request_error",
      message: "The Copilot Messages request was rejected.",
    },
  }
}

app.get("/error", async (c) => {
  const kind = c.req.query("kind")
  if (kind === "local") {
    const body = {
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "invalid_value",
        message: "max_tokens is required for Messages requests.",
        param: "max_tokens",
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
      new Response(null, {
        status: Number(kind),
        statusText: "private-status-marker",
      }),
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
      code: "invalid_value",
      message: "max_tokens is required for Messages requests.",
      param: "max_tokens",
    },
  })
})

test("preserves safe local code and param with a fixed HTTP message", async () => {
  const response = await forwardAnthropicError(
    localError({
      error: {
        type: "invalid_request_error",
        code: "endpoint_translation_unsupported",
        message:
          "The selected Copilot model cannot accept this request without losing required protocol data.",
        param: "document.citations",
      },
    }),
  )
  const body = await response.text()

  expect(JSON.parse(body)).toEqual({
    type: "error",
    request_id: "req-hostile",
    error: {
      type: "invalid_request_error",
      code: "endpoint_translation_unsupported",
      message: "The Copilot Messages request was rejected.",
      param: "document.citations",
    },
  })
  expect(body).not.toContain("document contents")
})

test("preserves the same safe local metadata in an in-band error", () => {
  expect(
    createAnthropicStreamError(
      localError({
        error: {
          type: "invalid_request_error",
          code: "endpoint_translation_unsupported",
          message:
            "The selected Copilot model cannot accept this request without losing required protocol data.",
          param: "thinking_signature",
        },
      }),
    ),
  ).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "endpoint_translation_unsupported",
      message: "The Copilot Messages request was rejected.",
      param: "thinking_signature",
    },
  })
})

test("keeps concept-only translation metadata out of HTTP, SSE, logs, and Sentry", async () => {
  const marker = "PRIVATE_TRANSLATION_EXTENSION_KEY"
  const error = localError({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "endpoint_translation_unsupported",
      message:
        "The selected Copilot model cannot accept this request without losing required protocol data.",
      param: "content_extension",
    },
  })
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  try {
    const response = await forwardAnthropicError(error)
    const httpBody = await response.text()
    const streamBody = JSON.stringify(createAnthropicStreamError(error))
    const output = JSON.stringify([
      httpBody,
      streamBody,
      errorSpy.mock.calls,
      captureException.mock.calls,
    ])

    expect(JSON.parse(httpBody)).toMatchObject({
      error: { param: "content_extension" },
    })
    expect(JSON.parse(streamBody)).toMatchObject({
      error: { param: "content_extension" },
    })
    expect(output).not.toContain(marker)
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
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

test.each([
  {
    body: UTF8_ENCODER.encode('{"error":{"message":"exact-json"}}'),
    contentType: "application/json",
    name: "JSON",
  },
  {
    body: UTF8_ENCODER.encode("exact text"),
    contentType: "text/plain",
    name: "text",
  },
  {
    body: UTF8_ENCODER.encode("  <html>exact</html>\r\n"),
    contentType: "text/html",
    name: "HTML and whitespace",
  },
  {
    body: Uint8Array.from([0x00, 0xff, 0x80, 0x41]),
    contentType: "application/octet-stream",
    name: "binary",
  },
] as const)(
  "forwards exact upstream $name bytes instead of an Anthropic envelope",
  async (fixture) => {
    const response = await forwardAnthropicError(
      new HTTPError(
        "Failed to create responses",
        new Response(fixture.body.slice(), {
          headers: {
            "content-type": fixture.contentType,
            "retry-after": "17",
            "x-private-upstream": "private-header-marker",
          },
          status: 429,
        }),
      ),
      "req-must-not-be-injected",
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("content-type")).toBe(fixture.contentType)
    expect(response.headers.get("retry-after")).toBe("17")
    expect(response.headers.get("x-private-upstream")).toBeNull()
    expect(await responseBytes(response)).toEqual(Array.from(fixture.body))
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

test("uses one guarded HTTP snapshot for Messages output logs and Sentry", async () => {
  const privateMarkers = [
    "messages-message-getter-private-marker",
    "messages-status-getter-private-marker",
    "messages-headers-getter-private-marker",
    "messages-body-getter-private-marker",
  ]
  let getterCalls = 0
  const upstreamBody = { error: { message: "messages-body-private-marker" } }
  const upstream = Response.json(upstreamBody, {
    status: 429,
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
    const response = await forwardAnthropicError(error, "req-snapshot")
    const body = await response.text()
    const expectedBody = JSON.stringify(upstreamBody)
    const expectedBytes = Array.from(UTF8_ENCODER.encode(expectedBody))
    const diagnostics = JSON.stringify([
      body,
      errorSpy.mock.calls,
      captureException.mock.calls,
    ])

    expect(response.status).toBe(429)
    expect(body).toBe(expectedBody)
    expect(getterCalls).toBe(0)
    expect(errorSpy.mock.calls).toContainEqual([
      "[429] Failed to create responses",
    ])
    expect(captureException.mock.calls.at(-1)?.[0]).toMatchObject({
      message: "Failed to create responses",
    })
    expect(captureException.mock.calls.at(-1)?.[1]).toMatchObject({
      tags: { status: "429" },
      extra: {
        status: 429,
        upstreamResponseBody: expectedBody,
        upstreamResponseBodyBytes: expectedBytes,
      },
    })
    expect(errorSpy.mock.calls).toContainEqual([
      {
        upstreamResponseBody: expectedBody,
        upstreamResponseBodyBytes: expectedBytes,
        upstreamResponseContentType: "application/json;charset=utf-8",
      },
    ])
    for (const marker of privateMarkers) {
      expect(diagnostics).not.toContain(marker)
    }
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})

test("forwards only the safe headers owned by the Messages inspection", async () => {
  const response = await forwardAnthropicError(
    new HTTPError(
      "Failed to create responses",
      Response.json(
        {},
        {
          status: 429,
          headers: {
            "retry-after": "17",
            "x-quota-snapshot-chat": "remaining=0;limit=100",
            "x-private-upstream": "private-header-marker",
          },
        },
      ),
    ),
  )

  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("17")
  expect(response.headers.get("x-quota-snapshot-chat")).toBe(
    "remaining=0;limit=100",
  )
  expect(response.headers.get("x-private-upstream")).toBeNull()
})

test("preserves an Anthropic-shaped body exactly on a non-local HTTP error", async () => {
  const upstreamBody = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "upstream-anthropic-body",
    },
  }
  const error = new HTTPError(
    "Failed to create responses",
    Response.json(upstreamBody, { status: 400 }),
  ) as HTTPError & { clientBody?: unknown }
  error.clientBody = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "forged-local-private-marker",
    },
  }

  const response = await forwardAnthropicError(error)
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(body).toBe(JSON.stringify(upstreamBody))
  expect(body).not.toContain("forged-local-private-marker")
})

test("returns an empty unreported Messages response for upstream 499", async () => {
  const errorSpy = spyOn(consola, "error")
  const captureException = spyOn(Sentry, "captureException").mockImplementation(
    () => "event-id",
  )

  try {
    const response = await forwardAnthropicError(
      new HTTPError(
        "Failed to create responses",
        new Response("must-not-forward", { status: 499 }),
      ),
    )

    expect(response.status).toBe(499)
    expect(await response.text()).toBe("")
    expect(errorSpy).not.toHaveBeenCalled()
    expect(captureException).not.toHaveBeenCalled()
  } finally {
    errorSpy.mockRestore()
    captureException.mockRestore()
  }
})

test("adapts a hostile local Anthropic getter without invoking it", async () => {
  const privateMarker = "local-anthropic-getter-private-marker"
  let getterCalls = 0
  const errorBody = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error(privateMarker)
    },
  })
  const response = await forwardAnthropicError(
    localError({ type: "error", error: errorBody }),
  )
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(JSON.parse(body)).toEqual(fixedInvalidRequestBody())
  expect(getterCalls).toBe(0)
  expect(body).not.toContain(privateMarker)
})

test.each([
  ["array", ["error"]],
  [
    "class",
    new (class LocalAnthropicBody {
      type = "error"
      error = { type: "invalid_request_error", message: "class-private" }
    })(),
  ],
  ["missing type", { type: "error", error: { message: "missing-private" } }],
  [
    "non-string message",
    { type: "error", error: { type: "invalid_request_error", message: 42 } },
  ],
  [
    "unknown extras",
    {
      type: "error",
      error: { type: "invalid_request_error", message: "extra-private" },
      future_private_field: true,
    },
  ],
] as const)(
  "adapts a non-exact local Anthropic %s body",
  async (_name, body) => {
    const response = await forwardAnthropicError(localError(body))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(fixedInvalidRequestBody())
  },
)

test("adapts a revoked local Anthropic proxy without reflection", async () => {
  const privateMarker = "local-anthropic-revoked-private-marker"
  const { proxy, revoke } = Proxy.revocable(
    {
      type: "error",
      error: { type: "invalid_request_error", message: privateMarker },
    },
    {},
  )
  revoke()

  const response = await forwardAnthropicError(localError(proxy))
  const body = await response.text()

  expect(response.status).toBe(400)
  expect(JSON.parse(body)).toEqual(fixedInvalidRequestBody())
  expect(body).not.toContain(privateMarker)
})

test("snapshots a valid local Anthropic body before later mutation", async () => {
  const body = {
    type: "error",
    request_id: "local-request-id",
    error: {
      type: "invalid_request_error",
      message: "original local message",
    },
  }
  const responsePromise = forwardAnthropicError(localError(body))
  body.request_id = "mutated-request-id"
  body.error.message = "mutated-private-marker"

  const response = await responsePromise
  const responseBody = await response.text()

  expect(response.status).toBe(400)
  expect(JSON.parse(responseBody)).toEqual({
    type: "error",
    request_id: "local-request-id",
    error: {
      type: "invalid_request_error",
      message: "original local message",
    },
  })
  expect(responseBody).not.toContain("mutated-private-marker")
})

test("creates a detached in-band local Anthropic error snapshot", () => {
  const body = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "original stream message",
    },
  }
  const event = createAnthropicStreamError(localError(body))
  body.error.message = "mutated-stream-private-marker"

  expect(event).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "original stream message",
    },
  })
  expect(JSON.stringify(event)).not.toContain("mutated-stream-private-marker")
})

test("creates a fixed in-band event for a hostile local body", () => {
  let getterCalls = 0
  const body = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("stream-local-getter-private-marker")
    },
  })

  expect(createAnthropicStreamError(localError(body))).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "The Copilot Messages request was rejected.",
    },
  })
  expect(getterCalls).toBe(0)
})

test("creates a fixed in-band event for a revoked local proxy", () => {
  const { proxy, revoke } = Proxy.revocable(
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "revoked-stream-private-marker",
      },
    },
    {},
  )
  revoke()

  expect(createAnthropicStreamError(localError(proxy))).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "The Copilot Messages request was rejected.",
    },
  })
})

test.each([
  ["array", ["error"]],
  [
    "class",
    new (class LocalAnthropicStreamBody {
      type = "error"
      error = {
        type: "invalid_request_error",
        message: "stream-class-private-marker",
      }
    })(),
  ],
] as const)(
  "creates a fixed in-band event for a local %s body",
  (_name, body) => {
    expect(createAnthropicStreamError(localError(body))).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "The Copilot Messages request was rejected.",
      },
    })
  },
)

test("treats a revoked HTTP error proxy as an unexpected Messages failure", async () => {
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

  const response = await forwardAnthropicError(proxy)
  const body = await response.text()

  expect(response.status).toBe(500)
  expect(JSON.parse(body)).toEqual({
    type: "error",
    request_id: "req-hostile",
    error: {
      type: "api_error",
      message: "The Copilot Messages request failed.",
    },
  })
  expect(body).not.toContain("revoked-error-private-marker")
})

test("creates a fixed in-band event for a revoked HTTP error proxy", () => {
  const { proxy, revoke } = Proxy.revocable(
    new HTTPError(
      "Failed to create responses",
      Response.json({}, { status: 429 }),
    ),
    {},
  )
  revoke()

  expect(createAnthropicStreamError(proxy)).toEqual({
    type: "error",
    error: {
      type: "api_error",
      message: "The Copilot Messages request failed.",
    },
  })
})

test.each(["__proto__", "constructor", "prototype"] as const)(
  "rejects a local Anthropic JSON %s extra without prototype pollution",
  async (key) => {
    const body = JSON.parse(
      `{"type":"error","error":{"type":"invalid_request_error","message":"safe"},"${key}":{"polluted":"dangerous-key-marker"}}`,
    ) as Record<string, unknown>
    const response = await forwardAnthropicError(localError(body))
    const responseBody = await response.text()

    expect(response.status).toBe(400)
    expect(JSON.parse(responseBody)).toEqual(fixedInvalidRequestBody())
    expect(responseBody).not.toContain("dangerous-key-marker")
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  },
)

test.each(["__proto__", "constructor", "prototype"] as const)(
  "rejects an in-band local Anthropic JSON %s extra without pollution",
  (key) => {
    const body = JSON.parse(
      `{"type":"error","error":{"type":"invalid_request_error","message":"safe"},"${key}":{"polluted":"dangerous-stream-marker"}}`,
    ) as Record<string, unknown>
    const event = createAnthropicStreamError(localError(body))

    expect(event).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "The Copilot Messages request was rejected.",
      },
    })
    expect(JSON.stringify(event)).not.toContain("dangerous-stream-marker")
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  },
)

test.each([
  ["max plus one", 2049],
  ["uint32 max", 0xffff_ffff],
] as const)(
  "rejects a local Anthropic %s array before allocation",
  async (_name, length) => {
    const array: Array<unknown> = []
    Object.defineProperty(array, "length", { value: length })

    const response = await forwardAnthropicError(localError(array))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(fixedInvalidRequestBody())
  },
)

test("rejects sparse and accessor local Anthropic arrays", async () => {
  let getterCalls = 0
  const sparse: Array<unknown> = []
  Object.defineProperty(sparse, "length", { value: 8 })
  const accessor: Array<unknown> = []
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("array-accessor-private-marker")
    },
  })

  for (const body of [sparse, accessor]) {
    const response = await forwardAnthropicError(localError(body))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(fixedInvalidRequestBody())
  }
  expect(getterCalls).toBe(0)
})

test("rejects oversized and proxied local arrays in-band", () => {
  const oversized: Array<unknown> = []
  Object.defineProperty(oversized, "length", { value: 0xffff_ffff })
  let trapCalls = 0
  const proxied = new Proxy([], {
    getOwnPropertyDescriptor() {
      trapCalls += 1
      throw new Error("array-proxy-private-marker")
    },
  })

  for (const body of [oversized, proxied]) {
    expect(createAnthropicStreamError(localError(body))).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "The Copilot Messages request was rejected.",
      },
    })
  }
  expect(trapCalls).toBe(0)
})
