import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { chatCompletionsToResponses } from "../src/routes/chat-completions/responses-fallback"
import { translateGoogleToOpenAI } from "../src/routes/google-ai/request-translation"
import { translateToOpenAI } from "../src/routes/messages/non-stream-translation"
import { resolveWebSearchCalls } from "../src/routes/messages/web-search-helpers"
import { convertWebSearchTool } from "../src/routes/responses/handler"
import {
  buildWebSearchQuery,
  createWebSearchFunctionTool,
  executeWebSearch,
  resetWebSearchSessionsForTest,
} from "../src/services/copilot/mcp-web-search"

const originalFetch = globalThis.fetch
type BunTimeoutRequestInit = RequestInit & { timeout?: boolean | number }
const fetchMock = mock((_url: string, init?: RequestInit) => {
  const body = JSON.parse(
    typeof init?.body === "string" ? init.body : "{}",
  ) as { method?: string }
  if (body.method === "initialize") {
    return new Response(
      'data: {"jsonrpc":"2.0","id":"init","result":{"protocolVersion":"2025-03-26"}}\n\n',
      {
        headers: {
          "content-type": "text/event-stream",
          "Mcp-Session-Id": "session-1",
        },
      },
    )
  }

  return new Response(
    'data: {"jsonrpc":"2.0","id":"call","result":{"content":[{"type":"text","text":"{\\"type\\":\\"output_text\\",\\"text\\":{\\"value\\":\\"Grounded answer [Source](https://example.com)\\",\\"annotations\\":[]}}"}]}}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  )
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
  resetWebSearchSessionsForTest()
  state.accountType = "individual"
  state.githubToken = "github-token"
  state.isMultiToken = false
})

test("uses the current Copilot CLI MCP web-search contract and reuses its session", async () => {
  await executeWebSearch("first query")
  await executeWebSearch("second query")

  expect(fetchMock).toHaveBeenCalledTimes(3)
  const initialize = fetchMock.mock.calls[0]?.[1] as RequestInit
  const firstCall = fetchMock.mock.calls[1]?.[1] as RequestInit
  const secondCall = fetchMock.mock.calls[2]?.[1] as RequestInit
  const initializeHeaders = new Headers(initialize.headers)
  const firstHeaders = new Headers(firstCall.headers)
  const secondHeaders = new Headers(secondCall.headers)

  expect(initializeHeaders.get("x-mcp-host")).toBe("copilot-cli")
  expect(initializeHeaders.get("x-mcp-tools")).toBe("web_search")
  expect(initializeHeaders.get("x-mcp-toolsets")).toBeNull()
  expect(initializeHeaders.get("copilot-integration-id")).toBeNull()
  expect(firstHeaders.get("mcp-session-id")).toBe("session-1")
  expect(secondHeaders.get("mcp-session-id")).toBe("session-1")
  expect(initialize.keepalive).toBe(false)
  expect(firstCall.keepalive).toBe(false)
  expect(secondCall.keepalive).toBe(false)
  expect((initialize as BunTimeoutRequestInit).timeout).toBeUndefined()
  expect((firstCall as BunTimeoutRequestInit).timeout).toBeUndefined()
  expect((secondCall as BunTimeoutRequestInit).timeout).toBeUndefined()
})

test("replaces the MCP idle timeout only when caller cancellation exists", async () => {
  const controller = new AbortController()

  await executeWebSearch("signal query", controller.signal)

  const initialize = fetchMock.mock.calls[0]?.[1] as BunTimeoutRequestInit
  const toolCall = fetchMock.mock.calls[1]?.[1] as BunTimeoutRequestInit
  expect(initialize.keepalive).toBe(false)
  expect(initialize.timeout).toBeUndefined()
  expect(toolCall.keepalive).toBe(false)
  expect(toolCall.timeout).toBe(false)
})

test("converts Anthropic versioned web search and preserves domain constraints", () => {
  const translated = translateToOpenAI({
    model: "claude-sonnet-4.6",
    messages: [{ role: "user", content: "Search for current docs." }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        allowed_domains: ["docs.example.com"],
      } as never,
    ],
  })

  const tool = translated.tools?.[0]
  expect(tool?.type).toBe("function")
  expect(tool?.function.name).toBe("web_search")
  expect(tool?.function.description).toContain("docs.example.com")
  expect(buildWebSearchQuery('{"query":"latest release"}', tool)).toContain(
    "Only use sources from: docs.example.com",
  )
})

test("keeps native Responses web search but converts it on Chat fallback", () => {
  const payload = {
    model: "gpt-5.4",
    input: "Search the web",
    tools: [
      {
        type: "web_search",
        external_web_access: true,
        filters: { allowed_domains: ["example.com"] },
      },
    ],
  }

  expect(payload.tools[0]?.type).toBe("web_search")
  convertWebSearchTool(payload)
  expect(payload.tools[0]?.type).toBe("function")
  expect((payload.tools[0] as { name?: string }).name).toBe("web_search")
})

test("translates Gemini googleSearch into the shared web-search function", () => {
  const translated = translateGoogleToOpenAI(
    {
      contents: [{ role: "user", parts: [{ text: "What changed today?" }] }],
      tools: [{ googleSearch: {} }],
    },
    "gemini-test",
    false,
  )

  expect(translated.tools?.[0]?.function.name).toBe("web_search")
  expect(translated.parallel_tool_calls).toBe(false)
})

test("promotes supported search options to hosted Responses and keeps blocklists on MCP", () => {
  const basePayload = {
    model: "gpt-5.4",
    messages: [{ role: "user" as const, content: "Search." }],
  }
  const hosted = chatCompletionsToResponses({
    ...basePayload,
    tools: [createWebSearchFunctionTool({ allowed_domains: ["example.com"] })],
  })
  const fallback = chatCompletionsToResponses({
    ...basePayload,
    tools: [
      createWebSearchFunctionTool({ blocked_domains: ["blocked.example"] }),
    ],
  })

  expect(hosted.tools?.[0]).toEqual({
    type: "web_search",
    filters: { allowed_domains: ["example.com"] },
  })
  expect(fallback.tools?.[0]).toMatchObject({
    type: "function",
    name: "web_search",
  })
})

test("executes MCP web search and feeds the result back to the same model loop", async () => {
  const initial: ChatCompletionResponse = {
    id: "chat-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "web_search",
                arguments: '{"query":"current answer"}',
              },
            },
          ],
        },
        logprobs: null,
        finish_reason: "tool_calls",
      },
    ],
  }
  const final: ChatCompletionResponse = {
    ...initial,
    id: "chat-2",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Final grounded answer." },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
  }
  let continuedPayload: ChatCompletionsPayload | undefined
  const result = await resolveWebSearchCalls(
    initial,
    {
      model: "test-model",
      messages: [{ role: "user", content: "Answer with current facts." }],
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "web_search" },
      },
    },
    {
      createCompletion: (payload) => {
        continuedPayload = payload
        return Promise.resolve(final)
      },
    },
  )

  expect(result.choices[0]?.message.content).toBe("Final grounded answer.")
  expect(continuedPayload?.tool_choice).toBe("auto")
  expect(continuedPayload?.messages.at(-1)).toMatchObject({
    role: "tool",
    tool_call_id: "call-1",
  })
  const content = continuedPayload?.messages.at(-1)?.content
  expect(typeof content === "string" ? content : "").toContain(
    "https://example.com",
  )
})
