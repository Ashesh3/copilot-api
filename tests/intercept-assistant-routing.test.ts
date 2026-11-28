import { afterEach, beforeEach, expect, test } from "bun:test"

import type {
  AssistantDiffOp,
  InterceptAssistantConfig,
  InterceptPendingItem,
} from "~/lib/intercept/types"
import type { Model } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import { runInterceptAssistant } from "~/lib/intercept/assistant"
import { AssistantSessionCache } from "~/lib/intercept/assistant-cache"
import { listAssistantModels } from "~/lib/intercept/assistant-model"
import { parseCanonicalView } from "~/lib/intercept/canonical"
import { INTERCEPT_ASSISTANT_KINDS } from "~/lib/intercept/types"
import {
  setModelFallbackConfigForTest,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { setModelRedirectsForTest } from "~/lib/model-redirect"
import {
  resetModelRoutingOverridesForTest,
  setModelRoutingOverridesForTest,
} from "~/lib/model-routing"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = { ...state }
const calls: Array<{
  path: string
  model: unknown
  stream: unknown
  reasoning: unknown
  authorization: string | null
}> = []
const testAccountIds = new Set<number>()

function recordCall(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Record<string, unknown> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (typeof init?.body !== "string") throw new Error("Unexpected test fetch")
  const body = JSON.parse(init.body) as Record<string, unknown>
  calls.push({
    path: url.pathname,
    model: body.model,
    stream: body.stream,
    reasoning: body.reasoning,
    authorization: new Headers(init.headers).get("authorization"),
  })
  return body
}

const ASSISTANT: InterceptAssistantConfig = {
  enabled: true,
  autoRun: false,
  autopilot: "off",
  model: "source-model",
  systemPrompt: "",
  reasoningEffort: "low",
  messageKinds: [...INTERCEPT_ASSISTANT_KINDS],
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
    const body = recordCall(input, init)
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
  for (const accountId of testAccountIds)
    tokenPool.removeAccountForTest(accountId)
  testAccountIds.clear()
  Object.assign(state, originalState)
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  setModelFallbackConfigForTest(null)
  resetModelRoutingOverridesForTest()
  setConfigForTest(null)
})

function responsesReply(model: unknown, text: string): Response {
  return Response.json({
    id: "resp_assistant",
    object: "response",
    created_at: 1,
    model,
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_assistant",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  })
}

/** Answer every upstream call as a completed Responses result carrying `reply`. */
function respondFromResponses(reply: {
  summary: string
  operations: Array<AssistantDiffOp>
}): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const body = recordCall(input, init)
    return Promise.resolve(responsesReply(body.model, JSON.stringify(reply)))
  }) as typeof fetch
}

/** Answer upstream calls with `replies` in turn; each call's prompt is kept. */
function respondInTurn(replies: Array<string>): Array<string> {
  const prompts: Array<string> = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const body = recordCall(input, init)
    prompts.push(JSON.stringify(body.input))
    return Promise.resolve(responsesReply(body.model, replies.shift() ?? ""))
  }) as typeof fetch
  return prompts
}

/** A held chat request carrying `messages`, parsed the way the engine does. */
function conversation(
  messages: Array<{ role: string; content: string }>,
  sessionId = "conversation-1",
): InterceptPendingItem {
  const body = JSON.stringify({ model: "client-model", messages })
  return {
    ...heldItem(),
    sessionId,
    originalBody: body,
    currentBody: body,
    canonical: parseCanonicalView({
      path: "/chat/completions",
      phase: "request",
      body,
    }),
  }
}

function withEndpoints(id: string, endpoints: Array<string>): Model {
  return { ...model(id), supported_endpoints: endpoints }
}

