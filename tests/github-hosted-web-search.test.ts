import "./helpers/auth-misc-data-dir"

import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import {
  leaseAccount,
  withAccountLeaseScope,
} from "~/lib/account-lease-context"
import {
  routedAccountStorage,
  getLastUsedRoutedAccountId,
  setLastUsedRoutedAccountId,
} from "~/lib/request-session"
import {
  copilotResponseHeadersStorage,
  routingTelemetryStorage,
} from "~/lib/request-session"
import { runWithRoutingAffinity } from "~/lib/routing-affinity"
import { state } from "~/lib/state"
import { createAccountDistributionRepository } from "~/lib/storage/account-distribution-repository"
import { withRequestSnapshot } from "~/lib/storage/request-snapshot"
import { getStorageRuntime } from "~/lib/storage/runtime"
import { getHistoryRuntime } from "~/lib/telemetry-writer"
import { tokenPool } from "~/lib/token-pool"
import { requestedWebPages } from "~/services/copilot/hosted-web-search"
import {
  executeWebSearch,
  resetWebSearchSessionsForTest,
} from "~/services/copilot/mcp-web-search"

import { isGithubOrigin } from "./helpers/github-origin"
import {
  seedProtocolDatabase,
  useProtocolDatabase,
} from "./helpers/protocol-database"

useProtocolDatabase()
const originalFetch = globalThis.fetch
const requests: Array<{
  url: URL
  body: Record<string, unknown>
  headers: Headers
  redirect?: RequestInit["redirect"]
}> = []
const browserModel: Model = {
  id: "browser-fixture",
  object: "model",
  name: "Browser",
  version: "1",
  vendor: "openai",
  supported_endpoints: ["/responses"],
  policy: { state: "enabled", terms: "" },
  capabilities: {
    family: "gpt",
    object: "model_capabilities",
    supports: { tool_calls: true, web_search: true },
    tokenizer: "cl100k_base",
    type: "chat",
  },
}
let result: Record<string, unknown>
let status: number

beforeEach(async () => {
  requests.length = 0
  resetWebSearchSessionsForTest()
  state.isMultiToken = false
  state.githubToken = "github-fixture"
  state.copilotToken = "copilot-fixture"
  state.accountType = "individual"
  state.models = { object: "list", data: [browserModel] }
  await seedProtocolDatabase()
  status = 200
  result = {
    id: "browse-1",
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://pages.test/guide" },
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              status: "ok",
              content: "REMOTE_PAGE_EVIDENCE",
              sources: ["https://pages.test/guide"],
            }),
          },
        ],
      },
    ],
  }
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!isGithubOrigin(url)) throw new Error("Forbidden page-origin request")
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>
    requests.push({
      url,
      body,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    })
    if (url.pathname === "/mcp/readonly")
      return Promise.resolve(
        Response.json(
          body.method === "initialize" ?
            { jsonrpc: "2.0", result: {} }
          : {
              jsonrpc: "2.0",
              result: { content: [{ type: "text", text: "MCP_SEARCH_ONLY" }] },
            },
          { headers: { "Mcp-Session-Id": "hosted-fixture" } },
        ),
      )
    if (url.pathname !== "/responses")
      throw new Error("Unexpected GitHub route")
    return Promise.resolve(Response.json(result, { status }))
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

test("page URLs preserve balanced parentheses and a quoted URL's literal punctuation", () => {
  expect(
    requestedWebPages("Open https://en.wikipedia.org/wiki/Bun_(software)"),
  ).toEqual(["https://en.wikipedia.org/wiki/Bun_(software)"])
  expect(
    requestedWebPages('Open "https://pages.test/guide?value=end!"'),
  ).toEqual(["https://pages.test/guide?value=end!"])
  expect(requestedWebPages("Read [guide](https://pages.test/guide).")).toEqual([
    "https://pages.test/guide",
  ])
})

test.each([
  ["Open 'https://pages.test/guide'", "https://pages.test/guide"],
  ["Open `https://pages.test/guide`", "https://pages.test/guide"],
  ["Read 'https://pages.test/guide', please", "https://pages.test/guide"],
  ["Read `https://pages.test/guide`.", "https://pages.test/guide"],
  [
    "Read 'https://pages.test/guide?value=end.,;'",
    "https://pages.test/guide?value=end.,;",
  ],
  [
    "Read `https://pages.test/Bun_(software)?value=end.,;`",
    "https://pages.test/Bun_(software)?value=end.,;",
  ],
  [
    'Read "https://pages.test/guide?value=end.,;"',
    "https://pages.test/guide?value=end.,;",
  ],
  [
    "Read <https://pages.test/guide?value=end.,;>",
    "https://pages.test/guide?value=end.,;",
  ],
  ["Read 'https://pages.test/o'clock'", "https://pages.test/o'clock"],
  ["Read https://pages.test/o'clock", "https://pages.test/o'clock"],
  ["Read https://pages.test/guide'", "https://pages.test/guide'"],
  ["Read https://pages.test/guide`", "https://pages.test/guide%60"],
  ["Read 'https://pages.test/o'clock", "https://pages.test/o'clock"],
  ["Read `https://pages.test/guide", "https://pages.test/guide"],
])("page URL extraction removes only paired enclosures: %s", (query, url) => {
  expect(requestedWebPages(query)).toEqual([url])
})

