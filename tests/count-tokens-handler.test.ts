import { afterAll, beforeEach, expect, spyOn, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import {
  getRoutingAffinity,
  runWithRoutingAffinity,
  type RoutingAffinity,
} from "../src/lib/routing-affinity"
import { state } from "../src/lib/state"
import * as tokenizer from "../src/lib/tokenizer"
import { server } from "../src/server"

const originalModels = state.models

function requestCountTokensWithMetadata(headers: Record<string, string>) {
  return server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "claude-opus-4.7-1m-internal",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
      metadata: {
        user_id: JSON.stringify({ session_id: "count-body-session" }),
      },
    }),
  })
}

const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-opus-4.7-1m-internal",
      name: "Claude Opus 4.7 1M Internal",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "claude",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
    {
      id: "gpt-5.5",
      name: "GPT 5.5",
      object: "model",
      preview: false,
      vendor: "openai",
      version: "1",
      model_picker_enabled: true,
      capabilities: {
        family: "gpt-5.5",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    },
  ],
}

beforeEach(() => {
  setModelRedirectsForTest([])
  state.models = models
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
})

afterAll(() => {
  state.models = originalModels
})

test("count_tokens strips reasoning effort suffix before model lookup", async () => {
  const response = await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4.7-1m-internal:xhigh",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as { input_tokens: number }
  expect(body.input_tokens).toBeGreaterThan(1)
})

test("count_tokens uses redirected target model for model lookup", async () => {
  setModelRedirectsForTest([
    {
      id: "claude-gpt-to-gpt",
      sourceModel: "claude-gpt-5.5",
      sourceEffort: "all",
      targetModel: "gpt-5.5",
      enabled: true,
    },
  ])

  const response = await server.request("/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-gpt-5.5:xhigh",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 32,
    }),
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as { input_tokens: number }
  expect(body.input_tokens).toBeGreaterThan(1)
})

test("count_tokens installs Claude metadata affinity and preserves headers", async () => {
  const observed: Array<RoutingAffinity | undefined> = []
  const originalGetTokenCount = tokenizer.getTokenCount
  const getTokenCount = spyOn(tokenizer, "getTokenCount").mockImplementation(
    async (...args) => {
      observed.push(getRoutingAffinity())
      return await originalGetTokenCount(...args)
    },
  )
  try {
    await runWithRoutingAffinity(
      undefined,
      async () => await requestCountTokensWithMetadata({}),
    )
    await runWithRoutingAffinity(
      undefined,
      async () =>
        await requestCountTokensWithMetadata({
          "x-client-session-id": "count-header-session",
        }),
    )
  } finally {
    getTokenCount.mockRestore()
  }

  expect(observed).toEqual([
    { key: "count-body-session", source: "claude_metadata" },
    { key: "count-header-session", source: "copilot_session" },
  ])
})
