import { expect, test } from "bun:test"

import { createSentryInitOptions } from "../src/lib/sentry"

const FILTERED_VALUE = "[Filtered]"
const SAFE_HEADER_VALUE = "safe-visible-value"
const SENSITIVE_HEADERS = [
  "Copilot-Session-Token",
  "Anthropic-Beta",
  "anthropic-version",
  "X-Model-Provider-Preference",
  "Authorization",
  "Proxy-Authorization",
  "X-Api-Key",
  "X-Goog-Api-Key",
  "Cookie",
  "Set-Cookie",
  "X-Client-Session-Id",
  "X-Interaction-Id",
  "X-Agent-Task-Id",
  "X-Parent-Agent-Id",
] as const

type SendHook = (
  value: Record<string, unknown>,
) => Record<string, unknown> | null

function sendHooks(): Array<[string, SendHook]> {
  const options = createSentryInitOptions(
    "https://public@example.ingest.sentry.io/1",
  )
  return [
    ["beforeSend", options.beforeSend as unknown as SendHook],
    [
      "beforeSendTransaction",
      options.beforeSendTransaction as unknown as SendHook,
    ],
    ["beforeSendSpan", options.beforeSendSpan as unknown as SendHook],
    ["beforeSendLog", options.beforeSendLog as unknown as SendHook],
  ]
}

function realHeadersRecord(prefix: string): Record<string, string> {
  return Object.fromEntries(
    new Headers({
      "Copilot-Session-Token": `${prefix}-session-private`,
      "Anthropic-Beta": `${prefix}-beta-private`,
      Authorization: `${prefix}-authorization-private`,
      "X-Safe-Header": SAFE_HEADER_VALUE,
    }).entries(),
  )
}

function sensitiveRecord(prefix: string): Record<string, string> {
  return Object.fromEntries(
    SENSITIVE_HEADERS.map((name, index) => [
      index % 2 === 0 ? name.toUpperCase() : name.toLowerCase(),
      `${prefix}-${index}-private`,
    ]),
  )
}

function makePayload(prefix: string): Record<string, unknown> {
  const topLevel = sensitiveRecord(`${prefix}-top`)
  const nested = sensitiveRecord(`${prefix}-nested`)
  const requestHeaders = sensitiveRecord(`${prefix}-request-headers`)
  const dottedHeaders = sensitiveRecord(`${prefix}-dotted`)
  const tuples = Object.entries(sensitiveRecord(`${prefix}-tuple`))

  return {
    request: {
      headers: { ...topLevel, "X-Safe-Header": SAFE_HEADER_VALUE },
      method: "POST",
      url: "https://gateway.example/v1/responses?visible=1",
    },
    contexts: {
      trace: {
        data: {
          headers: nested,
          request_headers: requestHeaders,
          "http.request.header": dottedHeaders,
          "http.request.header.authorization": `${prefix}-semantic-private`,
          "http.request.header.x-safe-header": SAFE_HEADER_VALUE,
          headerTuples: [...tuples, ["X-Safe-Header", SAFE_HEADER_VALUE]],
        },
      },
    },
    extra: {
      deeply: {
        nested: {
          headers: {
            ...sensitiveRecord(`${prefix}-deep`),
            "X-Safe-Header": SAFE_HEADER_VALUE,
          },
          headersLikeRecord: {
            headers: realHeadersRecord(`${prefix}-headers-like`),
          },
        },
      },
    },
    safeOrdinaryData: `${prefix}-ordinary-private`,
    status: 418,
  }
}

