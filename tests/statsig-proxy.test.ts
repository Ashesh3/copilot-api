import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import consola from "consola"
import { gzipSync } from "fflate"
import { Hono } from "hono"

import type { StatsigProxyDependencies } from "~/routes/statsig-overrides/proxy"
import type { StatsigOverrides } from "~/routes/statsig-overrides/store"

import { setIpAllowlistForTest } from "~/lib/ip-allowlist"
import { unwhitelistIp } from "~/lib/ip-blocker"
import { state } from "~/lib/state"
import { createStatsigProxyMiddleware } from "~/routes/statsig-overrides/proxy"
import { server } from "~/server"

const TEST_IPS = [
  "198.51.100.30",
  "198.51.100.31",
  "198.51.100.32",
  "198.51.100.33",
  "198.51.100.34",
  "198.51.100.35",
  "198.51.100.36",
  "198.51.100.37",
  "198.51.100.38",
  "198.51.100.39",
] as const

const originalApiKeyAuth = state.apiKeyAuth
const originalDebug = state.debug
const originalFetch = globalThis.fetch
const originalConsoleLog = console.log
const originalConsolaError = consola.error

const consoleLogMock = mock(() => {})
const consolaErrorMock = mock(() => {})
const globalFetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit) =>
    new Response("global fetch response", { status: 202 }),
)

function createEmptyOverrides(): StatsigOverrides {
  return {
    featureGates: {},
    dynamicConfigs: {},
  }
}

function allowManagedIp(ip: string): void {
  setIpAllowlistForTest([
    {
      ip,
      enabled: true,
      source: "manual",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    },
  ])
}

function createTestApp(dependencies: StatsigProxyDependencies = {}): Hono {
  const app = new Hono()
  app.use("*", createStatsigProxyMiddleware(dependencies))
  app.all("*", (c) => {
    c.header("x-downstream", "true")
    return c.text("downstream")
  })
  return app
}

function encodeInitializeBody(
  payload: unknown,
  options: { encoded?: boolean; gzipped?: boolean } = {},
): Uint8Array {
  let bodyText = JSON.stringify(payload)

  if (options.encoded) {
    bodyText = Buffer.from(bodyText, "utf8")
      .toString("base64")
      .split("")
      .reverse()
      .join("")
  }

  const bodyBytes = Buffer.from(bodyText, "utf8")
  return options.gzipped ? gzipSync(bodyBytes) : bodyBytes
}

function createInitializeResponseFixture() {
  return {
    has_updates: true as const,
    response_format: "init-v1",
    feature_gates: {
      existing_gate: {
        name: "existing_gate",
        value: false,
        rule_id: "upstream-gate-rule",
        exposures: [{ gate: "gate-exposure" }],
        version: 7,
      },
    },
    dynamic_configs: {
      existing_config: {
        name: "existing_config",
        value: {
          rollout: 10,
          nested: { enabled: false },
        },
        rule_id: "upstream-config-rule",
        exposures: [{ gate: "config-exposure" }],
        version: 9,
      },
    },
    user: { userID: "user-123" },
  }
}

function getFetchUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.href
  return url.url
}

function getHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers)
}

async function getBodyText(
  body: Exclude<RequestInit["body"], null | undefined>,
): Promise<string> {
  return await new Response(body).text()
}

