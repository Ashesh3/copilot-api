import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let lastUpstreamPayload: ChatCompletionsPayload | undefined

function parseRequestBody(init?: RequestInit): ChatCompletionsPayload {
  if (typeof init?.body !== "string") {
    return {} as ChatCompletionsPayload
  }

  return JSON.parse(init.body) as ChatCompletionsPayload
}

const fetchMock = mock((_url: string, init?: RequestInit) => {
  lastUpstreamPayload = parseRequestBody(init)

  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hello",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  lastUpstreamPayload = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = undefined
})

test("removes top_p when thinking is enabled on the chat completions path", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
      top_p: 0.2,
      thinking: { type: "enabled" },
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.temperature).toBe(1)
  expect(lastUpstreamPayload?.top_p).toBeUndefined()
})

test("maps output_config.effort onto chat completions reasoning_effort", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Think carefully." }],
      max_tokens: 32,
      thinking: { type: "enabled" },
      output_config: { effort: "max" },
    }),
  })

  expect(response.status).toBe(200)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("xhigh")
})

test("defaults chat completions reasoning_effort to medium when thinking is enabled", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Think carefully." }],
      max_tokens: 32,
      thinking: { type: "enabled" },
    }),
  })

  expect(response.status).toBe(200)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("medium")
})
