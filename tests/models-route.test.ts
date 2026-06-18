import { afterAll, beforeEach, expect, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const originalModels = state.models

interface ModelsRouteEntry {
  id: string
  alias?: boolean
  billing?: {
    token_prices?: {
      long_context?: {
        context_max?: number
      }
    }
  }
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number
      max_output_tokens?: number
      max_prompt_tokens?: number
    }
  }
  canonical_id?: string
  model_picker_category?: string
  model_picker_price_category?: string
  name?: string
  preview?: boolean
  supports_1m_context?: boolean
  thinking?: {
    effort_options?: Array<{
      id: string
      name: string
      recommended?: boolean
    }>
  }
  vendor?: string
  version?: string
}

async function getModelsRouteEntries(): Promise<Array<ModelsRouteEntry>> {
  const response = await server.request("/v1/models")
  const body = (await response.json()) as {
    data: Array<ModelsRouteEntry>
  }
  return body.data
}

function requireModel(
  models: Array<ModelsRouteEntry>,
  id: string,
): ModelsRouteEntry {
  const model = models.find((entry) => entry.id === id)
  expect(model).toBeDefined()
  if (!model) {
    throw new Error(`Expected model ${id} in /v1/models response`)
  }
  return model
}

function expectLongContextMetadata(model: ModelsRouteEntry): void {
  expect(model.capabilities?.limits).toEqual({
    max_context_window_tokens: 1_000_000,
    max_output_tokens: 32_000,
    max_prompt_tokens: 968_000,
  })
  expect(model.billing?.token_prices?.long_context?.context_max).toBe(968_000)
  expect(model.vendor).toBe("anthropic")
  expect(model.model_picker_category).toBe("powerful")
  expect(model.model_picker_price_category).toBe("high")
}

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
          limits: {
            max_context_window_tokens: 1_000_000,
            max_output_tokens: 32_000,
            max_prompt_tokens: 968_000,
          },
          object: "model_capabilities",
          supports: {
            reasoning_effort: ["low", "medium", "high", "max"],
          },
          tokenizer: "cl100k_base",
          type: "chat",
        },
        billing: {
          token_prices: {
            batch_size: 1000,
            default: {
              context_max: 168_000,
              input_price: 3,
              output_price: 15,
            },
            long_context: {
              context_max: 968_000,
              input_price: 6,
              output_price: 22.5,
            },
          },
        },
        model_picker_category: "powerful",
        model_picker_price_category: "high",
        supported_endpoints: ["/responses"],
      },
      {
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "1",
        model_picker_enabled: true,
        capabilities: {
          family: "claude",
          limits: {
            max_context_window_tokens: 1_000_000,
            max_output_tokens: 32_000,
            max_prompt_tokens: 968_000,
          },
          object: "model_capabilities",
          supports: {
            reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
          },
          tokenizer: "cl100k_base",
          type: "chat",
        },
        supported_endpoints: ["/responses"],
      },
      {
        id: "claude-haiku-4.5",
        name: "Claude Haiku 4.5",
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
        name: "GPT-5.5",
        object: "model",
        preview: false,
        vendor: "openai",
        version: "1",
        model_picker_enabled: true,
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
  setModelRedirectsForTest([])
})

afterAll(() => {
  state.models = originalModels
  setModelRedirectsForTest([])
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
  expect(ids).toContain("claude-sonnet-4.6:max")
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

test("preserves Copilot model limits and long-context billing metadata", async () => {
  const models = await getModelsRouteEntries()
  const claude = requireModel(models, "claude-sonnet-4.6")

  expectLongContextMetadata(claude)
  expect(claude.version).toBe("1")
  expect(claude.preview).toBe(false)
  expect(claude.name).toBe("Claude Sonnet 4.6")
})

test("preserves Copilot metadata on virtual reasoning models", async () => {
  const models = await getModelsRouteEntries()
  const claudeHigh = requireModel(models, "claude-sonnet-4.6:high")

  expectLongContextMetadata(claudeHigh)
})

test("advertises Cowork 1M and reasoning metadata for Claude models", async () => {
  const models = await getModelsRouteEntries()
  const sonnet = requireModel(models, "claude-sonnet-4.6")
  const opus = requireModel(models, "claude-opus-4.8")
  const opusDash = requireModel(models, "claude-opus-4-8")
  const haiku = requireModel(models, "claude-haiku-4.5")

  expect(sonnet.supports_1m_context).toBe(true)
  expect(sonnet.thinking?.effort_options).toContainEqual({
    id: "medium",
    name: "medium",
    recommended: true,
  })
  expect(opus.supports_1m_context).toBe(true)
  expect(opus.thinking?.effort_options?.map((option) => option.id)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
  expect(opus.thinking?.effort_options).toContainEqual({
    id: "high",
    name: "high",
    recommended: true,
  })
  expect(opusDash).toMatchObject({
    alias: true,
    canonical_id: "claude-opus-4.8",
    supports_1m_context: true,
    thinking: opus.thinking,
  })
  expect(haiku.supports_1m_context).toBeUndefined()
})

test("advertises enabled redirect source models using resolved target metadata", async () => {
  setModelRedirectsForTest([
    {
      id: "gpet-to-alias",
      sourceModel: "claude-gpet-5.5",
      sourceEffort: "all",
      targetModel: "gpt-5.5-alias",
      enabled: true,
    },
    {
      id: "alias-to-gpt",
      sourceModel: "gpt-5.5-alias",
      sourceEffort: "all",
      targetModel: "gpt-5.5",
      enabled: true,
    },
    {
      id: "fallback-to-opus",
      sourceModel: "fallback-opus-4.7",
      sourceEffort: "all",
      targetModel: "claude-opus-4.8",
      targetEffort: "max",
      enabled: true,
    },
    {
      id: "disabled-custom",
      sourceModel: "disabled-custom-model",
      sourceEffort: "all",
      targetModel: "gpt-5.5",
      enabled: false,
    },
  ])

  const models = await getModelsRouteEntries()
  const ids = models.map((model) => model.id)
  const gpet = requireModel(models, "claude-gpet-5.5")
  const fallback = requireModel(models, "fallback-opus-4.7")

  expect(gpet).toMatchObject({
    alias: true,
    canonical_id: "gpt-5.5",
    name: "GPT-5.5",
    vendor: "openai",
  })
  expect(fallback).toMatchObject({
    alias: true,
    canonical_id: "claude-opus-4.8:max",
    name: "Claude Opus 4.8 (max thinking)",
    vendor: "anthropic",
  })
  expect(ids).not.toContain("disabled-custom-model")
})

test("advertises Claude dash aliases for dotted Claude model IDs", async () => {
  const models = await getModelsRouteEntries()
  const sonnet = requireModel(models, "claude-sonnet-4-6")
  const sonnetHigh = requireModel(models, "claude-sonnet-4-6:high")
  const opus = requireModel(models, "claude-opus-4-8")
  const haiku = requireModel(models, "claude-haiku-4-5")

  expect(sonnet).toMatchObject({
    alias: true,
    canonical_id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
  })
  expect(sonnetHigh).toMatchObject({
    alias: true,
    canonical_id: "claude-sonnet-4.6:high",
    name: "Claude Sonnet 4.6 (high thinking)",
  })
  expect(opus).toMatchObject({
    alias: true,
    canonical_id: "claude-opus-4.8",
    name: "Claude Opus 4.8",
  })
  expect(haiku).toMatchObject({
    alias: true,
    canonical_id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
  })
})
