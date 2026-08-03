import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import {
  getRoutingAffinity,
  type RoutingAffinity,
} from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { server } from "~/server"

const originalFetch = globalThis.fetch
const originalModels = state.models
let capturedAffinity: RoutingAffinity | undefined

const fetchMock = mock(() => {
  capturedAffinity = getRoutingAffinity()
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
) {
  return server.request("/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "gpt-compact",
      input: [],
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
