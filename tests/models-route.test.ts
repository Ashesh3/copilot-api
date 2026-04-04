import { afterAll, beforeEach, expect, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalModels = state.models

beforeEach(() => {
  state.models = {
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
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
      {
        id: "gpt-5.2",
        name: "GPT-5.2",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: false,
        policy: {
          state: "enabled",
          terms: "allowed",
        },
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
      {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: false,
        policy: {
          state: "disabled",
          terms: "blocked",
        },
        capabilities: {
          family: "gpt",
          limits: {},
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  } satisfies ModelsResponse
})

afterAll(() => {
  state.models = originalModels
})

test("filters /models to picker-enabled or policy-enabled entries before adding virtual variants", async () => {
  const response = await server.request("/v1/models")

  expect(response.status).toBe(200)

  const body = (await response.json()) as {
    data: Array<{ id: string }>
  }
  const ids = body.data.map((model) => model.id)

  expect(ids).toContain("claude-sonnet-4.6")
  expect(ids).toContain("claude-sonnet-4.6:high")
  expect(ids).toContain("gpt-5.2")
  expect(ids).toContain("gpt-5.2:medium")
  expect(ids).not.toContain("gpt-5-mini")
  expect(ids).not.toContain("gpt-5-mini:high")
})
