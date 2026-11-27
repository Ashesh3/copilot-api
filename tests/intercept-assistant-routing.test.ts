import { afterEach, beforeEach, expect, test } from "bun:test"

import type {
  InterceptAssistantConfig,
  InterceptPendingItem,
} from "~/lib/intercept/types"
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { runInterceptAssistant } from "~/lib/intercept/assistant"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const calls: Array<{ path: string; model: unknown; stream: unknown }> = []

const ASSISTANT: InterceptAssistantConfig = {
  enabled: true,
  autoRun: false,
  autopilot: "off",
  model: "source-model",
  instructionMode: "shared",
  sharedInstruction: "Rewrite the user turn",
  requestInstruction: "",
  responseInstruction: "",
}

function model(id: string): Model {
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      family: "gpt",
      limits: { max_output_tokens: 8192 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function heldItem(): InterceptPendingItem {
  return {
    id: "item-1",
    phase: "request",
    status: "pending",
    createdAt: new Date(0).toISOString(),
    createdAtMs: 0,
    expiresAtMs: 60_000,
    modified: false,
    revision: 0,
    method: "POST",
    path: "/chat/completions",
    url: "https://api.githubcopilot.com/chat/completions",
    upstream: "copilot",
    headers: {},
    originalBody: "{}",
    currentBody: "{}",
    canonical: {
      protocol: "chat_completions",
      phase: "request",
      items: [{ id: "msg-0", kind: "user", label: "User", content: "hello" }],
      editable: true,
    },
    assistantStatus: "idle",
  }
}

function chatCompletion(modelId: unknown): Response {
  return Response.json({
    id: "chatcmpl-assistant",
    object: "chat.completion",
    created: 1,
    model: modelId,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content: JSON.stringify({ summary: "No change", operations: [] }),
        },
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  })
}

beforeEach(async () => {
  calls.length = 0
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "assistant-test-token",
    githubToken: "assistant-test-github-token",
    isMultiToken: false,
    manualApprove: false,
    apiKeyAuth: undefined,
    models: {
      object: "list",
      data: [model("source-model"), model("target-model")],
    },
  })
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({
      enabled: true,
      rules: [
        {
          id: "assistant-fallback",
          sourceModel: "source-model",
          targetModel: "target-model",
          enabled: true,
        },
      ],
    }),
  )
  await seedProtocolDatabase()
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (typeof init?.body !== "string") throw new Error("Unexpected test fetch")
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path: url.pathname, model: body.model, stream: body.stream })
    if (body.model === "source-model") {
      return Promise.resolve(
        Response.json(
          { error: { code: "invalid_request", message: "Any upstream 422" } },
          { status: 422 },
        ),
      )
    }
    return Promise.resolve(chatCompletion(body.model))
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
  setConfigForTest(null)
})

test("a 422 from the assistant model retries the configured fallback model", async () => {
  const suggestion = await runInterceptAssistant({
    item: heldItem(),
    config: ASSISTANT,
  })

  expect(calls.map((call) => call.model)).toEqual([
    "source-model",
    "target-model",
  ])
  expect(calls.every((call) => call.path.endsWith("/chat/completions"))).toBe(
    true,
  )
  expect(calls.every((call) => call.stream === false)).toBe(true)
  expect(suggestion.model).toBe("target-model")
  expect(suggestion.operations).toEqual([])
})

test("without a fallback rule the 422 reaches the operator", async () => {
  setModelFallbackConfigForTest(
    validateModelFallbackConfig({ enabled: true, rules: [] }),
  )

  const failure: unknown = await runInterceptAssistant({
    item: heldItem(),
    config: ASSISTANT,
  }).then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)
  expect(calls.map((call) => call.model)).toEqual(["source-model"])
})
