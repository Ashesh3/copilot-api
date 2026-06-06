import { afterAll, beforeEach, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth

beforeEach(() => {
  state.apiKeyAuth = undefined
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
})

test("archived cloud task list returns a fast unsupported response", async () => {
  const response = await server.request(
    "/wham/tasks/list?limit=20&task_filter=archived",
  )

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: {
      message: "Unsupported Codex cloud endpoint",
      type: "not_found",
    },
  })
})

test("wham routes bypass CLI API-key silent drop behavior", async () => {
  state.apiKeyAuth = "test-secret"

  const response = await server.request(
    "/wham/tasks/list?limit=20&task_filter=archived",
  )

  expect(response.status).toBe(404)
})