beforeEach(() => {
  state.apiKeyAuth = undefined
  state.debug = false
  setIpAllowlistForTest([])
  globalFetchMock.mockClear()
  consoleLogMock.mockClear()
  consolaErrorMock.mockClear()
  console.log = consoleLogMock
  consola.error = consolaErrorMock as unknown as typeof consola.error
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    globalFetchMock as unknown as typeof fetch

  for (const ip of TEST_IPS) {
    unwhitelistIp(ip)
  }
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  state.debug = originalDebug
  console.log = originalConsoleLog
  consola.error = originalConsolaError
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("ignores other hosts and calls downstream", async () => {
  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  const response = await app.request(
    "http://localhost/v1/initialize?k=secret",
    {
      method: "POST",
      headers: {
        host: "example.com",
        "x-forwarded-for": TEST_IPS[0],
      },
      body: JSON.stringify({ user: { userID: "user-123" } }),
    },
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("x-downstream")).toBe("true")
  expect(await response.text()).toBe("downstream")
  expect(fetchMock).not.toHaveBeenCalled()
})

test("returns 404 without fetching for non-allowlisted Statsig clients", async () => {
  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  const response = await app.request("http://localhost/v1/download?k=secret", {
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": TEST_IPS[1],
    },
  })

  expect(response.status).toBe(404)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("normalizes host case and port and proxies raw non-initialize requests", async () => {
  allowManagedIp(TEST_IPS[2])

  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("raw-upstream-body", {
        status: 207,
        headers: {
          "content-type": "application/octet-stream",
          "x-upstream": "statsig",
        },
      }),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  const response = await app.request("http://localhost/v1/check?k=client-key", {
    method: "POST",
    headers: {
      host: "AB.ChatGPT.com:443",
      "content-length": "999",
      "content-type": "application/octet-stream",
      "x-forwarded-for": TEST_IPS[2],
    },
    body: "client payload",
  })

  const [upstreamUrl, requestInit] = fetchMock.mock.calls[0] ?? []
  const upstreamHeaders = getHeaders(requestInit)

  expect(response.status).toBe(207)
  expect(response.headers.get("content-type")).toBe("application/octet-stream")
  expect(response.headers.get("x-upstream")).toBe("statsig")
  expect(await response.text()).toBe("raw-upstream-body")
  expect(new URL(getFetchUrl(upstreamUrl)).host).toBe("ab.chatgpt.com")
  expect(new URL(getFetchUrl(upstreamUrl)).pathname).toBe("/v1/check")
  expect(new URL(getFetchUrl(upstreamUrl)).search).toBe("?k=client-key")
  expect(requestInit?.method).toBe("POST")
  expect(requestInit?.redirect).toBe("manual")
  expect(upstreamHeaders.get("accept-encoding")).toBe("identity")
  expect(upstreamHeaders.has("host")).toBe(false)
  expect(upstreamHeaders.has("content-length")).toBe(false)
  expect(
    await getBodyText(
      requestInit?.body as Exclude<RequestInit["body"], null | undefined>,
    ),
  ).toBe("client payload")
})

test("keeps protocol-relative paths on the fixed Statsig origin", async () => {
  allowManagedIp(TEST_IPS[3])

  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  await app.request("http://localhost//evil.example/v1/initialize?foo=bar", {
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": TEST_IPS[3],
    },
  })

  const upstreamUrl = new URL(getFetchUrl(fetchMock.mock.calls[0]?.[0]))

  expect(upstreamUrl.host).toBe("ab.chatgpt.com")
  expect(upstreamUrl.pathname).toBe("//evil.example/v1/initialize")
  expect(upstreamUrl.search).toBe("?foo=bar")
})

test("normalizes encoded initialize requests, strips se and gz, and overlays overrides", async () => {
  allowManagedIp(TEST_IPS[4])

  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(createInitializeResponseFixture()), {
        status: 200,
        headers: {
          "content-encoding": "gzip",
          "content-length": "123",
          "content-md5": "abc123",
          "content-type": "application/json",
          "x-upstream": "statsig",
        },
      }),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: () => ({
      featureGates: {
        existing_gate: true,
        missing_gate: false,
      },
      dynamicConfigs: {
        existing_config: {
          rollout: 100,
          nested: { enabled: true },
        },
        missing_config: {
          cohort: "beta",
        },
      },
    }),
  })

  const response = await app.request(
    "http://localhost/v1/initialize?se=1&gz=1&k=client-secret&foo=bar",
    {
      method: "POST",
      headers: {
        host: "ab.chatgpt.com",
        "content-encoding": "gzip",
        "content-length": "999",
        "content-type": "application/octet-stream",
        "x-forwarded-for": TEST_IPS[4],
      },
      body: encodeInitializeBody(
        {
          user: { userID: "user-123", email: "user@example.com" },
          statsigMetadata: { stableID: "stable-123", sdkType: "js-client" },
          sinceTime: 987,
          partialUserMatchSinceTime: 654,
          deltasResponseRequested: true,
          full_checksum: "checksum",
          previousDerivedFields: { feature_gates: { gate: true } },
          hash_used: "djb2",
          customField: { keep: "me" },
        },
        { encoded: true, gzipped: true },
      ),
    },
  )

  const [upstreamUrl, requestInit] = fetchMock.mock.calls[0] ?? []
  const upstreamRequestUrl = new URL(getFetchUrl(upstreamUrl))
  const upstreamHeaders = getHeaders(requestInit)
  expect(typeof requestInit?.body).toBe("string")
  if (typeof requestInit?.body !== "string") {
    expect.unreachable("Expected initialize upstream body to be a JSON string")
  }
  const upstreamBody = JSON.parse(requestInit.body) as Record<string, unknown>
  const responseBody = await response.json()

  expect(upstreamRequestUrl.search).toBe("?k=client-secret&foo=bar")
  expect(upstreamHeaders.get("accept-encoding")).toBe("identity")
  expect(upstreamHeaders.get("content-type")).toBe("application/json")
  expect(upstreamHeaders.has("content-encoding")).toBe(false)
  expect(upstreamHeaders.has("content-length")).toBe(false)
  expect(upstreamHeaders.has("host")).toBe(false)
  expect(requestInit.redirect).toBe("manual")
  expect(upstreamBody).toEqual({
    user: { userID: "user-123", email: "user@example.com" },
    statsigMetadata: { stableID: "stable-123", sdkType: "js-client" },
    sinceTime: 0,
    partialUserMatchSinceTime: 0,
    deltasResponseRequested: false,
    full_checksum: null,
    previousDerivedFields: {},
    hash_used: "djb2",
    customField: { keep: "me" },
  })
  expect(response.status).toBe(200)
  expect(response.headers.get("content-encoding")).toBeNull()
  expect(response.headers.get("content-length")).toBeNull()
  expect(response.headers.get("content-md5")).toBeNull()
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(response.headers.get("x-upstream")).toBe("statsig")
  expect(responseBody).toEqual({
    has_updates: true,
    response_format: "init-v1",
    feature_gates: {
      existing_gate: {
        name: "existing_gate",
        value: true,
        rule_id: "upstream-gate-rule",
        exposures: [{ gate: "gate-exposure" }],
        version: 7,
      },
      missing_gate: {
        name: "missing_gate",
        value: false,
        rule_id: "copilot-api-override",
        secondary_exposures: [],
      },
    },
    dynamic_configs: {
      existing_config: {
        name: "existing_config",
        value: {
          rollout: 100,
          nested: { enabled: true },
        },
        rule_id: "upstream-config-rule",
        exposures: [{ gate: "config-exposure" }],
        version: 9,
      },
      missing_config: {
        name: "missing_config",
        value: {
          cohort: "beta",
        },
        rule_id: "copilot-api-override",
        secondary_exposures: [],
      },
    },
    user: { userID: "user-123" },
  })
})