test("every Sentry send hook scrubs sensitive values from nested header shapes", () => {
  for (const [name, hook] of sendHooks()) {
    const prefix = `sentry-${name}`
    const payload = makePayload(prefix)

    expect(hook(payload)).toBe(payload)

    const serialized = JSON.stringify(payload)
    for (let index = 0; index < SENSITIVE_HEADERS.length; index += 1) {
      for (const location of [
        "top",
        "nested",
        "request-headers",
        "dotted",
        "tuple",
        "deep",
        "headers-like",
      ]) {
        expect(serialized).not.toContain(
          `${prefix}-${location}-${index}-private`,
        )
      }
    }
    expect(serialized).not.toContain(`${prefix}-semantic-private`)
    expect(serialized).toContain(FILTERED_VALUE)
    expect(serialized).toContain(SAFE_HEADER_VALUE)
    expect(payload.safeOrdinaryData).toBe(`${prefix}-ordinary-private`)
    expect(payload.status).toBe(418)
    expect((payload.request as { method: string; url: string }).method).toBe(
      "POST",
    )
    expect((payload.request as { method: string; url: string }).url).toBe(
      "https://gateway.example/v1/responses?visible=1",
    )
  }
})

test("Sentry header scrubbing handles cycles and never invokes hostile accessors", () => {
  for (const [, hook] of sendHooks()) {
    let getterCalls = 0
    const hostilePrototype = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostilePrototype, "headers", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error("hostile inherited getter")
      },
    })
    const payload = Object.create(hostilePrototype) as Record<string, unknown>
    Object.defineProperty(payload, "safe", {
      configurable: true,
      enumerable: true,
      value: SAFE_HEADER_VALUE,
      writable: true,
    })
    Object.defineProperty(payload, "hostile", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error("hostile own getter")
      },
    })
    payload.nested = {
      headers: {
        "Copilot-Session-Token": "cycle-session-private",
      },
    }
    payload.self = payload

    expect(() => hook(payload)).not.toThrow()
    expect(getterCalls).toBe(0)
    expect(
      (payload.nested as { headers: Record<string, string> }).headers[
        "Copilot-Session-Token"
      ],
    ).toBe(FILTERED_VALUE)
    expect(payload.safe).toBe(SAFE_HEADER_VALUE)
    expect(payload.self).toBe(payload)
  }
})

test("Sentry header scrubbing does not invoke Headers-like methods", () => {
  for (const [, hook] of sendHooks()) {
    let methodCalls = 0
    const headersLike = Object.create(null) as Record<string, unknown>
    Object.defineProperties(headersLike, {
      entries: {
        enumerable: false,
        value() {
          methodCalls += 1
          throw new Error("hostile entries method")
        },
      },
      get: {
        enumerable: false,
        value() {
          methodCalls += 1
          throw new Error("hostile get method")
        },
      },
    })
    const payload = { headers: headersLike, safe: SAFE_HEADER_VALUE }

    expect(() => hook(payload)).not.toThrow()
    expect(methodCalls).toBe(0)
    expect(payload.safe).toBe(SAFE_HEADER_VALUE)
  }
})

test("Sentry header scrubbing is bounded on pathologically deep telemetry", () => {
  for (const [, hook] of sendHooks()) {
    const payload: Record<string, unknown> = {}
    let cursor = payload
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    cursor.headers = {
      "Copilot-Session-Token": "too-deep-private-token",
    }

    expect(() => hook(payload)).not.toThrow()
  }
})

test("nested header scrubbing composes with Google request diagnostics", () => {
  for (const [, hook] of sendHooks()) {
    const model = "private-google-model"
    const action = "private-google-action"
    const payload = {
      request: {
        headers: {
          "Copilot-Session-Token": "private-google-session-token",
          "X-Safe-Header": SAFE_HEADER_VALUE,
        },
        method: "POST",
        url: `https://gateway.example/v1beta/models/${model}:${action}?api_key=private-google-key&alt=sse`,
      },
      contexts: {
        response: { status_code: 404 },
        trace: {
          data: {
            headers: {
              "Anthropic-Beta": "private-google-beta",
            },
            "http.request.method": "POST",
            "http.route": `/v1beta/models/${model}:${action}`,
          },
        },
      },
    }

    hook(payload)

    const serialized = JSON.stringify(payload)
    for (const secret of [
      model,
      action,
      "private-google-key",
      "private-google-session-token",
      "private-google-beta",
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).toContain("/v1beta/models/:modelAction")
    expect(serialized).toContain("POST")
    expect(serialized).toContain("404")
    expect(serialized).toContain("alt=sse")
    expect(serialized).toContain(SAFE_HEADER_VALUE)
  }
})
