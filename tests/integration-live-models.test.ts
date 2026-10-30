import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"

import {
  recordLiveModelResponse,
  reportSkippedLiveTests,
  runLiveTest,
  skipUnlessListed,
} from "./integration/live-models"

const originalModels = state.models
const originalGithubActions = process.env.GITHUB_ACTIONS
let warnings: Array<string> = []
let annotations: Array<string> = []

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
      limits: { max_output_tokens: 1024 },
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

function rejection(message: string, code?: string): Response {
  return Response.json({ error: { message, code } }, { status: 400 })
}

function body(modelId: string): string {
  return JSON.stringify({ model: modelId, input: "hello" })
}

beforeEach(() => {
  state.models = {
    object: "list",
    data: [model("chamomile"), model("claude-sonnet-4.5"), model("gpt-6")],
  }
  process.env.GITHUB_ACTIONS = "true"
  warnings = []
  annotations = []
  spyOn(console, "warn").mockImplementation((message: unknown) => {
    warnings.push(String(message))
  })
  spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    annotations.push(String(chunk))
    return true
  })
})

afterEach(() => {
  reportSkippedLiveTests()
  mock.restore()
  state.models = originalModels
  process.env.GITHUB_ACTIONS = originalGithubActions
})

test("skips a failure whose only model is not on the account", async () => {
  await runLiveTest("chat completion", async () => {
    const response = rejection("The requested model is not supported.")
    await recordLiveModelResponse(
      "/v1/chat/completions",
      body("gpt-4.1"),
      response,
    )
    expect(response.status).toBe(200)
  })

  reportSkippedLiveTests()
  expect(warnings).toContain(
    'Skipped live test "chat completion": gpt-4.1 is not available on this account.',
  )
  expect(annotations).toHaveLength(1)
  expect(annotations[0]).toStartWith(
    "::warning file=tests/integration-live-models.test.ts,title=Live tests skipped for unavailable models::",
  )
  expect(annotations[0]).toContain(
    "%0A- gpt-4.1 is not available on this account: chat completion",
  )
})

test("skips a failure when Copilot rejects a listed model as not supported", async () => {
  await runLiveTest("web tools", async () => {
    const response = rejection(
      "The requested model is not supported.",
      "model_not_supported",
    )
    await recordLiveModelResponse("/v1/responses", body("chamomile"), response)
    expect(response.status).toBe(200)
  })

  expect(warnings).toContain(
    'Skipped live test "web tools": chamomile is listed, but Copilot rejects it as not supported.',
  )
})

test("reads the model from a Google AI path", async () => {
  await runLiveTest("generate content", async () => {
    const response = rejection("The requested model is not supported.")
    await recordLiveModelResponse(
      "/v1/models/gemini-2.0-flash:generateContent",
      JSON.stringify({ contents: [] }),
      response,
    )
    expect(response.status).toBe(200)
  })

  expect(warnings).toContain(
    'Skipped live test "generate content": gemini-2.0-flash is not available on this account.',
  )
})

test("skips a failure when the gateway does not find an unlisted model", async () => {
  await runLiveTest("messages", async () => {
    const response = Response.json(
      {
        type: "error",
        error: {
          type: "not_found_error",
          code: "model_not_found",
          message: "The requested Copilot Messages model was not found.",
        },
      },
      { status: 404 },
    )
    await recordLiveModelResponse(
      "/v1/messages",
      body("claude-sonnet-4"),
      response,
    )
    expect(response.status).toBe(200)
  })

  expect(warnings).toContain(
    'Skipped live test "messages": claude-sonnet-4 is not available on this account.',
  )
})

test.each([
  [500, "Upstream request failed"],
  [400, "prompt_cache_options is not supported on this model"],
])(
  "keeps a %d failure on an unlisted model that is not about the model",
  async (status, message) => {
    const run = runLiveTest("unlisted", async () => {
      const response = Response.json({ error: { message } }, { status })
      await recordLiveModelResponse("/v1/responses", body("gpt-4.1"), response)
      expect(response.status).toBe(200)
    })

    const error = await run.catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(warnings).toEqual([])
  },
)

test("keeps a failure after any model served a request", async () => {
  const run = runLiveTest("candidates", async () => {
    await recordLiveModelResponse(
      "/v1/responses",
      body("chamomile"),
      rejection("The requested model is not supported."),
    )
    await recordLiveModelResponse(
      "/v1/responses",
      body("gpt-6"),
      Response.json({ status: "completed" }),
    )
    throw new Error("assertion failed")
  })

  const error = await run.catch((caught: unknown) => caught)

  expect(error).toEqual(new Error("assertion failed"))
  expect(warnings).toEqual([])
})

test.each([
  ["a listed model fails for another reason", "gpt-6"],
  ["a listed alias fails", "claude-sonnet-4-5"],
])("keeps the failure when %s", async (_case, modelId) => {
  const run = runLiveTest("cache controls", async () => {
    const response = rejection(
      "prompt_cache_options is not supported on this model",
      "invalid_request_body",
    )
    await recordLiveModelResponse("/v1/responses", body(modelId), response)
    expect(response.status).toBe(200)
  })

  const error = await run.catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(Error)
  expect(warnings).toEqual([])
})

test("keeps a failure that sent no model", async () => {
  const run = runLiveTest("models list", () => {
    throw new Error("no models listed")
  })

  const error = await run.catch((caught: unknown) => caught)

  expect(error).toEqual(new Error("no models listed"))
})

test("skips up front only for models the account does not list", () => {
  expect(skipUnlessListed("per model > gpt-6", "gpt-6")).toBe(false)
  expect(
    skipUnlessListed("per model > claude-sonnet-4-5", "claude-sonnet-4-5"),
  ).toBe(false)
  expect(skipUnlessListed("per model > gpt-4", "gpt-4")).toBe(true)
  expect(warnings).toEqual([
    'Skipped live test "per model > gpt-4": gpt-4 is not available on this account.',
  ])
})

test("reports nothing when no test was skipped", async () => {
  await runLiveTest("passing", async () => {
    await recordLiveModelResponse(
      "/v1/responses",
      body("chamomile"),
      rejection("The requested model is not supported."),
    )
  })

  reportSkippedLiveTests()
  expect(warnings).toEqual([])
  expect(annotations).toEqual([])
})
