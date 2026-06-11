import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
let lastUpstreamPayload: ChatCompletionsPayload | undefined

const upstreamMaxReasoningModels: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: { reasoning_effort: ["low", "medium", "high", "max"] },
        tokenizer: "cl100k_base",
        type: "chat",
      },
      supported_endpoints: ["/chat/completions"],
    },
  ],
}

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
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
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
  ).toBe("max")
})

test("maps literal xhigh output_config.effort onto chat completions reasoning_effort", async () => {
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
      output_config: { effort: "xhigh" },
    }),
  })

  expect(response.status).toBe(200)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("xhigh")
})

test("passes max reasoning through when upstream metadata advertises max", async () => {
  state.models = upstreamMaxReasoningModels

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4.6:max",
      messages: [{ role: "user", content: "Think carefully." }],
      max_tokens: 32,
      thinking: { type: "enabled" },
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-sonnet-4.6")
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("max")
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

test("redirects unsupported Anthropic high-effort model suffixes before upstream", async () => {
  setModelRedirectsForTest([
    {
      id: "source-high",
      sourceModel: "claude-source-1m",
      sourceEffort: "high",
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
      model: "claude-source-1m:high",
      messages: [{ role: "user", content: "Think carefully." }],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-target-1m")
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("high")
})

test("rewrites final assistant message after model redirects when prefill is unsupported", async () => {
  setModelRedirectsForTest([
    {
      id: "opus-48-to-47",
      sourceModel: "claude-opus-4.8",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "internal-xhigh",
      sourceModel: "claude-opus-4.7-1m-internal",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      targetEffort: "xhigh",
      enabled: true,
    },
  ])
  setModelSettingsForTest([
    {
      model: "claude-opus-4.7-1m-internal",
      supportsAssistantPrefill: false,
    },
  ])

  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4.8",
      messages: [
        { role: "user", content: "Help me investigate an error." },
        {
          role: "assistant",
          content:
            "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded - calling them directly will fail with InputValidationError.",
        },
      ],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-opus-4.7-1m-internal")
  expect(lastUpstreamPayload?.messages).toEqual([
    { role: "user", content: "Help me investigate an error." },
    {
      role: "user",
      content:
        "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded - calling them directly will fail with InputValidationError.",
    },
  ])
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("xhigh")
})

test("applies final self-redirect effort on direct chat completions requests", async () => {
  setModelRedirectsForTest([
    {
      id: "opus-47-to-internal",
      sourceModel: "claude-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      enabled: true,
    },
    {
      id: "internal-xhigh",
      sourceModel: "claude-opus-4.7-1m-internal",
      sourceEffort: "all",
      targetModel: "claude-opus-4.7-1m-internal",
      targetEffort: "xhigh",
      enabled: true,
    },
  ])

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4.7:low",
      messages: [{ role: "user", content: "Think carefully." }],
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-opus-4.7-1m-internal")
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBe("xhigh")
})

test("does not send custom reasoning effort for implicit-default models", async () => {
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
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-implicit-medium")
  expect(lastUpstreamPayload?.temperature).toBe(1)
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBeUndefined()
})

test("strips custom reasoning effort for direct implicit-default chat completions", async () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-implicit-medium:high",
      messages: [{ role: "user", content: "Think carefully." }],
      reasoning_effort: "high",
    }),
  })

  expect(response.status).toBe(200)
  expect(lastUpstreamPayload?.model).toBe("claude-implicit-medium")
  expect(
    (lastUpstreamPayload as Record<string, unknown> | undefined)
      ?.reasoning_effort,
  ).toBeUndefined()
})
