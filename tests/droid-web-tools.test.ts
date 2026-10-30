import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import {
  droidCallNarration,
  droidResultNarration,
  executeDroidWebCall,
} from "~/services/web/droid-web-tools"
import { webToolsMiddleware } from "~/services/web/middleware"
import {
  prepareManagedWebTools,
  runWithWebTools,
  webToolsContext,
  type ManagedWebTool,
  type WebProtocol,
} from "~/services/web/tool-context"

type JsonRecord = Record<string, unknown>

const gpt: Model = {
  id: "gpt-droid-fixture",
  name: "GPT fixture",
  object: "model",
  version: "1",
  vendor: "openai",
  supported_endpoints: ["/responses"],
  capabilities: {
    family: "gpt",
    object: "model_capabilities",
    supports: { tool_calls: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
}
const webSearch = {
  type: "function",
  name: "WebSearch",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, text: { type: "boolean" } },
    required: ["query"],
  },
}
const fetchUrl = {
  type: "function",
  name: "FetchUrl",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
}
const ls = {
  type: "function",
  name: "LS",
  parameters: { type: "object", properties: {} },
}

const savedModels = state.models
afterEach(() => {
  state.models = savedModels
})

function seen(): Response {
  const context = webToolsContext()
  return Response.json({
    droid: context?.droid,
    protocol: context?.clientProtocol,
  })
}

function prepare(
  payload: JsonRecord,
  client: { droid: boolean; protocol?: WebProtocol },
  upstream: { protocol: WebProtocol; nativeResponses?: boolean },
) {
  state.models = { object: "list", data: [gpt] }
  return runWithWebTools(
    payload,
    () =>
      prepareManagedWebTools(payload, upstream.protocol, {
        nativeResponses: upstream.nativeResponses,
        hostedDefault: upstream.protocol === "responses",
      }),
    client,
  )
}

const responsesPayload = {
  model: "gpt-droid-fixture",
  input: "Find the Bun 1.4 notes",
  tools: [ls, webSearch, fetchUrl],
}

describe("Droid web tool ownership", () => {
  test("other clients keep the hosted search default", () => {
    const prepared = prepare(
      responsesPayload,
      { droid: false, protocol: "responses" },
      { protocol: "responses", nativeResponses: true },
    )
    expect(prepared.payload.tools).toContainEqual({ type: "web_search" })
    expect(prepared.managed.size).toBe(0)
  })

  test("Droid gets its own tools answered and no hidden hosted search", () => {
    const prepared = prepare(
      responsesPayload,
      { droid: true, protocol: "responses" },
      { protocol: "responses", nativeResponses: true },
    )
    expect(prepared.payload).toBe(responsesPayload)
    expect(
      [...prepared.managed].map(([name, tool]) => [name, tool.droid]),
    ).toEqual([
      ["WebSearch", "search"],
      ["FetchUrl", "fetch"],
    ])
    const withoutWebTools = { ...responsesPayload, tools: [ls] }
    const plain = prepare(
      withoutWebTools,
      { droid: true, protocol: "responses" },
      { protocol: "responses", nativeResponses: true },
    )
    expect(plain.payload).toBe(withoutWebTools)
    expect(plain.managed.size).toBe(0)
  })

  test("Droid's tool-less calls keep the usual gateway search", () => {
    // Title and summary calls carry no tools; they behave as for any client.
    const toolless = { model: "gpt-droid-fixture", input: "Name this chat" }
    const prepared = prepare(
      toolless,
      { droid: true, protocol: "responses" },
      { protocol: "responses", nativeResponses: true },
    )
    expect(prepared.payload.tools).toEqual([{ type: "web_search" }])
  })

  test("Droid's tools stay client-owned off Droid's own wire protocol", () => {
    for (const upstream of [
      { protocol: "messages", nativeResponses: false },
      { protocol: "responses", nativeResponses: false },
      { protocol: "chat", nativeResponses: false },
    ] as const) {
      const prepared = prepare(
        responsesPayload,
        { droid: true, protocol: "responses" },
        upstream,
      )
      expect(prepared.payload).toBe(responsesPayload)
      expect(prepared.managed.size).toBe(0)
    }
    const none = { ...responsesPayload, tool_choice: "none" }
    expect(
      prepare(
        none,
        { droid: true, protocol: "responses" },
        { protocol: "responses", nativeResponses: true },
      ).managed.size,
    ).toBe(0)
  })

  test("Droid's anthropic provider gets the same treatment on Messages", () => {
    const payload = {
      model: "claude-droid-fixture",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Read https://bun.sh" }],
      tools: [
        { name: "FetchUrl", input_schema: fetchUrl.parameters },
        { name: "LS", input_schema: ls.parameters },
      ],
    }
    const prepared = prepare(
      payload,
      { droid: true, protocol: "messages" },
      { protocol: "messages" },
    )
    expect(prepared.payload).toBe(payload)
    expect([...prepared.managed.keys()]).toEqual(["FetchUrl"])
  })
})

