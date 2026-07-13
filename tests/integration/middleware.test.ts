import { describe, test, expect, beforeAll, afterEach } from "bun:test"

import { isIpBlocked, resetIpSecurityForTest } from "~/lib/ip-blocker"
import { state } from "~/lib/state"

import { initializeTestState, request, TEST_TIMEOUT } from "./setup"

let originalApiKeyAuth: string | undefined

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
      "records failed credentials on every protected route",
      async () => {
        state.apiKeyAuth = "test-secret-key-12345"
        const clientIp = "198.51.100.80"
        const headers = {
          "x-api-key": "wrong-key",
          "x-copilot-peer-ip": clientIp,
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect((await request("/v1/models", { headers })).status).toBe(401)
        }

        expect(isIpBlocked(clientIp)).toBe(true)
        const banned = await request("/v1/models", {
          headers: {
            "x-api-key": "test-secret-key-12345",
            "x-copilot-peer-ip": clientIp,
          },
        })
        expect(banned.status).toBe(401)
      },
      TEST_TIMEOUT,
    )

    test(
      "missing credentials count on protected routes but health stays public",
      async () => {
        state.apiKeyAuth = "test-secret-key-12345"
        const clientIp = "198.51.100.81"
        const headers = { "x-copilot-peer-ip": clientIp }

        expect((await request("/v1/models", { headers })).status).toBe(401)
        expect((await request("/health/health", { headers })).status).toBe(200)
        expect((await request("/v1/models", { headers })).status).toBe(401)
        expect(isIpBlocked(clientIp)).toBe(false)

        expect((await request("/v1/models", { headers })).status).toBe(401)
        expect(isIpBlocked(clientIp)).toBe(true)
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
