import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import consola from "consola"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth
const originalWarn = consola.warn

beforeEach(() => {
  state.apiKeyAuth = "test-secret-key"
  consola.warn = mock(() => {}) as unknown as typeof consola.warn
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  consola.warn = originalWarn
})

test("accepts versioned telemetry calls without auth", async () => {
  const response = await server.request("/api/event_logging/v2/batch", {
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toBe("")
})

test("accepts unknown /api calls without auth", async () => {
  const response = await server.request("/api/unknown/noop", {
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toBe("")
})

test("still requires auth for defined OAuth API routes", async () => {
  const unauthorizedResponse = await server.request("/api/oauth/profile")

  expect(unauthorizedResponse.status).toBe(401)

  const authorizedResponse = await server.request("/api/oauth/profile", {
    headers: { authorization: "Bearer test-secret-key" },
  })

  expect(authorizedResponse.status).toBe(200)
})
