import { afterEach, beforeEach, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { server } from "~/server"

import {
  PROTOCOL_GATEWAY_KEY,
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()
const originalFetch = globalThis.fetch
const originalState = { ...state }
let sends = 0

beforeEach(() => {
  sends = 0
  state.apiKeyAuth = PROTOCOL_GATEWAY_KEY
  state.copilotToken = "fixture-token"
  state.githubToken = "fixture-github"
  state.isMultiToken = false
  state.manualApprove = false
  globalThis.fetch = (() => {
    sends++
    return Promise.resolve(
      Response.json({
        id: "fixture",
        object: "chat.completion",
        model: "mixed-fixture",
        created: 1,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "unexpected dispatch" },
          },
        ],
        content: [{ type: "text", text: "unexpected dispatch" }],
        stop_reason: "end_turn",
        output: [],
      }),
    )
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
})

const cases = [
  {
    route: "/v1/chat/completions",
    body: {
      model: "mixed-fixture",
      messages: [{ role: "user", content: "Search and ask for weather" }],
      tools: [
        { type: "web_search" },
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    },
  },
  {
    route: "/v1beta/models/mixed-fixture:generateContent",
    body: {
      contents: [
        { role: "user", parts: [{ text: "Search and ask for weather" }] },
      ],
      tools: [
        { googleSearch: { max_uses: 2 } },
        {
          functionDeclarations: [
            {
              name: "get_weather",
              parameters: { type: "OBJECT", properties: {} },
            },
          ],
        },
      ],
    },
  },
  {
    route: "/v1/messages",
    body: {
      model: "mixed-fixture",
      max_tokens: 100,
      messages: [{ role: "user", content: "Search and ask for weather" }],
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 2 },
        {
          name: "get_weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
    },
  },
]

for (const endpoint of ["/chat/completions", "/responses", "/v1/messages"])
  test.each(cases)(
    `$route rejects explicit managed mixed tools before ${endpoint} dispatch`,
    async ({ route, body }) => {
      state.models = {
        object: "list",
        data: [
          {
            id: "mixed-fixture",
            name: "Mixed",
            object: "model",
            version: "1",
            vendor: "test",
            supported_endpoints: [endpoint],
            capabilities: {
              family: "test",
              object: "model_capabilities",
              supports: { tool_calls: true },
              limits: { max_output_tokens: 1024 },
              tokenizer: "cl100k_base",
              type: "chat",
            },
          },
        ],
      }
      await seedProtocolDatabase()
      const response = await server.request(route, {
        method: "POST",
        headers: {
          authorization: `Bearer ${PROTOCOL_GATEWAY_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: "unsupported_web_tool_combination" },
      })
      expect(sends).toBe(0)
    },
  )
