import "./helpers/auth-misc-data-dir"

import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { tokenPool } from "../src/lib/token-pool"
import { server } from "../src/server"
import { resetWebSearchSessionsForTest } from "../src/services/copilot/mcp-web-search"
import {
  useProtocolDatabase,
  seedProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  apiKeyAuth: state.apiKeyAuth,
  githubToken: state.githubToken,
  isMultiToken: state.isMultiToken,
}
const mcpRequests: Array<{
  body: Record<string, unknown>
  headers: Headers
}> = []

const fetchMock = mock((_url: string, init?: RequestInit) => {
  const body = JSON.parse(
    typeof init?.body === "string" ? init.body : "{}",
  ) as Record<string, unknown>
  mcpRequests.push({ body, headers: new Headers(init?.headers) })

  if (body.method === "initialize") {
    return new Response('data: {"jsonrpc":"2.0","id":"init","result":{}}\n\n', {
      headers: {
        "content-type": "text/event-stream",
        "Mcp-Session-Id": "codex-search-session",
      },
    })
  }

  return new Response(
    'data: {"jsonrpc":"2.0","id":"search","result":{"content":[{"type":"text","text":"{\\"type\\":\\"output_text\\",\\"text\\":{\\"value\\":\\"Current result ⟦1†source⟧\\",\\"annotations\\":[{\\"start_index\\":15,\\"end_index\\":25,\\"url_citation\\":{\\"title\\":\\"Example\\",\\"url\\":\\"https://example.com/current\\"}}]}}"}]}}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  )
})

beforeAll(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterAll(() => {
  const account = tokenPool
    .getAllAccounts()
    .find((candidate) => candidate.id === 91_001)
  if (account) tokenPool.markUnhealthy(account)
  state.accountType = originalState.accountType
  state.apiKeyAuth = originalState.apiKeyAuth
  state.githubToken = originalState.githubToken
  state.isMultiToken = originalState.isMultiToken
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

beforeEach(async () => {
  fetchMock.mockClear()
  mcpRequests.length = 0
  resetWebSearchSessionsForTest()
  state.accountType = "individual"
  state.apiKeyAuth = undefined
  state.githubToken = undefined
  state.copilotToken = undefined
  state.isMultiToken = false
  const account = tokenPool.addAccount("github-token", "individual", 0)
  account.copilotToken = "copilot-token"
  account.healthy = true
  await seedProtocolDatabase({ singleAccount: false })
})

test("serves Codex Desktop standalone web search through Copilot MCP", async () => {
  const response = await server.request("/v1/alpha/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
    body: JSON.stringify({
      id: "codex-thread-1",
      model: "gpt-5.6-sol",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Find current releases." }],
        },
      ],
      commands: {
        search_query: [
          {
            q: "latest release",
            recency: 7,
            domains: ["example.com"],
          },
        ],
        response_length: "short",
      },
      settings: {
        filters: { allowed_domains: ["example.com"] },
        search_context_size: "high",
        user_location: { type: "approximate", country: "IN" },
      },
    }),
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    encrypted_output: string | null
    output: string
  }
  expect(body.encrypted_output).toBeNull()
  expect(body.output).toContain("https://example.com/current")

  expect(mcpRequests).toHaveLength(2)
  expect(mcpRequests[1]?.body).toMatchObject({
    method: "tools/call",
    params: {
      name: "web_search",
    },
  })
  const params = mcpRequests[1]?.body.params as {
    arguments?: { query?: string }
  }
  expect(params.arguments?.query).toContain('"q":"latest release"')
  expect(params.arguments?.query).toContain(
    "Only use these domains: example.com.",
  )
  expect(params.arguments?.query).toContain("Find current releases.")
})

test("Codex ordinary search ignores unrelated URLs in prior conversation context", async () => {
  const response = await server.request("/v1/alpha/search", {
    method: "POST",
    headers: {
      authorization: "Bearer protocol-fixture-gateway-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: "search-now",
      model: "any-model",
      input: [
        {
          role: "assistant",
          content: "Earlier we opened https://old.test/closed",
        },
      ],
      commands: { search_query: [{ q: "latest Bun release" }] },
    }),
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("https://example.com/current")
  expect(mcpRequests).toHaveLength(2)
})

test("rejects malformed Codex search requests before calling MCP", async () => {
  const response = await server.request("/v1/alpha/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", commands: {} }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: { message: "id is required", type: "invalid_request_error" },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("Codex open forwards to GitHub hosted browsing without page-origin access", async () => {
  const previous = globalThis.fetch
  const requests: Array<{ url: URL; body: Record<string, unknown> }> = []
  const account = tokenPool.getFirstHealthyAccount()
  if (!account) throw new Error("Missing fixture account")
  account.models.add("hosted-browser")
  account.modelsData = [
    {
      id: "hosted-browser",
      object: "model",
      name: "Browser",
      version: "1",
      vendor: "openai",
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "gpt",
        object: "model_capabilities",
        supports: { web_search: true },
        tokenizer: "cl100k_base",
        type: "chat",
      },
    },
  ]
  tokenPool.rebuildModelIndex()
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith("githubcopilot.com"))
      throw new Error("Forbidden page origin")
    requests.push({
      url,
      body: JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>,
    })
    return Promise.resolve(
      Response.json({
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
                text: '{"status":"ok","content":"HOSTED_PAGE"}',
              },
            ],
          },
        ],
      }),
    )
  }) as typeof fetch
  try {
    const response = await server.request("/v1/alpha/search", {
      method: "POST",
      headers: {
        authorization: "Bearer protocol-fixture-gateway-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "open-call",
        model: "hosted-browser",
        commands: { open: [{ ref_id: "https://pages.test/" }] },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ encrypted_output: null })
    expect(requests).toHaveLength(1)
    expect(requests[0].url.pathname).toBe("/responses")
    expect(requests[0].body).toMatchObject({
      tools: [{ type: "web_search", external_web_access: true }],
    })
  } finally {
    // eslint-disable-next-line require-atomic-updates -- This fixture restores its own serially installed fetch wrapper.
    globalThis.fetch = previous
  }
})

test("selects the Codex model account for standalone multi-token search", async () => {
  const model = "codex-search-account-model"
  const account = tokenPool.addAccount(
    "account-github-token",
    "individual",
    91_001,
  )
  account.copilotToken = "account-copilot-token"
  account.healthy = true
  account.models = new Set([model])
  tokenPool.rebuildModelIndex()
  state.githubToken = undefined
  state.isMultiToken = true
  await seedProtocolDatabase()

  const response = await server.request("/v1/alpha/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer protocol-fixture-gateway-key",
    },
    body: JSON.stringify({
      id: "sticky-codex-session",
      model,
      commands: { search_query: [{ q: "current information" }] },
    }),
  })

  expect(response.status).toBe(200)
  expect(mcpRequests[0]?.headers.get("authorization")).toBe(
    "Bearer account-github-token",
  )
})
