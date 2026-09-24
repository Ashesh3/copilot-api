import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/routes/messages/anthropic-types"
import type { ModelsResponse } from "~/services/copilot/get-models"

import { setModelRedirectsForTest } from "~/lib/model-redirect"
import { setModelSettingsForTest } from "~/lib/model-settings"
import { state } from "~/lib/state"
import { server } from "~/server"
import { createAnthropicMessages } from "~/services/copilot/create-anthropic-messages"
import { prepareAnthropicMessagesRequest } from "~/services/copilot/messages-contract"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

interface WireTool {
  name: string
  input_schema: Record<string, unknown>
}

interface WireBody extends Record<string, unknown> {
  model: string
  messages: Array<{ role: string; content: unknown }>
  tools?: Array<WireTool>
  tool_choice?: { type: string; name?: string }
}

const captures: Array<{ path: string; body: WireBody }> = []
const originalFetch = globalThis.fetch
const originalModels = state.models
const callInput = { mode: "echo", value: "hello" }
const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-opus-5.5",
      name: "Claude Opus 5.5",
      object: "model",
      version: "1",
      supported_endpoints: ["/v1/messages"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

function unionSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {},
    oneOf: [{ $ref: "#/$defs/echo" }, { $ref: "#/$defs/count" }],
    $defs: {
      echo: {
        type: "object",
        properties: {
          mode: { const: "echo" },
          value: { type: "string", pattern: "^hello$" },
        },
        required: ["mode", "value"],
        additionalProperties: false,
      },
      count: {
        type: "object",
        properties: {
          mode: { const: "count" },
          value: { type: "integer", minimum: 1 },
        },
        required: ["mode", "value"],
        additionalProperties: false,
      },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolvePointer(
  schema: Record<string, unknown>,
  pointer: unknown,
): unknown {
  if (typeof pointer !== "string" || !pointer.startsWith("#/")) return undefined
  let value: unknown = schema
  for (const token of pointer.slice(2).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~")
    if (!isRecord(value) && !Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function physicalSchemaProblem(
  schema: Record<string, unknown>,
): string | undefined {
  if (["oneOf", "allOf", "anyOf"].some((key) => key in schema)) {
    return "input_schema does not support oneOf, allOf, or anyOf at the top level"
  }
  const inner = resolvePointer(schema, schema.$ref)
  if (
    !isRecord(inner)
    || !Array.isArray(inner.oneOf)
    || inner.oneOf.length !== 2
  ) {
    return "Original alternatives were lost"
  }
  for (const branch of inner.oneOf) {
    const target =
      isRecord(branch) ? resolvePointer(schema, branch.$ref) : undefined
    if (
      !isRecord(target)
      || !isRecord(target.properties)
      || target.additionalProperties !== false
      || !Array.isArray(target.required)
    ) {
      return "Original alternative references or restrictions were lost"
    }
  }
  return undefined
}

function upstreamResponse(body: WireBody): AnthropicResponse {
  const hasResult = body.messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some(
        (block: unknown) => isRecord(block) && block.type === "tool_result",
      ),
  )
  return {
    id: hasResult ? "msg_schema_done" : "msg_schema_call",
    type: "message",
    role: "assistant",
    model: body.model,
    content:
      hasResult ?
        [{ type: "text", text: "hello" }]
      : [
          {
            type: "tool_use",
            id: "toolu_schema",
            name: body.tools?.[0].name ?? "missing_tool",
            input: callInput,
          },
        ],
    stop_reason: hasResult ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4 },
  }
}

beforeAll(() => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input))
      .pathname
    if (typeof init?.body !== "string")
      throw new TypeError("Expected JSON body")
    const body = JSON.parse(init.body) as WireBody
    captures.push({ path, body })
    if (path !== "/v1/messages" && path !== "/v1/messages/count_tokens") {
      return Promise.resolve(
        new Response("Unexpected upstream route", { status: 400 }),
      )
    }
    for (const tool of body.tools ?? []) {
      const problem = physicalSchemaProblem(tool.input_schema)
      if (problem)
        return Promise.resolve(
          Response.json(
            {
              type: "error",
              error: { type: "invalid_request_error", message: problem },
            },
            { status: 400 },
          ),
        )
    }
    return Promise.resolve(
      Response.json(
        path.endsWith("count_tokens") ?
          { input_tokens: 17 }
        : upstreamResponse(body),
      ),
    )
  }) as typeof fetch
})

beforeEach(async () => {
  captures.length = 0
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "synthetic-copilot-token",
    githubToken: "synthetic-github-token",
    isMultiToken: false,
    manualApprove: false,
    models,
  })
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
  await seedProtocolDatabase()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  state.models = originalModels
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

