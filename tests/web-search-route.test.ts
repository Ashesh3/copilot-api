import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

import { setModelRedirectsForTest } from "../src/lib/model-redirect"
import { setModelSettingsForTest } from "../src/lib/model-settings"
import { state } from "../src/lib/state"
import { server } from "../src/server"
import { resetWebSearchSessionsForTest } from "../src/services/copilot/mcp-web-search"

const originalFetch = globalThis.fetch
const chatRequests: Array<Record<string, unknown>> = []
const mcpHeaders: Array<Headers> = []

const models: ModelsResponse = {
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
      supported_endpoints: ["/chat/completions", "/v1/messages"],
      capabilities: {
        family: "claude",
        limits: { max_output_tokens: 1024 },
        object: "model_capabilities",
        supports: { tool_calls: true },
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

const fetchMock = mock((url: string, init?: RequestInit) => {
  const path = new URL(url).pathname
  const body =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as Record<string, unknown>)
    : {}

  if (path === "/mcp/readonly") {
    mcpHeaders.push(new Headers(init?.headers))
    if (body.method === "initialize") {
      return new Response(
        'data: {"jsonrpc":"2.0","id":"init","result":{}}\n\n',
        {
          headers: {
            "content-type": "text/event-stream",
            "Mcp-Session-Id": "route-session",
          },
        },
      )
    }
    return new Response(
      'data: {"jsonrpc":"2.0","id":"search","result":{"content":[{"type":"text","text":"{\\"type\\":\\"output_text\\",\\"text\\":{\\"value\\":\\"July 14, 2026 [Source](https://example.com)\\",\\"annotations\\":[]}}"}]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    )
  }

  if (path === "/chat/completions") {
    chatRequests.push(body)
    if (chatRequests.length === 1) {
      return jsonResponse({
        id: "chat-search",
        object: "chat.completion",
        created: 1,
        model: "claude-sonnet-4.6",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "search-call",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: '{"query":"today UTC date"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
      })
    }
    return jsonResponse({
      id: "chat-final",
      object: "chat.completion",
      created: 2,
      model: "claude-sonnet-4.6",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Today is July 14, 2026 ([Source](https://example.com)).",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    })
  }

  return new Response("unexpected upstream path", { status: 500 })
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
  chatRequests.length = 0
  mcpHeaders.length = 0
  resetWebSearchSessionsForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
  state.models = models
  setModelRedirectsForTest([])
  setModelSettingsForTest([])
})

test("Claude web search completes through Copilot MCP without leaking a tool call", async () => {
  const response = await server.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4.6",
      max_tokens: 512,
      messages: [{ role: "user", content: "What is today's UTC date?" }],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 2,
        },
      ],
      tool_choice: { type: "tool", name: "web_search" },
    }),
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    content: Array<{ type: string; text?: string }>
    stop_reason: string
  }
  expect(body).toMatchObject({ stop_reason: "end_turn" })
  expect(body.content).toEqual([
    {
      type: "text",
      text: "Today is July 14, 2026 ([Source](https://example.com)).",
    },
  ])
  expect(chatRequests).toHaveLength(2)
  const tools = chatRequests[0]?.tools as
    | Array<{ type?: string; function?: { name?: string } }>
    | undefined
  expect(tools?.[0]?.type).toBe("function")
  expect(tools?.[0]?.function?.name).toBe("web_search")
  expect(chatRequests[0]?.parallel_tool_calls).toBe(false)
  expect(chatRequests[1]?.tool_choice).toBe("auto")
  expect(chatRequests[1]?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "search-call",
      }),
    ]),
  )
  expect(mcpHeaders[0]?.get("x-mcp-tools")).toBe("web_search")
  expect(mcpHeaders[0]?.get("x-mcp-host")).toBe("copilot-cli")
})
