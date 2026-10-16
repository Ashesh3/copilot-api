/* eslint-disable no-nested-ternary -- Fixtures cover all three wire dialects. */
/* eslint-disable @typescript-eslint/require-await -- Async transport fixtures intentionally resolve immediately. */
import "./helpers/auth-misc-data-dir"
import { afterAll, beforeEach, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"
import { server } from "~/server"
import { resetWebSearchSessionsForTest } from "~/services/copilot/mcp-web-search"

import { isGithubOrigin } from "./helpers/github-origin"
import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()
const originalFetch = globalThis.fetch
const upstream: Array<Record<string, unknown>> = []
let pageCalls = 0
let searchCalls = 0
let searchFirst = false
let endpoint = "/v1/messages"
const fetchMock = mock(
  // eslint-disable-next-line complexity -- Three provider envelopes plus MCP and page transport in one route fixture.
  async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : String(url))
    if (!isGithubOrigin(target))
      throw new Error("Proxy must not fetch page origins")
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>
    if (target.pathname === "/responses" && body.model === "browser-fixture") {
      pageCalls++
      expect(new Headers(init?.headers).has("authorization")).toBe(true)
      expect(body.tools).toEqual([
        { type: "web_search", external_web_access: true },
      ])
      return Response.json({
        status: "completed",
        output: [
          {
            type: "web_search_call",
            status: "completed",
            action: { type: "open_page", url: "https://pages.test/" },
          },
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  status: "ok",
                  content: "Verified Title: Source-only fixture text.",
                }),
              },
            ],
          },
        ],
      })
    }
    if (target.pathname === "/mcp/readonly") {
      if (body.method === "initialize")
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result: {} },
          { headers: { "Mcp-Session-Id": "default-tools-session" } },
        )
      searchCalls++
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: "Search evidence [Source](https://pages.test/)",
            },
          ],
        },
      })
    }
    upstream.push(body)
    const toolTurn = upstream.length < (searchFirst ? 3 : 2)
    const searching = searchFirst && upstream.length === 1
    const toolName = "_copilot_web_search"
    const toolInput =
      searching ?
        { query: "Find source-only fixture text" }
      : { query: "Open https://pages.test/ and read the page" }
    const tools = body.tools as Array<Record<string, unknown>>
    const names = tools.map(
      (t) => ((t.function ?? t) as Record<string, unknown>).name,
    )
    expect(names).not.toContain("_copilot_web_fetch")
    expect(names).toContain("_copilot_web_search")
    if (endpoint === "/v1/messages")
      return Response.json({
        id: "m1",
        type: "message",
        role: "assistant",
        model: "fixture",
        stop_sequence: null,
        content:
          toolTurn ?
            [
              {
                type: "tool_use",
                id: "f1",
                name: toolName,
                input: toolInput,
              },
            ]
          : [
              {
                type: "text",
                text: "Verified Title: Source-only fixture text.",
              },
            ],
        stop_reason: toolTurn ? "tool_use" : "end_turn",
        usage: { input_tokens: 2, output_tokens: 3 },
      })
    if (endpoint === "/responses")
      return Response.json({
        id: "r1",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "fixture",
        output:
          toolTurn ?
            [
              {
                type: "function_call",
                id: "fi1",
                call_id: "f1",
                name: toolName,
                arguments: JSON.stringify(toolInput),
              },
            ]
          : [
              {
                type: "message",
                id: "mi1",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "Verified Title: Source-only fixture text.",
                    annotations: [],
                  },
                ],
              },
            ],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      })
    return Response.json({
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: toolTurn ? "tool_calls" : "stop",
          message:
            toolTurn ?
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "f1",
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: JSON.stringify(toolInput),
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: "Verified Title: Source-only fixture text.",
              },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    })
  },
)
afterAll(() => {
  globalThis.fetch = originalFetch
})
beforeEach(async () => {
  upstream.length = 0
  pageCalls = 0
  searchCalls = 0
  searchFirst = false
  resetWebSearchSessionsForTest()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  state.accountType = "individual"
  state.copilotToken = "copilot-token"
  state.githubToken = "github-token"
  state.isMultiToken = false
  state.manualApprove = false
})
for (const [route, targetEndpoint, withSearch] of [
  ["/v1/messages", "/v1/messages", false],
  ["/v1/messages", "/responses", false],
  ["/v1/messages", "/chat/completions", false],
  ["/v1/chat/completions", "/chat/completions", false],
  ["/v1/chat/completions", "/responses", false],
  ["/v1/responses", "/responses", false],
  ["/v1/responses", "/v1/messages", false],
  ["/v1/responses", "/chat/completions", false],
  ["/v1beta/models/fixture:generateContent", "/chat/completions", false],
  ["/v1beta/models/fixture:generateContent", "/responses", false],
  ["/v1/messages", "/v1/messages", true],
  ["/v1/responses", "/responses", true],
] as const) {
  test(`default web tools execute through ${route} -> ${targetEndpoint} without client configuration`, async () => {
    endpoint = targetEndpoint
    searchFirst = withSearch
    state.models = {
      object: "list",
      data: [
        {
          id: "fixture",
          name: "Fixture",
          object: "model",
          preview: false,
          version: "1",
          model_picker_enabled: true,
          supported_endpoints: [endpoint],
          vendor: "test",
          capabilities: {
            family: "test",
            limits: { max_output_tokens: 1024 },
            object: "model_capabilities",
            supports: { tool_calls: true },
            tokenizer: "cl100k_base",
            type: "chat",
          },
        },
      ],
    }
    state.models.data.push({
      id: "browser-fixture",
      object: "model",
      name: "Browser",
      version: "1",
      vendor: "openai",
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        object: "model_capabilities",
        supports: { tool_calls: true, web_search: true },
        tokenizer: "cl100k_base",
        type: "chat",
      },
    })
    await seedProtocolDatabase()
    const payload =
      route.includes(":") ?
        {
          contents: [
            { role: "user", parts: [{ text: "Read https://pages.test/" }] },
          ],
        }
      : route.includes("responses") ?
        { model: "fixture", input: "Read https://pages.test/", stream: false }
      : {
          model: "fixture",
          max_tokens: 512,
          stream: false,
          messages: [{ role: "user", content: "Read https://pages.test/" }],
        }
    const response = await server.request(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer protocol-fixture-gateway-key",
      },
      body: JSON.stringify(payload),
    })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).toContain("Verified Title")
    expect(pageCalls).toBe(1)
    expect(upstream.length).toBe(withSearch ? 3 : 2)
    expect(searchCalls).toBe(withSearch ? 1 : 0)
    expect(JSON.stringify(upstream.at(-1))).toContain(
      "Source-only fixture text.",
    )
    expect(text).not.toContain('"name":"_copilot_web_search"')
  })
}

test("caller-owned web_search is returned without gateway execution", async () => {
  endpoint = "/chat/completions"
  state.models = {
    object: "list",
    data: [
      {
        id: "fixture",
        name: "Fixture",
        object: "model",
        preview: false,
        version: "1",
        supported_endpoints: [endpoint],
        capabilities: {
          family: "test",
          object: "model_capabilities",
          limits: { max_output_tokens: 1024 },
          supports: { tool_calls: true },
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  await seedProtocolDatabase()
  let sends = 0
  globalThis.fetch = mock(() => {
    sends++
    return Promise.resolve(
      Response.json({
        id: "client-call",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            logprobs: null,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "client-search",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: '{"query":"local"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    )
  }) as unknown as typeof fetch
  const response = await server.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
    body: JSON.stringify({
      model: "fixture",
      messages: [{ role: "user", content: "Search" }],
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        },
      ],
    }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    choices: [
      {
        message: {
          tool_calls: [
            { id: "client-search", function: { name: "web_search" } },
          ],
        },
      },
    ],
  })
  expect(sends).toBe(1)
})
