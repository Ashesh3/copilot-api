import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let lastResponsesPayload: ResponsesPayload | undefined

function parseRequestBody(init?: RequestInit): ResponsesPayload {
  if (typeof init?.body !== "string") {
    return {} as ResponsesPayload
  }

  return JSON.parse(init.body) as ResponsesPayload
}

const responsesCapableModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "gpt-4o",
      name: "gpt-4o",
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
    {
      id: "claude-implicit-medium",
      name: "Claude Implicit Medium",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
    {
      id: "claude-target-1m",
      name: "Claude Target 1M",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

const responsesResult = {
  id: "resp_1",
  object: "response" as const,
  created_at: 1,
  model: "gpt-4o",
  output: [
    {
      id: "msg_1",
      type: "message" as const,
      role: "assistant" as const,
      status: "completed" as const,
      content: [{ type: "output_text" as const, text: '{"answer":"ok"}' }],
    },
  ],
  output_text: '{"answer":"ok"}',
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

const fetchMock = mock((_url: string, init?: RequestInit) => {
  lastResponsesPayload = parseRequestBody(init)

  return new Response(JSON.stringify(responsesResult), {
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
  lastResponsesPayload = undefined
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = responsesCapableModels
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test("preserves output_config.format on the Anthropic responses path", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Return JSON." }],
      max_tokens: 32,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              answer: { type: "string" },
            },
          },
        },
      },
    }),
  })

  expect(response.status).toBe(200)
  expect(
    (lastResponsesPayload as Record<string, unknown> | undefined)?.text,
  ).toEqual({
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          answer: { type: "string" },
        },
      },
    },
  })
})

test("preserves output_config.task_budget on the Anthropic responses path", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Use the remaining budget carefully." },
      ],
      max_tokens: 32,
      output_config: {
        task_budget: {
          type: "tokens",
          total: 500,
          remaining: 320,
        },
      },
    }),
  })

  expect(response.status).toBe(200)
  expect(
    (lastResponsesPayload as Record<string, unknown> | undefined)?.task_budget,
  ).toEqual({
    type: "tokens",
    total: 500,
    remaining: 320,
  })
})

test("maps output_config.effort onto the Anthropic responses path", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Be concise." }],
      max_tokens: 32,
      output_config: {
        effort: "medium",
      },
    }),
  })

  expect(response.status).toBe(200)
  expect(lastResponsesPayload?.reasoning?.effort).toBe("medium")
})

test("defaults reasoning effort to medium on the Anthropic responses path", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Think carefully." }],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastResponsesPayload?.reasoning?.effort).toBe("medium")
})

test("redirects Anthropic max output_config effort on the responses path", async () => {
  setModelRedirectsForTest([
    {
      id: "source-max",
      sourceModel: "claude-source-1m",
      sourceEffort: "max",
      targetModel: "claude-target-1m",
      targetEffort: "high",
      enabled: true,
    },
  ])

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-source-1m",
      messages: [{ role: "user", content: "Think carefully." }],
      max_tokens: 32,
      output_config: {
        effort: "max",
      },
    }),
  })

  expect(response.status).toBe(200)
  expect(lastResponsesPayload?.model).toBe("claude-target-1m")
  expect(lastResponsesPayload?.reasoning?.effort).toBe("high")
})

test("does not send configurable effort for implicit-default models on the responses path", async () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-implicit-medium:high",
      messages: [{ role: "user", content: "Think carefully." }],
      max_tokens: 32,
      output_config: {
        effort: "high",
      },
    }),
  })

  expect(response.status).toBe(200)
  expect(lastResponsesPayload?.model).toBe("claude-implicit-medium")
  expect(lastResponsesPayload?.reasoning?.effort).toBeUndefined()
  expect(lastResponsesPayload?.reasoning?.summary).toBe("auto")
})
