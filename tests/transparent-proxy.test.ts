import { afterAll, beforeEach, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth
const originalFetch = globalThis.fetch

function getFetchUrl(url: string | URL | Request): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.href
  return url.url
}

const fetchMock = mock((url: string | URL | Request, _init?: RequestInit) => {
  return new Response(`proxied:${getFetchUrl(url)}`, {
    status: 202,
    headers: { "x-upstream": "anthropic" },
  })
})

beforeEach(() => {
  state.apiKeyAuth = "test-secret-key"
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

async function whitelistIp(ip: string): Promise<void> {
  const response = await server.request("/api/oauth/profile", {
    headers: {
      authorization: "Bearer test-secret-key",
      "x-forwarded-for": ip,
    },
  })

  expect(response.status).toBe(200)
}

test("proxies unknown routes for whitelisted redirected Anthropic hosts", async () => {
  const ip = "198.51.100.10"
  await whitelistIp(ip)

  const response = await server.request("/random-endpoint?channel=stable", {
    headers: {
      host: "api.anthropic.com",
      "x-forwarded-for": ip,
    },
  })

  expect(response.status).toBe(202)
  expect(response.headers.get("x-upstream")).toBe("anthropic")
  expect(await response.text()).toBe(
    "proxied:https://api.anthropic.com/random-endpoint?channel=stable",
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("passes upstream redirects through without following them", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://claude.ai/download/latest" },
      })
    },
  )

  const ip = "198.51.100.16"
  await whitelistIp(ip)

  const response = await server.request("/api/desktop/update", {
    headers: {
      host: "claude.ai",
      "x-forwarded-for": ip,
    },
  })

  const requestInit = fetchMock.mock.calls.at(-1)?.[1] as
    | { redirect?: string }
    | undefined

  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(
    "https://claude.ai/download/latest",
  )
  expect(requestInit?.redirect).toBe("manual")
})

test("strips compressed body headers from transparent proxy responses", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response('{"servers":[]}', {
        status: 200,
        headers: {
          "content-encoding": "br",
          "content-length": "128",
          "content-type": "application/json",
        },
      })
    },
  )

  const ip = "198.51.100.15"
  await whitelistIp(ip)

  const response = await server.request(
    "/mcp-registry/v0/servers?version=latest&limit=100",
    {
      headers: {
        host: "api.anthropic.com",
        "x-forwarded-for": ip,
      },
    },
  )

  const requestInit = fetchMock.mock.calls.at(-1)?.[1] as
    | { headers?: Headers }
    | undefined

  expect(response.status).toBe(200)
  expect(response.headers.get("content-encoding")).toBeNull()
  expect(response.headers.get("content-length")).toBeNull()
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(await response.text()).toBe('{"servers":[]}')
  expect(requestInit?.headers?.get("accept-encoding")).toBe("identity")
  expect(requestInit?.headers?.has("host")).toBe(false)
})

test("strips dynamic hop-by-hop headers from transparent proxy responses", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response("ok", {
        headers: {
          connection: "x-internal-hop",
          "content-length": "2",
          "x-internal-hop": "remove-me",
          "x-visible": "keep-me",
        },
      })
    },
  )

  const ip = "198.51.100.17"
  await whitelistIp(ip)

  const response = await server.request("/mcp-registry/v0/servers", {
    headers: {
      host: "api.anthropic.com",
      "x-forwarded-for": ip,
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("connection")).toBeNull()
  expect(response.headers.get("x-internal-hop")).toBeNull()
  expect(response.headers.get("x-visible")).toBe("keep-me")
  expect(response.headers.get("content-length")).toBe("2")
})

test("proxies unknown /api routes for whitelisted redirected Claude hosts", async () => {
  const ip = "198.51.100.11"
  await whitelistIp(ip)

  const response = await server.request("/api/desktop/update", {
    headers: {
      host: "claude.ai",
      "x-forwarded-for": ip,
    },
  })

  expect(response.status).toBe(202)
  expect(await response.text()).toBe(
    "proxied:https://claude.ai/api/desktop/update",
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("blocks event logging for whitelisted redirected Claude hosts", async () => {
  const ip = "198.51.100.13"
  await whitelistIp(ip)

  const response = await server.request("/api/event_logging/v2/batch", {
    method: "POST",
    headers: {
      host: "claude.ai",
      "x-forwarded-for": ip,
    },
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toBe("")
  expect(fetchMock).not.toHaveBeenCalled()
})

test("does not proxy fallback routes for non-redirected hosts", async () => {
  const response = await server.request("/random-endpoint", {
    headers: {
      authorization: "Bearer test-secret-key",
      host: "localhost",
      "x-forwarded-for": "198.51.100.12",
    },
  })

  expect(response.status).toBe(404)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("does not let whitelisted redirected hosts bypass owned API route auth", async () => {
  const ip = "198.51.100.14"
  await whitelistIp(ip)

  const result = await Promise.race([
    Promise.resolve(
      server.request("/v1/messages", {
        method: "POST",
        headers: {
          host: "api.anthropic.com",
          "x-forwarded-for": ip,
        },
      }),
    ).then(() => "completed" as const),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), 25)
    }),
  ])

  expect(result).toBe("pending")
  expect(fetchMock).not.toHaveBeenCalled()
})
