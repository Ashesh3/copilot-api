import { afterEach, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

afterEach(() => {
  delete process.env.COPILOT_INFERENCE_CORS_ORIGINS
  state.apiKeyAuth = undefined
})

test("inference CORS is disabled by default", async () => {
  const response = await server.request("/v1/models", {
    headers: { origin: "https://client.example" },
  })
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
})

test("configured exact origins receive inference-only CORS", async () => {
  process.env.COPILOT_INFERENCE_CORS_ORIGINS = "https://client.example"
  const preflight = await server.request("/v1/responses", {
    method: "OPTIONS",
    headers: { origin: "https://client.example" },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-origin")).toBe(
    "https://client.example",
  )

  const admin = await server.request("/dashboard/api/overview", {
    method: "OPTIONS",
    headers: { origin: "https://client.example" },
  })
  expect(admin.status).toBe(404)
  expect(admin.headers.get("access-control-allow-origin")).toBeNull()
})

test("untrusted origins never receive CORS headers", async () => {
  process.env.COPILOT_INFERENCE_CORS_ORIGINS = "https://client.example"
  const response = await server.request("/v1/models", {
    headers: { origin: "https://evil.invalid" },
  })
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
})