/** Two pooled accounts listing `id`, the first with `first`'s endpoints. */
async function installAccounts(
  id: string,
  rows: { first: Array<string>; second: Array<string> },
): Promise<void> {
  for (const account of tokenPool.getAllAccounts()) {
    tokenPool.deleteAccount(account.id)
  }
  for (const [accountId, endpoints] of [
    [61_001, rows.first],
    [61_002, rows.second],
  ] as const) {
    const account = tokenPool.addAccount(
      `github-${accountId}`,
      "individual",
      accountId,
    )
    testAccountIds.add(accountId)
    account.copilotToken = `account-${accountId}-token`
    account.healthy = true
    account.models = new Set([id])
    account.modelsData = [withEndpoints(id, endpoints)]
  }
  state.isMultiToken = true
  tokenPool.rebuildModelIndex()
  // The merged catalog keeps the first account's row.
  state.models = tokenPool.getAllModels()
  await seedProtocolDatabase()
}

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

test("a Responses-only model is offered and called there with the configured effort", async () => {
  const base = model("responses-model")
  state.models = {
    object: "list",
    data: [
      {
        ...base,
        supported_endpoints: ["/responses"],
        // The model's default is its first level, so "low" must be the setting.
        capabilities: {
          ...base.capabilities,
          supports: { reasoning_effort: ["medium", "high", "low"] },
        },
      },
    ],
  }
  const operations: Array<AssistantDiffOp> = [
    { op: "edit", id: "msg-0", find: "hello", replace: "hi" },
  ]
  const reply = { summary: "Greeting changed", operations }
  respondFromResponses(reply)

  expect(listAssistantModels()).toEqual(["responses-model"])
  const suggestion = await runInterceptAssistant({
    item: heldItem(),
    config: { ...ASSISTANT, model: "responses-model" },
  })

  expect(calls.map((call) => call.path)).toEqual(["/responses"])
  expect(suggestion.operations).toEqual(reply.operations)
  expect(calls[0]?.reasoning).toMatchObject({ effort: "low" })
})

test("an effort below the model's levels clamps to its lowest, not its default", async () => {
  const base = model("responses-model")
  state.models = {
    object: "list",
    data: [
      {
        ...base,
        supported_endpoints: ["/responses"],
        capabilities: {
          ...base.capabilities,
          supports: { reasoning_effort: ["medium", "high", "low"] },
        },
      },
    ],
  }
  respondFromResponses({ summary: "No change", operations: [] })

  await runInterceptAssistant({
    item: heldItem(),
    config: { ...ASSISTANT, model: "responses-model", reasoningEffort: "none" },
  })

  expect(calls[0]?.reasoning).toMatchObject({ effort: "low" })
})

test('"Model default" sends no effort on Responses to a model without levels', async () => {
  state.models = {
    object: "list",
    data: [withEndpoints("plain-responses-model", ["/responses"])],
  }
  respondFromResponses({ summary: "No change", operations: [] })

  await runInterceptAssistant({
    item: heldItem(),
    config: {
      ...ASSISTANT,
      model: "plain-responses-model",
      reasoningEffort: "default",
    },
  })

  expect(calls.map((call) => call.path)).toEqual(["/responses"])
  expect(calls[0]?.reasoning).not.toHaveProperty("effort")
})

test("a redirected model ID is offered and calls the redirect target", async () => {
  setModelRedirectsForTest([
    {
      id: "assistant-redirect",
      sourceModel: "alias-model",
      sourceEffort: "all",
      targetModel: "target-model",
      enabled: true,
    },
  ])

  expect(listAssistantModels()).toContain("alias-model")
  const suggestion = await runInterceptAssistant({
    item: heldItem(),
    config: { ...ASSISTANT, model: "alias-model" },
  })

  expect(calls.map((call) => call.model)).toEqual(["target-model"])
  expect(suggestion.model).toBe("target-model")
})

test("multi-account: the serving account's row picks the endpoint", async () => {
  // The first account's row wins the merged catalog, but routing disables the
  // model there; the eligible account serves it through Responses only.
  setModelRoutingOverridesForTest({ "pooled-model": { "61001": false } })
  await installAccounts("pooled-model", {
    first: ["/chat/completions"],
    second: ["/responses"],
  })
  respondFromResponses({ summary: "No change", operations: [] })

  expect(state.models?.data[0]?.supported_endpoints).toEqual([
    "/chat/completions",
  ])
  expect(listAssistantModels()).toEqual(["pooled-model"])
  await runInterceptAssistant({
    item: heldItem(),
    config: { ...ASSISTANT, model: "pooled-model" },
  })

  expect(calls.map((call) => call.path)).toEqual(["/responses"])
  expect(calls[0]?.authorization).toContain("account-61002-token")
})

