import { describe, test, expect, beforeAll, afterEach } from "bun:test"

import { state } from "~/lib/state"

import { initializeTestState, request, TEST_TIMEOUT } from "./setup"

let originalApiKeyAuth: string | undefined

beforeAll(async () => {
  await initializeTestState()
  originalApiKeyAuth = state.apiKeyAuth
}, TEST_TIMEOUT)

afterEach(() => {
  state.apiKeyAuth = originalApiKeyAuth
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
