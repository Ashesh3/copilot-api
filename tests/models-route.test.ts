import { afterAll, beforeEach, expect, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelSettingsForTest } from "../src/lib/model-settings"
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
        supported_endpoints: ["/responses"],
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
        supported_endpoints: ["/responses", "ws:/responses"],
      },
      {
        id: "claude-implicit-medium",
        name: "Claude Implicit Medium",
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
        supported_endpoints: ["/chat/completions"],
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
  setModelSettingsForTest([])
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

test("uses model settings to hide virtual variants for implicit reasoning defaults", async () => {
  setModelSettingsForTest([
    {
      model: "claude-implicit-medium",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      implicitReasoningDefault: true,
    },
  ])

  const response = await server.request("/v1/models")
  const body = (await response.json()) as {
    data: Array<{ id: string }>
  }
  const ids = body.data.map((model) => model.id)

  expect(ids).toContain("claude-implicit-medium")
  expect(ids).not.toContain("claude-implicit-medium:medium")
})

test("advertises ws:/responses only for native Responses models", async () => {
  const response = await server.request("/v1/models")
  const body = (await response.json()) as {
    data: Array<{ id: string; supported_endpoints?: Array<string> }>
  }

  const claude = body.data.find((model) => model.id === "claude-sonnet-4.6")
  const claudeHigh = body.data.find(
    (model) => model.id === "claude-sonnet-4.6:high",
  )
  const gpt = body.data.find((model) => model.id === "gpt-5.2")
  const gptMedium = body.data.find((model) => model.id === "gpt-5.2:medium")
  const chatOnly = body.data.find(
    (model) => model.id === "claude-implicit-medium",
  )

  expect(claude?.supported_endpoints).toEqual(["/responses", "ws:/responses"])
  expect(claudeHigh?.supported_endpoints).toEqual([
    "/responses",
    "ws:/responses",
  ])
  expect(gpt?.supported_endpoints).toEqual(["/responses", "ws:/responses"])
  expect(gptMedium?.supported_endpoints).toEqual([
    "/responses",
    "ws:/responses",
  ])
  expect(chatOnly?.supported_endpoints).toEqual(["/chat/completions"])
})
