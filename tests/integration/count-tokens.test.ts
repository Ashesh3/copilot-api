import { describe, test, expect, beforeAll } from "bun:test"

import { initializeTestState, postJSON, TEST_TIMEOUT } from "./setup"

beforeAll(async () => {
  await initializeTestState()
}, TEST_TIMEOUT)

describe("POST /v1/messages/count_tokens", () => {
  test(
    "simple message token count",
    async () => {
      const res = await postJSON("/v1/messages/count_tokens", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello, world!" }],
        max_tokens: 100,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { input_tokens: number }
      expect(body.input_tokens).toBeDefined()
      expect(body.input_tokens).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )

  test(
    "multi-turn conversation token count",
    async () => {
      const res = await postJSON("/v1/messages/count_tokens", {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
          { role: "user", content: "How are you?" },
        ],
        max_tokens: 100,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { input_tokens: number }
      expect(body.input_tokens).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )

  test(
    "token count with system prompt",
    async () => {
      const res = await postJSON("/v1/messages/count_tokens", {
        model: "gpt-4o-mini",
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { input_tokens: number }
      expect(body.input_tokens).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )
})
