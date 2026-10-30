import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import { resetExtendedCacheTtlRefusalForTest } from "../src/services/copilot/extended-cache-ttl"
import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const upstreamBodies: Array<string> = []

const models: ModelsResponse = {
  object: "list",
  data: [
    {
      id: "claude-cache-model",
      name: "Claude Cache Model",
      object: "model",
      preview: false,
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      supported_endpoints: ["/v1/messages"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 4096 },
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    },
  ],
}

// Copilot refuses long-lived prompt caching for accounts without it.
const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? init.body : ""
  upstreamBodies.push(body)
  if (body.includes('"ttl":"1h"')) {
    return Response.json(
      {
        error: {
          message:
            "Long-lived prompt caching (cache_control with a ttl other than 5m) is not supported.",
          code: "unsupported_value",
        },
      },
      { status: 400 },
    )
  }
  return Response.json({
    id: "msg_cache",
    type: "message",
    role: "assistant",
    model: "claude-cache-model",
    content: [{ type: "text", text: "cached" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 1 },
  })
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  upstreamBodies.length = 0
  resetExtendedCacheTtlRefusalForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = models
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

afterEach(() => {
  resetExtendedCacheTtlRefusalForTest()
})

async function postMessages(): Promise<Response> {
  return await server.request("/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-cache-model",
      max_tokens: 64,
      system: [
        {
          type: "text",
          text: "Instructions.",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      ],
    }),
  })
}

test("falls back to the default cache lifetime once Copilot refuses 1h", async () => {
  await seedProtocolDatabase()
  const first = await postMessages()
  const second = await postMessages()

  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(await second.json()).toMatchObject({
    content: [{ type: "text", text: "cached" }],
  })
  expect(upstreamBodies.map((body) => body.includes('"ttl":"1h"'))).toEqual([
    true,
    false,
    false,
  ])
  for (const body of upstreamBodies.slice(1)) {
    expect(body).toContain('"ttl":"5m"')
  }
})
