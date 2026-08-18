import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { state } from "~/lib/state"
import { resolveNativeWebSearch } from "~/routes/messages/native-handler"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"

const originalFetch = globalThis.fetch
const nativeHeaders: Array<Headers> = []
let nativeAttempt = 0

function jsonResponse(body: unknown): Response {
  return Response.json(body)
}

const fetchMock = mock(
  (url: string | URL | Request, init?: RequestInit): Response => {
    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url
    const path = new URL(rawUrl).pathname
    const body =
      typeof init?.body === "string" ?
        (JSON.parse(init.body) as Record<string, unknown>)
      : {}

    if (path === "/mcp/readonly") {
      if (body.method === "initialize") {
        return new Response(
          'data: {"jsonrpc":"2.0","id":"init","result":{}}\n\n',
          {
            headers: {
              "content-type": "text/event-stream",
              "Mcp-Session-Id": "native-header-session",
            },
          },
        )
      }
      return new Response(
        'data: {"jsonrpc":"2.0","id":"search","result":{"content":[{"type":"text","text":"{\\"type\\":\\"output_text\\",\\"text\\":{\\"value\\":\\"current result\\",\\"annotations\\":[]}}"}]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    }

    if (path !== "/v1/messages") {
      return new Response("unexpected upstream path", { status: 500 })
    }

    nativeHeaders.push(new Headers(init?.headers))
    nativeAttempt += 1
    if (nativeAttempt === 1) {
      return jsonResponse({
        id: "msg_search",
        type: "message",
        role: "assistant",
        model: "claude-current",
        content: [
          {
            type: "tool_use",
            id: "toolu_search",
            name: "web_search",
            input: { query: "current facts" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }

    return jsonResponse({
      id: "msg_final",
      type: "message",
      role: "assistant",
      model: "claude-current",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    })
  },
)

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(() => {
  fetchMock.mockClear()
  nativeHeaders.length = 0
  nativeAttempt = 0
  resetWebSearchSessionsForTest()
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
})

test("preserves explicit native header options across every web-search iteration", async () => {
  const payload: AnthropicMessagesPayload = {
    model: "claude-current",
    max_tokens: 64,
    messages: [{ role: "user", content: "Search current facts." }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 2,
      },
    ],
  }

  const response = await resolveNativeWebSearch(payload, {
    anthropicBeta: " beta-one, beta-two, beta-one ",
    anthropicVersion: "2023-06-01",
    modelProviderPreference: "anthropic",
    requestedModel: "requested-alias",
    signal: new AbortController().signal,
  })

  expect(response.id).toBe("msg_final")
  expect(nativeHeaders).toHaveLength(2)
  for (const headers of nativeHeaders) {
    expect(headers.get("anthropic-beta")).toBe("beta-one,beta-two")
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(headers.get("x-model-provider-preference")).toBe("anthropic")
  }
})