describe("Droid web calls", () => {
  const fetchTool: ManagedWebTool & { droid: "fetch" } = {
    kind: "search",
    droid: "fetch",
    maxUses: 8,
    source: {},
  }
  const searchTool: ManagedWebTool & { droid: "search" } = {
    ...fetchTool,
    droid: "search",
  }
  const run = (
    tool: ManagedWebTool & { droid: "fetch" | "search" },
    input: JsonRecord,
    uses = 0,
  ) =>
    runWithWebTools({}, async () => {
      const context = webToolsContext()
      if (!context) throw new Error("missing context")
      context.uses.set(`droid:${tool.droid}`, uses)
      return await executeDroidWebCall(
        { id: "call_1", name: "FetchUrl", input: JSON.stringify(input) },
        tool,
        { context },
      )
    })

  test("explain what GitHub's hosted reader cannot do instead of failing silently", async () => {
    const local = await run(fetchTool, { url: "http://localhost:3000/docs" })
    expect(local.isError).toBe(true)
    expect(local.text).toContain("cannot reach local or private addresses")
    expect(local.narration).toStartWith("failed: copilot-api reads pages")
    for (const url of [
      "http://10.1.2.3/",
      "http://192.168.0.10/",
      "http://[::1]/",
      "https://printer.local/",
      "https://wiki.corp.internal/",
    ])
      expect((await run(fetchTool, { url })).isError).toBe(true)
    const invalid = await run(fetchTool, { url: "ftp://example.com/file" })
    expect(invalid.text).toStartWith("Failed to fetch URL content:")
    const empty = await run(searchTool, { query: "  " })
    expect(empty.text).toBe("Error performing web search: the query is empty.")
  })

  test("stop at the per-response limit with a message the model can act on", async () => {
    const limited = await run(searchTool, { query: "bun" }, 8)
    expect(limited).toEqual({
      text: "WebSearch limit reached: this response already used it 8 times. Continue with the results you have.",
      isError: true,
      narration: "failed: WebSearch limit of 8 reached",
    })
  })

  test("narrate each call in one readable line", () => {
    expect(
      droidCallNarration(
        {
          id: "1",
          name: "WebSearch",
          input: String.raw`{"query":"bun\n1.4 notes"}`,
        },
        "search",
      ),
    ).toBe('Searching the web (copilot-api): "bun 1.4 notes"')
    expect(
      droidCallNarration(
        { id: "2", name: "FetchUrl", input: { url: "https://bun.sh/blog" } },
        "fetch",
      ),
    ).toBe("Reading https://bun.sh/blog (copilot-api)")
    expect(
      droidResultNarration("search", {
        text: "See [a](https://www.bun.sh/x) and https://github.com/oven-sh/bun",
        isError: false,
      }),
    ).toBe(" → sources: bun.sh, github.com")
    expect(
      droidResultNarration("fetch", {
        text: "x",
        isError: false,
        narration: "read 1 characters",
      }),
    ).toBe(" → read 1 characters")
  })
})

describe("Droid detection", () => {
  test("marks Droid requests and the wire protocol they called", async () => {
    const app = new Hono()
    app.use(webToolsMiddleware)
    app.post("/v1/responses", seen)
    app.post("/v1/messages", seen)
    const ask = async (path: string, agent: string) =>
      (await (
        await app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": agent },
          body: JSON.stringify({ model: "m", input: "hi" }),
        })
      ).json()) as JsonRecord
    expect(await ask("/v1/responses", "factory-cli/1.0.0")).toEqual({
      droid: true,
      protocol: "responses",
    })
    expect(await ask("/v1/messages", "factory-cli/1.0.0")).toEqual({
      droid: true,
      protocol: "messages",
    })
    expect(await ask("/v1/responses", "codex_cli_rs/0.1")).toEqual({
      droid: false,
      protocol: "responses",
    })
  })
})
