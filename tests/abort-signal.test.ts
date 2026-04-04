import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let lastSignal: AbortSignal | null | undefined

const chatCompletionsResponse = {
  id: "chatcmpl-1",
  object: "chat.completion" as const,
  created: 1,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant" as const,
        content: "hello",
      },
      finish_reason: "stop" as const,
      logprobs: null,
    },
  ],
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  },
}

const responsesResult = {
  id: "resp_1",
  object: "response" as const,
  created_at: 1,
  model: "gpt-4o-mini",
  output: [
    {
      id: "msg_1",
      type: "message" as const,
      role: "assistant" as const,
      status: "completed" as const,
      content: [{ type: "output_text" as const, text: "hello" }],
    },
  ],
  output_text: "hello",
  status: "completed",
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
  },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
}

const responsesCapableModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-4o-mini",
      name: "gpt-4o-mini",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

const fetchMock = mock((url: string, init?: RequestInit) => {
  lastSignal = init?.signal

  const body =
    url.includes("/responses") ? responsesResult : chatCompletionsResponse

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
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
  lastSignal = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = undefined
})

test("passes the client abort signal to messages upstream requests", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastSignal).toBeInstanceOf(AbortSignal)
})

test("passes the client abort signal to responses upstream requests", async () => {
  state.models = responsesCapableModels

  const response = await server.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: "Hello",
    }),
  })

  expect(response.status).toBe(200)
  expect(lastSignal).toBeInstanceOf(AbortSignal)
})

test("passes the client abort signal to Google AI upstream requests", async () => {
  state.models = responsesCapableModels

  const response = await server.request(
    "/v1/models/gpt-4o-mini:generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 32 },
      }),
    },
  )

  expect(response.status).toBe(200)
  expect(lastSignal).toBeInstanceOf(AbortSignal)
})