test.each(["'", "`"])(
  "a page request enclosed in %s reaches the exact hosted open target",
  async (quote) => {
    const text = await executeWebSearch(
      `Open ${quote}https://pages.test/guide${quote}.`,
    )
    expect(text).toContain("REMOTE_PAGE_EVIDENCE")
    expect(requests).toHaveLength(1)
    expect(requests[0].body.input).toStartWith(
      "Requested exact URLs:\nhttps://pages.test/guide\n",
    )
  },
)

test("ordinary search keeps the existing MCP route", async () => {
  expect(await executeWebSearch("latest releases")).toBe("MCP_SEARCH_ONLY")
  expect(requests.map((r) => r.url.pathname)).toEqual([
    "/mcp/readonly",
    "/mcp/readonly",
  ])
})

test("a URL requested through web_search is opened entirely by GitHub", async () => {
  const text = await executeWebSearch(
    "Open https://pages.test/guide and read the installation section",
  )
  expect(text).toContain("REMOTE_PAGE_EVIDENCE")
  expect(requests).toHaveLength(1)
  expect(requests[0].url.pathname).toBe("/responses")
  expect(requests[0].redirect).toBe("error")
  expect(requests[0].body).toMatchObject({
    model: "browser-fixture",
    store: false,
    stream: false,
    tools: [{ type: "web_search", external_web_access: true }],
    tool_choice: "required",
  })
  expect(requests[0].headers.get("authorization")).toBe(
    "Bearer copilot-fixture",
  )
  expect(JSON.stringify(requests[0].body)).toContain("https://pages.test/guide")
  expect(JSON.stringify(requests[0].body)).not.toContain("_copilot_web_search")
})

test.each([
  "no-action",
  "different-url",
  "upstream-failed",
  "retrieval-failed",
])("cannot claim page retrieval for %s", async (kind) => {
  if (kind === "no-action")
    result.output = [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: '{"status":"ok","content":"unverified"}',
          },
        ],
      },
    ]
  if (kind === "different-url")
    (result.output as Array<Record<string, unknown>>)[0].action = {
      type: "open_page",
      url: "https://other.test/",
    }
  if (kind === "upstream-failed") {
    result.status = "failed"
    result.error = { message: "refused" }
  }
  if (kind === "retrieval-failed")
    (result.output as Array<Record<string, unknown>>)[1].content = [
      {
        type: "output_text",
        text: '{"status":"error","content":"HTTP 502: page was not retrieved"}',
      },
    ]
  const text = await executeWebSearch("Open https://pages.test/guide")
  expect(text).toMatch(/^Web search (?:failed|error):/)
  expect(requests).toHaveLength(1)
  expect(requests[0].url.pathname).toBe("/responses")
})

test("unavailable hosted browsing never falls back to local fetching or MCP snippets", async () => {
  state.models = { object: "list", data: [] }
  const account = tokenPool.getFirstHealthyAccount()
  if (!account) throw new Error("Missing fixture account")
  account.modelsData = []
  account.models.clear()
  tokenPool.rebuildModelIndex()
  const text = await executeWebSearch("Open https://pages.test/guide")
  expect(text).toMatch(/^Web search failed:/)
  expect(requests).toHaveLength(0)
})

test("a hosted tool rejection is reported, not hidden behind another retrieval backend", async () => {
  status = 400
  result = { error: { message: "web search not enabled" } }
  expect(await executeWebSearch("Open https://pages.test/guide")).toMatch(
    /^Web search failed:/,
  )
  expect(requests).toHaveLength(1)
})

