import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { setConfigForTest } from "~/lib/config"
import {
  createCustomProviderChatCompletions,
  resolveCustomProviderModel,
} from "~/lib/custom-providers"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { getModelReasoningConfig } from "~/lib/model-suffix"
import { state } from "~/lib/state"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const HAIKU = "claude-haiku-4.5"
const CLAUDE_CHAT_ONLY = "claude-chat-only"
const CHAT_MODEL = "omit-chat"
const RESPONSES_MODEL = "omit-responses"
const EFFORT_MODEL = "effort-chat"
const CUSTOM_MODEL = "custom-effort-model"

interface UpstreamCall {
  path: string
  body: Record<string, unknown>
}

const upstream: Array<UpstreamCall> = []
const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  manualApprove: state.manualApprove,
  models: state.models,
}

function catalogModel(
  id: string,
  endpoints: Array<string>,
  options: { family: string; reasoningEfforts?: Array<string> },
): Model {
  const { family, reasoningEfforts } = options
  return {
    id,
    name: id,
    object: "model",
    preview: false,
    vendor: family === "claude" ? "anthropic" : "openai",
    version: "1",
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family,
      limits: { max_output_tokens: 64000 },
      object: "model_capabilities",
      supports: reasoningEfforts ? { reasoning_effort: reasoningEfforts } : {},
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

function responsesResult(): Record<string, unknown> {
  return {
    id: "resp_omit",
    object: "response",
    created_at: 1,
    model: RESPONSES_MODEL,
    output: [
      {
        id: "msg_omit",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    output_text: "ok",
    status: "completed",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
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
}

function upstreamResponse(call: UpstreamCall): Response {
  if (call.path.endsWith("/v1/messages")) {
    return Response.json({
      id: "msg_omit",
      type: "message",
      role: "assistant",
      model: HAIKU,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
  if (call.path.endsWith("/responses")) return Response.json(responsesResult())
  return Response.json({
    id: "chatcmpl_omit",
    object: "chat.completion",
    created: 1,
    model: String(call.body.model),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

async function requestBody(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  let text = ""
  if (typeof init?.body === "string") text = init.body
  else if (input instanceof Request) text = await input.clone().text()
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

beforeEach(() => {
  upstream.length = 0
  setConfigForTest(null)
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = {
    object: "list",
    data: [
      catalogModel(HAIKU, ["/v1/messages"], {
        family: "claude",
        reasoningEfforts: ["low", "medium", "high"],
      }),
      catalogModel(CLAUDE_CHAT_ONLY, ["/chat/completions"], {
        family: "claude",
      }),
      catalogModel(CHAT_MODEL, ["/chat/completions"], { family: "gpt" }),
      catalogModel(RESPONSES_MODEL, ["/responses"], { family: "gpt" }),
      catalogModel(EFFORT_MODEL, ["/chat/completions"], { family: "gpt" }),
    ],
  } satisfies ModelsResponse
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input)
    const call = {
      path: new URL(url).pathname,
      body: await requestBody(input, init),
    }
    upstream.push(call)
    return upstreamResponse(call)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  setConfigForTest(null)
  setModelSettingsForTest([])
})

function omitFor(...models: Array<string>): void {
  setModelSettingsForTest(
    models.map((model) => ({ model, omitReasoningEffort: true })),
  )
}

async function post(path: string, body: unknown): Promise<Response> {
  await seedProtocolDatabase()
  return server.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function lastUpstream(path: string): Record<string, unknown> {
  const call = upstream.findLast((entry) => entry.path.endsWith(path))
  if (!call) throw new Error(`Expected an upstream ${path} request`)
  return call.body
}

test("a Codex Responses turn bridged to Claude Messages sends no output_config", async () => {
  omitFor(HAIKU)

  const response = await post("/v1/responses", {
    model: HAIKU,
    instructions: "You are a coding agent.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "List the files." }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "shell",
        description: "Run a command.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        strict: false,
      },
    ],
    tool_choice: "auto",
    reasoning: { effort: "xhigh", summary: "auto" },
    stream: false,
  })

  expect(response.status).toBe(200)
  const sent = lastUpstream("/v1/messages")
  expect(sent.model).toBe(HAIKU)
  expect(sent.tool_choice).toEqual({ type: "auto" })
  expect(sent).not.toHaveProperty("output_config")
})

test("native Messages keep the output format and drop every effort control", async () => {
  omitFor(HAIKU)
  const format = {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  }

  const response = await post("/v1/messages", {
    model: HAIKU,
    max_tokens: 64,
    messages: [
      { role: "user", content: "Return JSON." },
      {
        role: "system",
        content: "Answer briefly.",
        output_config: { effort: "high" },
      },
    ],
    output_config: { effort: "max", format },
  })

  expect(response.status).toBe(200)
  const sent = lastUpstream("/v1/messages")
  expect(sent.output_config).toEqual({ format })
  expect(JSON.stringify(sent)).not.toContain('"effort"')
  expect(JSON.stringify(sent.messages)).toContain("Answer briefly.")
})

test("a model without Omit still receives the client's effort", async () => {
  const response = await post("/v1/messages", {
    model: HAIKU,
    max_tokens: 64,
    messages: [{ role: "user", content: "Hello" }],
    output_config: { effort: "high" },
  })

  expect(response.status).toBe(200)
  expect(lastUpstream("/v1/messages").output_config).toEqual({
    effort: "high",
  })
})

test("Messages translated to Chat Completions send no reasoning_effort", async () => {
  omitFor(CLAUDE_CHAT_ONLY)

  const response = await post("/v1/messages", {
    model: CLAUDE_CHAT_ONLY,
    max_tokens: 4096,
    thinking: { type: "enabled", budget_tokens: 2048 },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "Hello" }],
  })

  expect(response.status).toBe(200)
  expect(lastUpstream("/chat/completions")).not.toHaveProperty(
    "reasoning_effort",
  )
})

test.each([
  {
    name: "body effort",
    model: CHAT_MODEL,
    extra: { reasoning_effort: "high" },
  },
  { name: "model suffix", model: `${CHAT_MODEL}:high`, extra: {} },
])(
  "Chat Completions with a $name send no reasoning_effort",
  async ({ model, extra }) => {
    omitFor(CHAT_MODEL)

    const response = await post("/v1/chat/completions", {
      model,
      messages: [{ role: "user", content: "Hello" }],
      ...extra,
    })

    expect(response.status).toBe(200)
    const sent = lastUpstream("/chat/completions")
    expect(sent.model).toBe(CHAT_MODEL)
    expect(sent).not.toHaveProperty("reasoning_effort")
  },
)

test("Responses drop the effort, keep the client's summary, and add no reasoning defaults", async () => {
  omitFor(RESPONSES_MODEL)

  const withReasoning = await post("/v1/responses", {
    model: RESPONSES_MODEL,
    input: "Hello",
    reasoning: { effort: "high", summary: "auto" },
  })
  expect(withReasoning.status).toBe(200)
  expect(lastUpstream("/responses").reasoning).toEqual({ summary: "auto" })

  const withoutReasoning = await post("/v1/responses", {
    model: RESPONSES_MODEL,
    input: "Hello",
  })
  expect(withoutReasoning.status).toBe(200)
  expect(lastUpstream("/responses")).not.toHaveProperty("reasoning")
})

test("Omit hides effort levels and virtual effort models even when Copilot advertises them", async () => {
  setModelSettingsForTest([
    { model: HAIKU, omitReasoningEffort: true },
    {
      model: EFFORT_MODEL,
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
    },
  ])

  expect(getModelReasoningConfig(HAIKU)).toBeUndefined()
  await seedProtocolDatabase()
  const response = await server.request("/v1/models", {
    headers: { authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}` },
  })
  expect(response.status).toBe(200)
  const { data } = (await response.json()) as {
    data: Array<{ id: string; thinking?: unknown }>
  }
  const ids = data.map((model) => model.id)
  expect(ids).toContain(HAIKU)
  expect(ids.filter((id) => id.startsWith(`${HAIKU}:`))).toEqual([])
  expect(data.find((model) => model.id === HAIKU)).not.toHaveProperty(
    "thinking",
  )
  expect(ids).toContain(`${EFFORT_MODEL}:low`)
  expect(ids).toContain(`${EFFORT_MODEL}:high`)
})

test("Omit overrides a custom provider that passes reasoning effort", async () => {
  setConfigForTest({
    customProviders: [
      {
        id: "effort-provider",
        name: "Effort Provider",
        type: "openai-compatible",
        baseUrl: "https://effort.example/v1",
        apiKey: "effort-key",
        passReasoningEffort: true,
        models: [{ id: CUSTOM_MODEL, kind: "chat" }],
      },
    ],
  })
  omitFor(CUSTOM_MODEL)
  const reference = resolveCustomProviderModel({
    model: CUSTOM_MODEL,
    kind: "chat",
  })
  if (!reference) throw new Error("Expected the custom model to resolve")

  await createCustomProviderChatCompletions(
    reference,
    {
      model: CUSTOM_MODEL,
      messages: [{ role: "user", content: "Hello" }],
      reasoning_effort: "high",
    },
    { reasoningEffort: "high" },
  )

  const sent = lastUpstream("/chat/completions")
  expect(sent.model).toBe(CUSTOM_MODEL)
  expect(sent).not.toHaveProperty("reasoning_effort")
})
