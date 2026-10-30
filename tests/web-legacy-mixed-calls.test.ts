import "./helpers/auth-misc-data-dir"

import { afterAll, beforeEach, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type { ResponsesResult } from "~/services/copilot/create-responses"
import type { WebProtocol } from "~/services/web/tool-context"

import { LocalHTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { resolvePreparedGoogleResponsesWebSearch } from "~/routes/google-ai/responses-web-search"
import { resolveNativeWebSearch } from "~/routes/messages/native-handler"
import {
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "~/routes/messages/web-search-helpers"
import { resolvePreparedResponsesWebSearchCalls } from "~/routes/responses/chat-fallback-completion"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"

import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
  models: state.models,
}
let searches = 0
const continued: Array<Record<string, unknown>> = []
const nativeResponses: Array<Record<string, unknown>> = []
let nativeSends = 0

beforeEach(async () => {
  searches = 0
  continued.length = 0
  nativeResponses.length = 0
  nativeSends = 0
  resetWebSearchSessionsForTest()
  state.accountType = "individual"
  state.copilotToken = "fixture-copilot-token"
  state.githubToken = "fixture-github-token"
  state.isMultiToken = false
  state.models = undefined
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(url instanceof Request ? url.url : String(url))
      .pathname
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>
    if (path === "/mcp/readonly") {
      if (body.method === "initialize")
        return Promise.resolve(
          Response.json(
            { jsonrpc: "2.0", id: body.id, result: {} },
            { headers: { "Mcp-Session-Id": "legacy-fixture" } },
          ),
        )
      searches++
      return Promise.resolve(
        Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "private-search-evidence" }],
          },
        }),
      )
    }
    if (path !== "/v1/messages") throw new Error("Unexpected fixture fetch")
    if (nativeSends++ > 0) continued.push(body)
    const response = nativeResponses.shift()
    if (!response) throw new Error("Unexpected native continuation")
    return Promise.resolve(Response.json(response))
  }) as typeof fetch
  await seedProtocolDatabase()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
})

function toolCall(
  protocol: WebProtocol,
  name: string,
  id = name,
): Record<string, unknown> {
  if (protocol === "messages")
    return { type: "tool_use", id, name, input: { query: "weather" } }
  if (protocol === "responses")
    return {
      type: "function_call",
      id: `fc_${id}`,
      call_id: id,
      name,
      arguments: '{"query":"weather"}',
    }
  return {
    type: "function",
    id,
    function: { name, arguments: '{"query":"weather"}' },
  }
}

function response(
  protocol: WebProtocol,
  calls: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (protocol === "messages")
    return {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "legacy-fixture",
      content: [
        { type: "thinking", thinking: "Plan", signature: "signed-fixture" },
        ...(calls.length > 0 ?
          calls
        : [{ type: "text", text: "Final answer" }]),
      ],
      stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 3 },
    }
  if (protocol === "responses")
    return {
      id: "resp_fixture",
      object: "response",
      model: "legacy-fixture",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      top_p: null,
      tool_choice: "auto",
      tools: [],
      output: [
        {
          type: "reasoning",
          id: "rs_fixture",
          encrypted_content: "signed-fixture",
          summary: [],
        },
        ...(calls.length > 0 ?
          calls
        : [
            {
              type: "message",
              id: "msg_fixture",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Final answer", annotations: [] },
              ],
            },
          ]),
      ],
      output_text: calls.length > 0 ? "" : "Final answer",
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    }
  return {
    id: "chatcmpl_fixture",
    object: "chat.completion",
    model: "legacy-fixture",
    created: 1,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: calls.length > 0 ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: calls.length > 0 ? null : "Final answer",
          reasoning_opaque: "signed-fixture",
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        },
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }
}

const chatPayload: ChatCompletionsPayload = {
  model: "legacy-fixture",
  messages: [{ role: "user", content: "Look up the weather." }],
  tools: [
    {
      type: "function",
      function: { name: "web_search", parameters: { type: "object" } },
    },
  ],
}
const responsesPayload = {
  model: "legacy-fixture",
  input: "Look up the weather.",
  tools: [
    { type: "function", name: "web_search", parameters: { type: "object" } },
  ],
}

