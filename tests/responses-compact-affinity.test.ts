import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ResponseInputItem } from "~/services/copilot/create-responses"

import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { server } from "~/server"
import { COMPACTION_PAYLOAD_MAX_BYTES } from "~/services/copilot/compaction-payload"

const originalFetch = globalThis.fetch
const originalModels = state.models
let capturedAffinity: RoutingAffinity | undefined
let lastRequestBody: Record<string, unknown> | undefined
let lastRequestUrl: string | undefined

const fetchMock = mock((url: string, init?: RequestInit) => {
  capturedAffinity = getRoutingAffinity()
  lastRequestUrl = url
  lastRequestBody =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : undefined
  if (url.endsWith("/chat/completions")) {
    return Response.json({
      id: "chatcmpl_compact",
      object: "chat.completion",
      created: 1,
      model: "gpt-compact",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "summary" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    })
  }
  return Response.json({
    id: "resp_compact",
    object: "response",
    model: "gpt-compact",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "summary" }],
      },
    ],
    usage: null,
  })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  state.models = originalModels
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  capturedAffinity = undefined
  lastRequestBody = undefined
  lastRequestUrl = undefined
  fetchMock.mockClear()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.isMultiToken = false
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-compact",
        name: "gpt-compact",
        object: "model",
        version: "test",
        vendor: "openai",
        preview: false,
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
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
  }
})

function compactRequest(
  clientMetadata: unknown,
  headers: Record<string, string> = {},
  input: Array<ResponseInputItem> = [],
) {
  return server.request("/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "gpt-compact",
      input,
      prompt_cache_key: "must-not-be-affinity",
      client_metadata: clientMetadata,
    }),
  })
}

test("compact installs metadata affinity and preserves header precedence", async () => {
  expect((await compactRequest({ session_id: "compact-body" })).status).toBe(
    200,
  )
  expect(capturedAffinity).toEqual({
    key: "compact-body",
    source: "codex_metadata",
  })

  await compactRequest(
    { session_id: "compact-conflict" },
    { "x-client-session-id": "compact-header" },
  )
  expect(capturedAffinity).toEqual({
    key: "compact-header",
    source: "copilot_session",
  })

  await compactRequest("not json")
  expect(capturedAffinity).toBeUndefined()
})

test("compact fits oversized tool results before summary generation", async () => {
  const oversizedOutput =
    "BEGIN-COMPACT\n"
    + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
    + "\nEND-COMPACT"

  const response = await compactRequest(
    { session_id: "compact-oversized" },
    {},
    [
      {
        type: "custom_tool_call",
        call_id: "call_compact",
        name: "exec",
        input: "run compact diagnostic",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_compact",
        output: oversizedOutput,
      },
    ],
  )

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const serialized = JSON.stringify(lastRequestBody)
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    COMPACTION_PAYLOAD_MAX_BYTES,
  )
  expect(serialized).toContain("run compact diagnostic")
  expect(serialized).toContain("call_compact")
  expect(serialized).toContain("BEGIN-COMPACT")
  expect(serialized).toContain("END-COMPACT")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
  expect(oversizedOutput).toEndWith("END-COMPACT")
})

test("compact fits and preserves custom tool context on ChatCompletions fallback", async () => {
  const model = state.models?.data[0]
  if (model) model.supported_endpoints = []
  const oversizedOutput =
    "BEGIN-FALLBACK\n"
    + "x".repeat(COMPACTION_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024)
    + "\nEND-FALLBACK"

  const response = await compactRequest(
    { session_id: "compact-fallback" },
    {},
    [
      {
        type: "custom_tool_call",
        call_id: "call_fallback",
        name: "exec",
        input: "run fallback diagnostic",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_fallback",
        output: oversizedOutput,
      },
    ],
  )

  expect(response.status).toBe(200)
  expect(lastRequestUrl).toEndWith("/chat/completions")
  const serialized = JSON.stringify(lastRequestBody)
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
    COMPACTION_PAYLOAD_MAX_BYTES,
  )
  expect(serialized).toContain("run fallback diagnostic")
  expect(serialized).toContain("call_fallback")
  expect(serialized).toContain("BEGIN-FALLBACK")
  expect(serialized).toContain("END-FALLBACK")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
})