test("multi-account: a model is offered when another account serves it", async () => {
  await installAccounts("pooled-model", {
    first: ["/embeddings"],
    second: ["/responses"],
  })

  expect(listAssistantModels()).toEqual(["pooled-model"])
})

/**
 * List a Responses-only test model. A model call refreshes the catalog from
 * the account pool, which does not know test models, so list it per run.
 */
function listModel(): void {
  state.models = {
    object: "list",
    data: [withEndpoints("responses-model", ["/responses"])],
  }
}

test("a growing conversation sends only its new messages and reuses earlier results", async () => {
  const prompts = respondInTurn([
    JSON.stringify({
      summary: "first",
      operations: [{ op: "edit", id: "msg-0", find: "hello", replace: "hi" }],
    }),
    JSON.stringify({
      summary: "second",
      operations: [
        { op: "edit", id: "msg-1", find: "weather", replace: "forecast" },
      ],
    }),
  ])
  const cache = new AssistantSessionCache()
  const config = { ...ASSISTANT, model: "responses-model" }
  const first = [{ role: "user", content: "hello" }]
  const grown = [...first, { role: "user", content: "what is the weather" }]

  listModel()
  await runInterceptAssistant({ item: conversation(first), config, cache })
  listModel()
  const second = await runInterceptAssistant({
    item: conversation(grown),
    config,
    cache,
  })
  listModel()
  const third = await runInterceptAssistant({
    item: conversation(grown),
    config,
    cache,
  })

  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain("what is the weather")
  expect(prompts[1]).not.toContain("hello")
  expect(second.reusedItemCount).toBe(1)
  expect(second.operations).toEqual([
    { op: "edit", id: "msg-0", find: "hello", replace: "hi" },
    { op: "edit", id: "msg-1", find: "weather", replace: "forecast" },
  ])
  expect(second.reusedOperationCount).toBe(1)
  // Nothing new: no model call, every result reused.
  expect(third.reusedItemCount).toBe(2)
  expect(third.operations).toEqual(second.operations)
})

test("message types limit what the model sees and may insert", async () => {
  state.models = {
    object: "list",
    data: [withEndpoints("responses-model", ["/responses"])],
  }
  const prompts = respondInTurn([
    JSON.stringify({
      summary: "adds a system rule",
      operations: [
        { op: "insert_after", afterId: null, kind: "system", content: "x" },
      ],
    }),
  ])

  const failure = await runInterceptAssistant({
    item: conversation([
      { role: "system", content: "secret system rules" },
      { role: "user", content: "hello" },
    ]),
    config: { ...ASSISTANT, model: "responses-model", messageKinds: ["user"] },
  }).then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(prompts[0]).not.toContain("secret system rules")
  expect(prompts[0]).toContain("hello")
  expect(String(failure)).toContain("may only insert user items")
  // The operator sees what the model actually answered.
  expect(String(failure)).toContain("Model reply:")
})

test("results are never reused across conversations or without one", async () => {
  const reply = JSON.stringify({
    summary: "private edit",
    operations: [
      { op: "edit", id: "msg-0", find: "hello", replace: "hello from A" },
    ],
  })
  const prompts = respondInTurn([reply, reply, reply])
  const cache = new AssistantSessionCache()
  const config = { ...ASSISTANT, model: "responses-model" }
  const shared = [{ role: "user", content: "hello" }]

  listModel()
  await runInterceptAssistant({
    item: conversation(shared, "A"),
    config,
    cache,
  })
  listModel()
  const other = await runInterceptAssistant({
    item: conversation(shared, "B"),
    config,
    cache,
  })
  listModel()
  const anonymous = await runInterceptAssistant({
    item: { ...conversation(shared), sessionId: undefined },
    config,
    cache,
  })

  // Each run asked the model itself; nothing from A was reused.
  expect(prompts).toHaveLength(3)
  expect(other.reusedItemCount).toBe(0)
  expect(anonymous.reusedItemCount).toBe(0)
})
