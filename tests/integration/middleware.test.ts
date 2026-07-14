import { describe, test, expect, beforeAll, afterEach } from "bun:test"

import { apiKeyGuard } from "~/lib/api-key-guard"
import { isIpBlocked, resetIpSecurityForTest } from "~/lib/ip-blocker"
import { state } from "~/lib/state"
import { server } from "~/server"

import { initializeTestState, request, TEST_TIMEOUT } from "./setup"

let originalApiKeyAuth: string | undefined

interface ProtectedRoute {
  method: "DELETE" | "GET" | "PATCH" | "POST"
  mountedMethod: "ALL" | ProtectedRoute["method"]
  mountedPath: string
  name: string
  path: string
  headers?: Record<string, string>
  body?: string
}

const protectedRoutes: Array<ProtectedRoute> = [
  {
    name: "direct connect session creation",
    method: "POST",
    path: "/sessions",
    mountedMethod: "POST",
    mountedPath: "/sessions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  },
  {
    name: "direct connect session listing",
    method: "GET",
    path: "/sessions/api/sessions",
    mountedMethod: "GET",
    mountedPath: "/sessions/api/sessions",
  },
  {
    name: "direct connect session deletion",
    method: "DELETE",
    path: "/sessions/api/sessions/session-test",
    mountedMethod: "DELETE",
    mountedPath: "/sessions/api/sessions/:id",
  },
  {
    name: "root",
    method: "GET",
    path: "/",
    mountedMethod: "GET",
    mountedPath: "/",
  },
  {
    name: "chat completions",
    method: "POST",
    path: "/chat/completions",
    mountedMethod: "POST",
    mountedPath: "/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hello" }],
    }),
  },
  {
    name: "models",
    method: "GET",
    path: "/models",
    mountedMethod: "GET",
    mountedPath: "/models",
  },
  {
    name: "embeddings",
    method: "POST",
    path: "/embeddings",
    mountedMethod: "POST",
    mountedPath: "/embeddings",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: "hello",
    }),
  },
  {
    name: "usage",
    method: "GET",
    path: "/usage",
    mountedMethod: "GET",
    mountedPath: "/usage",
  },
  {
    name: "responses compact",
    method: "POST",
    path: "/responses/compact",
    mountedMethod: "POST",
    mountedPath: "/responses/compact",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4.1", input: [] }),
  },
  {
    name: "responses",
    method: "POST",
    path: "/responses",
    mountedMethod: "POST",
    mountedPath: "/responses",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4.1", input: "hello" }),
  },
  {
    name: "v1 chat completions",
    method: "POST",
    path: "/v1/chat/completions",
    mountedMethod: "POST",
    mountedPath: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hello" }],
    }),
  },
  {
    name: "v1 models",
    method: "GET",
    path: "/v1/models",
    mountedMethod: "GET",
    mountedPath: "/v1/models",
  },
  {
    name: "v1 embeddings",
    method: "POST",
    path: "/v1/embeddings",
    mountedMethod: "POST",
    mountedPath: "/v1/embeddings",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: "hello",
    }),
  },
  {
    name: "v1 responses compact",
    method: "POST",
    path: "/v1/responses/compact",
    mountedMethod: "POST",
    mountedPath: "/v1/responses/compact",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4.1", input: [] }),
  },
  {
    name: "v1 responses",
    method: "POST",
    path: "/v1/responses",
    mountedMethod: "POST",
    mountedPath: "/v1/responses",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4.1", input: "hello" }),
  },
  {
    name: "Codex standalone web search",
    method: "POST",
    path: "/v1/alpha/search",
    mountedMethod: "POST",
    mountedPath: "/v1/alpha/search",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "search-session",
      model: "gpt-4.1",
      commands: { search_query: [{ q: "current news" }] },
    }),
  },
  {
    name: "v1 messages",
    method: "POST",
    path: "/v1/messages",
    mountedMethod: "POST",
    mountedPath: "/v1/messages",
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
  {
    name: "v1 message token counting",
    method: "POST",
    path: "/v1/messages/count_tokens",
    mountedMethod: "POST",
    mountedPath: "/v1/messages/count_tokens",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
    }),
  },
  {
    name: "Google generateContent",
    method: "POST",
    path: "/models/gemini-2.0-flash:generateContent",
    mountedMethod: "POST",
    mountedPath: "/models/:modelAction",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }),
  },
  {
    name: "Google streamGenerateContent",
    method: "POST",
    path: "/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    mountedMethod: "POST",
    mountedPath: "/models/:modelAction",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }),
  },
  {
    name: "v1 Google generateContent",
    method: "POST",
    path: "/v1/models/gemini-2.0-flash:generateContent",
    mountedMethod: "POST",
    mountedPath: "/v1/models/:modelAction",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }),
  },
  {
    name: "v1 Google streamGenerateContent",
    method: "POST",
    path: "/v1/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    mountedMethod: "POST",
    mountedPath: "/v1/models/:modelAction",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }),
  },
  {
    name: "v1beta Google generateContent",
    method: "POST",
    path: "/v1beta/models/gemini-2.0-flash:generateContent",
    mountedMethod: "POST",
    mountedPath: "/v1beta/models/:modelAction",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }),
  },
  {
    name: "v1beta Google streamGenerateContent",
    method: "POST",
    path: "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    mountedMethod: "POST",
    mountedPath: "/v1beta/models/:modelAction",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }),
  },
  {
    name: "transparent proxy",
    method: "POST",
    path: "/v1/complete",
    mountedMethod: "ALL",
    mountedPath: "/*",
    headers: {
      "content-type": "application/json",
      host: "api.anthropic.com",
    },
    body: JSON.stringify({}),
  },
]

function requestProtectedRoute(
  route: ProtectedRoute,
  clientIp: string,
  credential?: string,
): Promise<Response> {
  const headers = new Headers(route.headers)
  headers.set("x-copilot-peer-ip", clientIp)
  if (credential !== undefined) headers.set("x-api-key", credential)
  return request(route.path, {
    method: route.method,
    headers,
    body: route.body,
  })
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
    test("protected route matrix entries map to mounted routes", () => {
      expect(protectedRoutes).toHaveLength(25)

      const guardIndex = server.routes.findIndex(
        (route) => route.handler === apiKeyGuard,
      )
      expect(guardIndex).toBeGreaterThanOrEqual(0)

      const mountedRoutes = new Set(
        server.routes
          .slice(guardIndex + 1)
          .map((route) => `${route.method} ${route.path}`),
      )

      for (const route of protectedRoutes) {
        expect(
          mountedRoutes.has(`${route.mountedMethod} ${route.mountedPath}`),
          `${route.name}: ${route.method} ${route.path}`,
        ).toBe(true)
      }
    })

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
      "request with a wrong API key receives a uniform denial",
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
            const clientIp = `198.51.${100 + credentialIndex}.${routeIndex + 1}`

            for (let attempt = 0; attempt < 3; attempt += 1) {
              const response = await requestProtectedRoute(
                route,
                clientIp,
                credential,
              )
              expect(response.status, route.name).toBe(401)
            }

            expect(isIpBlocked(clientIp), route.name).toBe(true)
            const banned = await request("/v1/models", {
              headers: {
                "x-api-key": "test-secret-key-12345",
                "x-copilot-peer-ip": clientIp,
              },
            })
            expect(banned.status, `${route.name} shared ban`).toBe(401)
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
