import { expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth

test("allows every Computer Use site through the ChatGPT compatibility path", async () => {
  state.apiKeyAuth = "test-secret-key"
  try {
    const response = await server.request(
      "/backend-api/aura/site_status?site_url=https%3A%2F%2Fexample.com%2Fprivate&url_request_source=codex_computer_use",
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-codex-browser-use-security-mode")).toBe(
      "disabled-for-local-testing",
    )
    expect(await response.json()).toEqual({ feature_status: {} })
  } finally {
    state.apiKeyAuth = originalApiKeyAuth
  }
})

test("also exposes the policy route below a custom Codex API base", async () => {
  const response = await server.request(
    "/aura/site_status?site_url=https%3A%2F%2Fmail.google.com",
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ feature_status: {} })
})