function sourceMessages(): AnthropicMessagesPayload {
  return {
    model: "claude-opus-5.5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Echo hello." }],
    tools: [{ name: "automation_update", input_schema: unionSchema() }],
    tool_choice: { type: "tool", name: "automation_update" },
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  return await server.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function checkWire(index: number, name: string): void {
  const tool = captures[index].body.tools?.[0]
  expect(tool?.name).toBe(name)
  expect(physicalSchemaProblem(tool?.input_schema ?? {})).toBeUndefined()
  const schema = tool?.input_schema ?? {}
  const inner = resolvePointer(schema, schema.$ref) as Record<string, unknown>
  const alternatives = inner.oneOf as Array<{ $ref: string }>
  expect(resolvePointer(schema, alternatives[0].$ref)).toMatchObject({
    properties: { mode: { const: "echo" }, value: { pattern: "^hello$" } },
    required: ["mode", "value"],
    additionalProperties: false,
  })
}

test.each([
  { name: "ordinary", options: {} },
  { name: "alreadyAdapted", options: { alreadyAdapted: true } },
])(
  "normalizes root union on the $name Messages transport without mutating prepared input",
  async ({ options }) => {
    const source = sourceMessages()
    const snapshot = structuredClone(source)
    const prepared = prepareAnthropicMessagesRequest({ payload: source })
    expect(prepared.body.tools?.[0].input_schema).toEqual(
      source.tools?.[0].input_schema,
    )

    const result = (await createAnthropicMessages(
      prepared.body,
      options,
    )) as AnthropicResponse

    checkWire(0, "automation_update")
    expect(captures[0].body.tool_choice).toEqual({
      type: "tool",
      name: "automation_update",
    })
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "toolu_schema",
        name: "automation_update",
        input: callInput,
      },
    ])
    expect(source).toEqual(snapshot)
    expect(prepared.body.tools?.[0].input_schema).toEqual(
      source.tools?.[0].input_schema,
    )
  },
)

test("public Messages keeps a normalized union tool callable across its result continuation", async () => {
  const source = sourceMessages()
  const first = await post("/v1/messages", source)
  expect(first.status).toBe(200)
  const message = (await first.json()) as AnthropicResponse
  checkWire(0, "automation_update")
  expect(message.content[0]).toMatchObject({
    type: "tool_use",
    name: "automation_update",
    input: callInput,
  })

  const second = await post("/v1/messages", {
    ...source,
    messages: [
      ...source.messages,
      { role: "assistant", content: message.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_schema",
            content: "hello",
          },
        ],
      },
    ],
  })

  expect(second.status).toBe(200)
  expect(await second.json()).toHaveProperty("content.0.text", "hello")
  checkWire(1, "automation_update")
  expect(JSON.stringify(captures[1].body.messages)).toContain(
    '"input":{"mode":"echo","value":"hello"}',
  )
  expect(JSON.stringify(captures[1].body.messages)).toContain(
    '"tool_use_id":"toolu_schema"',
  )
})

test("public count_tokens normalizes tool root unions at the physical boundary", async () => {
  const response = await post("/v1/messages/count_tokens", sourceMessages())

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 17 })
  expect(captures[0].path).toBe("/v1/messages/count_tokens")
  expect(captures[0].body).not.toHaveProperty("max_tokens")
  checkWire(0, "automation_update")
})

test("Responses additional_tools preserves namespace identity and exact arguments through native union normalization", async () => {
  const source = {
    model: "claude-opus-5.5",
    max_output_tokens: 1024,
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "automation",
            tools: [
              { type: "function", name: "update", parameters: unionSchema() },
            ],
          },
        ],
      },
      { role: "user", content: "Echo hello." },
    ],
    tool_choice: { type: "function", namespace: "automation", name: "update" },
  }
  const first = await post("/v1/responses", source)
  expect(first.status).toBe(200)
  const result = (await first.json()) as {
    output: Array<Record<string, unknown>>
  }
  const call = result.output.find((item) => item.type === "function_call")
  expect(call).toMatchObject({
    namespace: "automation",
    name: "update",
    call_id: "toolu_schema",
    arguments: '{"mode":"echo","value":"hello"}',
  })
  const wireName = captures[0].body.tools?.[0].name ?? ""
  checkWire(0, wireName)
  expect(captures[0].body.tool_choice).toEqual({ type: "tool", name: wireName })

  const second = await post("/v1/responses", {
    ...source,
    input: [
      ...source.input,
      ...result.output,
      {
        type: "function_call_output",
        call_id: "toolu_schema",
        output: "hello",
      },
    ],
    tool_choice: "none",
  })

  expect(second.status).toBe(200)
  expect(await second.json()).toHaveProperty("output_text", "hello")
  checkWire(1, wireName)
  expect(JSON.stringify(captures[1].body.messages)).toContain(
    '"input":{"mode":"echo","value":"hello"}',
  )
})

test("Chat to Messages preserves the function name and arguments while normalizing its union schema", async () => {
  const response = await post("/v1/chat/completions", {
    model: "claude-opus-5.5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Echo hello." }],
    tools: [
      {
        type: "function",
        function: { name: "automation_update", parameters: unionSchema() },
      },
    ],
    tool_choice: { type: "function", function: { name: "automation_update" } },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toHaveProperty(
    "choices.0.message.tool_calls.0.function",
    {
      name: "automation_update",
      arguments: '{"mode":"echo","value":"hello"}',
    },
  )
  checkWire(0, "automation_update")
  expect(captures[0].body.tool_choice).toEqual({
    type: "tool",
    name: "automation_update",
  })
})