interface ResolverFixture {
  name: string
  protocol: WebProtocol
  run: (
    initial: Record<string, unknown>,
    next: Record<string, unknown>,
    maxUses?: number,
  ) => Promise<unknown>
  /** Usage reported after a search round, when not the final round's own. */
  searchedUsage?: Record<string, unknown>
}
const resolvers: Array<ResolverFixture> = [
  {
    name: "Chat helper",
    protocol: "chat",
    run: (initial, next, maxUses) =>
      resolveWebSearchCalls(
        initial as unknown as ChatCompletionResponse,
        structuredClone(chatPayload),
        {
          maxUses,
          createCompletion: (payload) => {
            continued.push(payload as unknown as Record<string, unknown>)
            return Promise.resolve(next as unknown as ChatCompletionResponse)
          },
        },
      ),
  },
  {
    name: "Responses helper",
    protocol: "responses",
    run: (initial, next, maxUses) =>
      resolveResponsesWebSearchCalls(
        initial as unknown as ResponsesResult,
        structuredClone(responsesPayload),
        {
          vision: false,
          initiator: "user",
          maxUses,
          createResponse: (payload) => {
            continued.push(payload)
            return Promise.resolve(next as unknown as ResponsesResult)
          },
        },
      ),
  },
  {
    name: "Prepared Chat",
    protocol: "chat",
    // The final round's prompt, with the completions of both rounds.
    searchedUsage: { prompt_tokens: 2, completion_tokens: 6, total_tokens: 8 },
    run: (initial, next, maxUses) =>
      resolvePreparedResponsesWebSearchCalls({
        initial: {
          processedPayload: structuredClone(chatPayload),
          response: initial as unknown as ChatCompletionResponse,
        },
        maxUses,
        completionFactory: (payload) => {
          continued.push(payload as unknown as Record<string, unknown>)
          return Promise.resolve({
            processedPayload: payload,
            response: next as unknown as ChatCompletionResponse,
          })
        },
      }),
  },
  {
    name: "Google Responses",
    protocol: "responses",
    run: (initial, next, maxUses) =>
      resolvePreparedGoogleResponsesWebSearch({
        initial: initial as unknown as ResponsesResult,
        payload: structuredClone(responsesPayload),
        maxUses,
        createResponse: (payload) => {
          continued.push(payload)
          return Promise.resolve(next as unknown as ResponsesResult)
        },
      }),
  },
  {
    name: "Native Messages",
    protocol: "messages",
    run: (initial, next, maxUses) => {
      nativeResponses.push(initial, next)
      const payload: AnthropicMessagesPayload = {
        model: "legacy-fixture",
        max_tokens: 128,
        messages: [{ role: "user", content: "Look up the weather." }],
        tools: [{ name: "web_search", input_schema: { type: "object" } }],
      }
      return resolveNativeWebSearch(payload, {
        signal: new AbortController().signal,
        webSearchMaxUses: maxUses,
      })
    },
  },
]

test.each(resolvers)(
  "$name rejects mixed calls before any search or continuation",
  async ({ protocol, run }) => {
    const initial = response(protocol, [
      toolCall(protocol, "web_search"),
      toolCall(protocol, "get_weather"),
    ])
    const error = await run(initial, response(protocol, [])).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(LocalHTTPError)
    expect(error).toHaveProperty(
      "clientBody.error.code",
      "unsupported_web_tool_combination",
    )
    expect(searches).toBe(0)
    expect(continued).toHaveLength(0)
  },
)

test.each(resolvers)(
  "$name checks mixed ownership before the search budget",
  async ({ protocol, run }) => {
    const initial = response(protocol, [
      toolCall(protocol, "web_search", "web-one"),
      toolCall(protocol, "web_search", "web-two"),
      toolCall(protocol, "get_weather"),
    ])
    const error = await run(initial, response(protocol, []), 1).catch(
      (caught: unknown) => caught,
    )
    expect(error).toHaveProperty(
      "clientBody.error.code",
      "unsupported_web_tool_combination",
    )
    expect(searches).toBe(0)
    expect(continued).toHaveLength(0)
  },
)

test.each(resolvers)(
  "$name rejects client-only handoff after a private search",
  async ({ protocol, run }) => {
    const error = await run(
      response(protocol, [toolCall(protocol, "web_search")]),
      response(protocol, [toolCall(protocol, "get_weather")]),
    ).catch((caught: unknown) => caught)
    expect(error).toHaveProperty(
      "clientBody.error.code",
      "unsupported_web_tool_combination",
    )
    expect(searches).toBe(1)
    expect(continued).toHaveLength(1)
    expect(JSON.stringify(continued[0])).toContain("private-search-evidence")
    expect(JSON.stringify(continued[0])).toContain("signed-fixture")
  },
)

test.each(resolvers)(
  "$name preserves an initial caller-only response",
  async ({ protocol, run }) => {
    const initial = response(protocol, [toolCall(protocol, "get_weather")])
    expect(await run(initial, response(protocol, []))).toEqual(initial)
    expect(searches).toBe(0)
    expect(continued).toHaveLength(0)
  },
)

test.each(resolvers)(
  "$name keeps pure web results private through final synthesis",
  async ({ protocol, run, searchedUsage }) => {
    const final = response(protocol, [])
    expect(
      await run(response(protocol, [toolCall(protocol, "web_search")]), final),
    ).toEqual(searchedUsage ? { ...final, usage: searchedUsage } : final)
    expect(searches).toBe(1)
    expect(continued).toHaveLength(1)
    expect(JSON.stringify(continued[0])).toContain("private-search-evidence")
  },
)

test.each(resolvers.filter(({ protocol }) => protocol === "responses"))(
  "$name preserves a namespaced caller web_search",
  async ({ protocol, run }) => {
    const initial = response(protocol, [
      { ...toolCall(protocol, "web_search"), namespace: "client" },
    ])
    expect(await run(initial, response(protocol, []))).toEqual(initial)
    expect(searches).toBe(0)
    expect(continued).toHaveLength(0)
  },
)

test.each(resolvers.filter(({ protocol }) => protocol === "chat"))(
  "$name preserves custom Chat calls without a function field",
  async ({ protocol, run }) => {
    const initial = response(protocol, [
      {
        id: "client-custom",
        type: "custom",
        custom: { name: "web_search", input: "weather" },
      },
    ])
    expect(await run(initial, response(protocol, []))).toEqual(initial)
    expect(searches).toBe(0)
    expect(continued).toHaveLength(0)
  },
)
