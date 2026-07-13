import { describe, test, expect, beforeAll, afterEach } from "bun:test"

import { isIpBlocked, resetIpSecurityForTest } from "~/lib/ip-blocker"
import { state } from "~/lib/state"

import { initializeTestState, request, TEST_TIMEOUT } from "./setup"

let originalApiKeyAuth: string | undefined

interface ProtectedRoute {
  name: string
  path: string
  init?: RequestInit
}

const protectedRoutes: Array<ProtectedRoute> = [
  { name: "models", path: "/v1/models" },
  {
    name: "chat completions",
    path: "/v1/chat/completions",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hello" }],
      }),
    },
  },
  {
    name: "messages",
    path: "/v1/messages",
    init: {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 1,
        messages: [{ role: "user", content: "hello" }],
      }),
    },
  },
  {
    name: "responses",
    path: "/v1/responses",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", input: "hello" }),
    },
  },
  {
    name: "responses compact",
    path: "/v1/responses/compact",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", input: [] }),
    },
  },
  {
    name: "embeddings",
    path: "/v1/embeddings",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "hello",
      }),
    },
  },
  { name: "usage", path: "/v1/usage" },
]

function requestProtectedRoute(
  route: ProtectedRoute,
  clientIp: string,
  credential?: string,
): Promise<Response> {
  const headers = new Headers(route.init?.headers)
  headers.set("x-copilot-peer-ip", clientIp)
  if (credential !== undefined) headers.set("x-api-key", credential)
  return request(route.path, { ...route.init, headers })
}

beforeAll(async () => {
  await initializeTestState()
  originalApiKeyAuth = state.apiKeyAuth
}, TEST_TIMEOUT)

afterEach(() => {
  state.apiKeyAuth = originalApiKeyAuth
  resetIpSecurityForTest()
})

describe("Middleware", () => {
  describe("API key guard", () => {
    test(
      "request with correct API key succeeds",
      async () => {
        state.apiKeyAuth = "test-secret-key-12345"
        const res = await request("/v1/models", {
          headers: { "x-api-key": "test-secret-key-12345" },
        })
        expect(res.status).toBe(200)
      },
      TEST_TIMEOUT,
    )

    test(
      "request with correct API key via Bearer auth succeeds",
      async () => {
        state.apiKeyAuth = "test-secret-key-12345"
        const res = await request("/v1/models", {
          headers: { Authorization: "Bearer test-secret-key-12345" },
        })
        expect(res.status).toBe(200)
      },
      TEST_TIMEOUT,
    )

    test(
      "request with a wrong API key receives a bounded uniform denial",
      async () => {
        state.apiKeyAuth = "test-secret-key-12345"
        const res = await request("/v1/models", {
          headers: { Authorization: "Bearer definitely-wrong" },
        })
        expect(res.status).toBe(401)
        expect(res.headers.get("cache-control")).toBe("no-store")
        expect(await res.json()).toEqual({
          error: {
            message: "Unauthorized",
            type: "authentication_error",
          },
        })
      },
      TEST_TIMEOUT,
    )

    test(
      "records missing and invalid credentials on every protected route",
      async () => {
        state.apiKeyAuth = "test-secret-key-12345"

        for (const [routeIndex, route] of protectedRoutes.entries()) {
          for (const [credentialIndex, credential] of [
            undefined,
            "wrong-key",
          ].entries()) {
            const clientIp = `198.51.100.${100 + routeIndex * 2 + credentialIndex}`

            for (let attempt = 0; attempt < 3; attempt += 1) {
              const response = await requestProtectedRoute(
                route,
                clientIp,
                credential,
              )
              expect(response.status, route.name).toBe(401)
            }

            expect(isIpBlocked(clientIp), route.name).toBe(true)
            const banned = await requestProtectedRoute(
              route,
              clientIp,
              "test-secret-key-12345",
            )
            expect(banned.status, route.name).toBe(401)
          }
        }
      },
      TEST_TIMEOUT,
    )

    test(
      "public health requests do not count as authentication failures",
      async () => {
        state.apiKeyAuth = "test-secret-key-12345"
        const clientIp = "198.51.100.81"
        const headers = { "x-copilot-peer-ip": clientIp }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect((await request("/health/health", { headers })).status).toBe(
            200,
          )
        }
        expect(isIpBlocked(clientIp)).toBe(false)
      },
      TEST_TIMEOUT,
    )

    test(
      "successful authentication does not clear prior failures",
      async () => {
        state.apiKeyAuth = "test-secret-key-12345"
        const clientIp = "198.51.100.82"
        const peer = { "x-copilot-peer-ip": clientIp }

        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(
            (
              await request("/v1/models", {
                headers: { ...peer, "x-api-key": "wrong-key" },
              })
            ).status,
          ).toBe(401)
        }
        expect(
          (
            await request("/v1/models", {
              headers: {
                ...peer,
                "x-api-key": "test-secret-key-12345",
              },
            })
          ).status,
        ).toBe(200)
        expect(
          (
            await request("/v1/models", {
              headers: { ...peer, "x-api-key": "wrong-key" },
            })
          ).status,
        ).toBe(401)
        expect(isIpBlocked(clientIp)).toBe(true)
      },
      TEST_TIMEOUT,
    )
  })

  describe("Config-based auth", () => {
    test(
      "request without any auth when no keys configured succeeds",
      async () => {
        state.apiKeyAuth = undefined
        const res = await request("/v1/models")
        expect(res.status).toBe(200)
      },
      TEST_TIMEOUT,
    )
  })

  describe("CORS", () => {
    test(
      "OPTIONS request returns without error",
      async () => {
        const res = await request("/v1/models", { method: "OPTIONS" })
        expect(res.status).toBeLessThan(500)
      },
      TEST_TIMEOUT,
    )
  })
})