test.each([
  {
    usage: { input_tokens: 11, output_tokens: 7 },
    input: 11,
    output: 7,
    requests: 1,
    gaps: 0,
  },
  {
    usage: { input_tokens: 0, output_tokens: 0 },
    input: 0,
    output: 0,
    requests: 1,
    gaps: 0,
  },
  {
    usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 7 },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 1,
  },
  {
    usage: { input_tokens: 11, output_tokens: 0.5 },
    input: 11,
    output: 0,
    requests: 1,
    gaps: 1,
  },
  {
    usage: { input_tokens: "11", output_tokens: 7 },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 1,
  },
  {
    usage: { input_tokens: null, output_tokens: 7 },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 1,
  },
  {
    usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: -1 },
    input: 0,
    output: 0,
    requests: 1,
    gaps: 1,
  },
  {
    usage: { input_tokens: Number.MAX_SAFE_INTEGER },
    input: 0,
    output: 0,
    requests: 1,
    gaps: 1,
  },
  {
    usage: { output_tokens: null },
    input: 0,
    output: 0,
    requests: 1,
    gaps: 1,
  },
  {
    usage: { input_tokens: 11 },
    input: 11,
    output: 0,
    requests: 1,
    gaps: 0,
  },
  {
    usage: { output_tokens: 7 },
    input: 0,
    output: 7,
    requests: 1,
    gaps: 0,
  },
  { usage: undefined, input: 0, output: 0, requests: 0, gaps: 0 },
  { usage: null, input: 0, output: 0, requests: 0, gaps: 0 },
  { usage: {}, input: 0, output: 0, requests: 0, gaps: 0 },
  {
    usage: { total_tokens: 18 },
    input: 0,
    output: 0,
    requests: 0,
    gaps: 0,
  },
])(
  "hosted helper preserves valid usage and explicit invalid counts: %p",
  async (expected) => {
    result.usage = expected.usage
    await executeWebSearch("Open https://pages.test/guide")
    const runtime = getHistoryRuntime()
    await runtime.writer.flush()
    expect(
      (await runtime.repository.readUsageTotals(0)).lifetime,
    ).toMatchObject({
      inputTokens: expected.input,
      outputTokens: expected.output,
      requestCount: expected.requests,
    })
    expect((await runtime.repository.collectionStatus()).unknownGaps).toBe(
      expected.gaps,
    )
    const gaps = await runtime.storage.read((session) =>
      session.query({
        sql: "SELECT payload_json FROM capi_collection_gaps",
        args: [],
      }),
    )
    expect(gaps).toHaveLength(expected.gaps)
    for (const gap of gaps)
      expect(JSON.parse(String(gap.payload_json))).toMatchObject({
        historyKind: "usage",
        unknown: true,
        reason: "invalid-token-count",
      })
  },
)

test("failed hosted responses do not charge helper usage", async () => {
  result.status = "failed"
  result.usage = { input_tokens: 11, output_tokens: 7 }
  await executeWebSearch("Open https://pages.test/guide")
  const runtime = getHistoryRuntime()
  await runtime.writer.flush()
  expect(
    (await runtime.repository.readUsageTotals(0)).lifetime.requestCount,
  ).toBe(0)
  expect((await runtime.repository.collectionStatus()).unknownGaps).toBe(0)
})

test("page-reading helper preserves the parent account and durable model assignment", async () => {
  const owner = tokenPool.getFirstHealthyAccount()
  if (!owner) throw new Error("Missing account")
  owner.models.add("claude-parent")
  tokenPool.rebuildModelIndex()
  const repository = createAccountDistributionRepository(
    getStorageRuntime().storage,
  )
  await repository.assign({
    affinityKey: "parent-thread",
    modelId: "claude-parent",
    eligibleAccountIds: [owner.id],
    preferredAccountId: owner.id,
    preferredReason: "pinned",
  })
  await runWithRoutingAffinity(
    { key: "parent-thread", source: "claude_session" },
    () =>
      routedAccountStorage.run({}, async () => {
        setLastUsedRoutedAccountId(owner.id)
        expect(
          await executeWebSearch("Open https://pages.test/guide"),
        ).toContain("REMOTE_PAGE_EVIDENCE")
        expect(getLastUsedRoutedAccountId()).toBe(owner.id)
      }),
  )
  expect((await repository.lookupAssignment("parent-thread"))?.modelId).toBe(
    "claude-parent",
  )
})

test("helper headers and routing telemetry cannot overwrite the parent inference metadata", async () => {
  const headers = {
    "copilot-session-token": "parent-session",
    "x-quota-snapshot-premium": "parent-quota",
  }
  const telemetry = {
    sourceProtocol: "Messages",
    lastModel: "claude-parent",
    lastProvider: "GitHub Copilot",
    lastDestination: "Anthropic Messages",
    dispatched: true,
  }
  await copilotResponseHeadersStorage.run(headers, () =>
    routingTelemetryStorage.run(telemetry, async () => {
      await executeWebSearch("Open https://pages.test/guide")
      expect(headers).toEqual({
        "copilot-session-token": "parent-session",
        "x-quota-snapshot-premium": "parent-quota",
      })
      expect(telemetry.lastModel).toBe("claude-parent")
      expect(telemetry.lastDestination).toBe("Anthropic Messages")
    }),
  )
})

test.each(["disable", "remove"])(
  "an admitted hosted read retains its lease after account %s",
  async (change) => {
    const owner = tokenPool.getFirstHealthyAccount()
    if (!owner) throw new Error("Missing account")
    await withRequestSnapshot(getStorageRuntime().snapshot.get(), () =>
      routedAccountStorage.run({}, () =>
        withAccountLeaseScope(undefined, async () => {
          leaseAccount(owner)
          setLastUsedRoutedAccountId(owner.id)
          if (change === "remove") tokenPool.deleteAccount(owner.id)
          else {
            owner.enabled = false
            tokenPool.rebuildModelIndex()
          }
          expect(
            await executeWebSearch("Open https://pages.test/guide"),
          ).toContain("REMOTE_PAGE_EVIDENCE")
          expect(requests.at(-1)?.headers.get("authorization")).toBe(
            "Bearer copilot-fixture",
          )
        }),
      ),
    )
  },
)
