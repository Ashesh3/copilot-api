import { afterAll, beforeEach, expect, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalModels = state.models

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
  ],
}

beforeEach(() => {
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