test("returns 400 without fetching when the initialize request body is invalid", async () => {
  allowManagedIp(TEST_IPS[5])

  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  const response = await app.request("http://localhost/v1/initialize?se=1", {
    method: "POST",
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": TEST_IPS[5],
    },
    body: "=03e!",
  })

  expect(response.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("returns 502 with safe logs when the upstream fetch fails", async () => {
  allowManagedIp(TEST_IPS[6])

  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) => {
      throw new TypeError("upstream exploded with k=client-secret")
    },
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  const response = await app.request(
    "http://localhost/v1/download?k=client-secret",
    {
      headers: {
        host: "ab.chatgpt.com",
        "x-forwarded-for": TEST_IPS[6],
      },
    },
  )

  expect(response.status).toBe(502)
  expect(await response.text()).toBe("Bad Gateway")
  expect(consolaErrorMock).toHaveBeenCalledTimes(1)
  const loggedCall = consolaErrorMock.mock.calls[0] as
    | Array<unknown>
    | undefined
  expect(loggedCall?.[0]).toBe("[statsig-proxy] Upstream request failed")
  expect(loggedCall?.[1]).toEqual({
    method: "GET",
    path: "/v1/download",
    errorName: "TypeError",
  })
  expect(JSON.stringify(consolaErrorMock.mock.calls)).not.toContain(
    "client-secret",
  )
  expect(JSON.stringify(consolaErrorMock.mock.calls)).not.toContain("exploded")
})

test("passes upstream 401 responses through unchanged for initialize requests", async () => {
  allowManagedIp(TEST_IPS[7])

  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("unauthorized", {
        status: 401,
        headers: {
          "content-type": "text/plain",
          "x-upstream": "statsig",
        },
      }),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  const response = await app.request(
    "http://localhost/v1/initialize?k=client-key",
    {
      method: "POST",
      headers: {
        host: "ab.chatgpt.com",
        "content-type": "application/json",
        "x-forwarded-for": TEST_IPS[7],
      },
      body: JSON.stringify({ user: { userID: "user-123" } }),
    },
  )

  expect(response.status).toBe(401)
  expect(response.headers.get("content-type")).toBe("text/plain")
  expect(response.headers.get("x-upstream")).toBe("statsig")
  expect(await response.text()).toBe("unauthorized")
})

test("passes upstream redirects through unchanged for initialize requests", async () => {
  allowManagedIp(TEST_IPS[8])

  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("redirect", {
        status: 302,
        headers: {
          location: "https://ab.chatgpt.com/download/latest",
        },
      }),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  const response = await app.request(
    "http://localhost/v1/initialize?k=client-key",
    {
      method: "POST",
      headers: {
        host: "ab.chatgpt.com",
        "content-type": "application/json",
        "x-forwarded-for": TEST_IPS[8],
      },
      body: JSON.stringify({ user: { userID: "user-123" } }),
    },
  )

  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(
    "https://ab.chatgpt.com/download/latest",
  )
  expect(await response.text()).toBe("redirect")
})

test("returns 502 for malformed successful initialize responses even without overrides", async () => {
  allowManagedIp(TEST_IPS[9])

  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          has_updates: true,
          is_delta: true,
          feature_gates: {},
          dynamic_configs: {},
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  const response = await app.request(
    "http://localhost/v1/initialize?k=client-key",
    {
      method: "POST",
      headers: {
        host: "ab.chatgpt.com",
        "content-type": "application/json",
        "x-forwarded-for": TEST_IPS[9],
      },
      body: JSON.stringify({ user: { userID: "user-123" } }),
    },
  )

  expect(response.status).toBe(502)
})

test("returns valid initialize responses byte-for-byte when no overrides are configured", async () => {
  allowManagedIp(TEST_IPS[9])

  const upstreamBody = [
    "{",
    '  "has_updates": true,',
    '  "feature_gates": {',
    '    "existing_gate": { "name": "existing_gate", "value": false }',
    "  },",
    '  "dynamic_configs": {}',
    "}",
  ].join("\n")

  const fetchMock = mock(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(upstreamBody, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-upstream": "statsig",
        },
      }),
  )
  const app = createTestApp({
    fetchImpl: fetchMock as unknown as typeof fetch,
    getOverrides: createEmptyOverrides,
  })

  const response = await app.request(
    "http://localhost/v1/initialize?k=client-key",
    {
      method: "POST",
      headers: {
        host: "ab.chatgpt.com",
        "content-type": "application/json",
        "x-forwarded-for": TEST_IPS[9],
      },
      body: JSON.stringify({ user: { userID: "user-123" } }),
    },
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(response.headers.get("x-upstream")).toBe("statsig")
  expect(await response.text()).toBe(upstreamBody)
})

test("actual server wiring handles Statsig requests before auth guard and request logger", async () => {
  state.apiKeyAuth = "test-secret-key"
  state.debug = true
  allowManagedIp(TEST_IPS[8])

  globalFetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("proxied", {
        status: 202,
        headers: { "x-upstream": "statsig" },
      }),
  )

  const racedResponse = await Promise.race([
    server.request("/v1/download?k=client-secret", {
      method: "POST",
      headers: {
        host: "ab.chatgpt.com",
        "content-type": "text/plain",
        "x-forwarded-for": TEST_IPS[8],
      },
      body: "request-body-secret",
    }),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), 25)
    }),
  ])

  expect(racedResponse).not.toBe("pending")
  if (racedResponse === "pending") {
    expect.unreachable("Statsig request should not hit the API-key silent drop")
  }

  expect(racedResponse.status).toBe(202)
  expect(racedResponse.headers.get("x-upstream")).toBe("statsig")
  expect(await racedResponse.text()).toBe("proxied")
  expect(consoleLogMock).not.toHaveBeenCalled()
})
