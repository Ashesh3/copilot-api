import { expect, test } from "bun:test"

import {
  prepareManagedWebTools,
  runWithWebTools,
  webToolsContext,
} from "~/services/web/tool-context"

test("normal inference gets search and fetch even without declared tools", () =>
  runWithWebTools({}, "test", () => {
    const result = prepareManagedWebTools(
      { model: "model", messages: [] },
      "messages",
    )
    expect([...result.managed.values()].map((t) => t.kind)).toEqual([
      "search",
      "fetch",
    ])
    expect(result.payload.tools).toHaveLength(2)
  }))

test("does not alter request tools or take ownership of client names", () =>
  runWithWebTools({}, "test", () => {
    const caller = {
      name: "_copilot_web_fetch",
      input_schema: { type: "object" },
    }
    const source = { model: "model", tools: [caller] }
    const result = prepareManagedWebTools(source, "messages")
    expect(source.tools).toEqual([caller])
    expect(result.payload.tools?.[0]).toEqual(caller)
    expect(result.managed.has("_copilot_web_fetch")).toBe(false)
    expect([...result.managed.values()].some((t) => t.kind === "fetch")).toBe(
      true,
    )
  }))

test.each([
  { tool_choice: "none" },
  { tool_choice: { type: "none" } },
  { generate: false },
  {
    system:
      "You are a helpful AI assistant tasked with summarizing conversations. Preserve the prior context.",
  },
  { response_format: { type: "json_schema" } },
  { output_config: { format: { type: "json_schema", schema: {} } } },
  { tools: null },
  { model: "codex-auto-review" },
  { model: "codex-auto-review:low" },
  {
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }),
    },
  },
  { toolConfig: { functionCallingConfig: { mode: "NONE" } } },
])("honors constrained or non-generative requests %j", (source) =>
  runWithWebTools(source, "test", () => {
    expect(
      prepareManagedWebTools({ model: "model" }, "responses").managed.size,
    ).toBe(0)
  }),
)

test("does not add tools to internal calls outside an inference scope", () => {
  expect(webToolsContext()).toBeUndefined()
  expect(
    prepareManagedWebTools({ model: "model" }, "responses").managed.size,
  ).toBe(0)
})

test("service reentry retains ownership of injected tools without duplicate declarations", () =>
  runWithWebTools({}, "test", () => {
    const first = prepareManagedWebTools(
      { tools: [{ type: "function", function: { name: "web_search" } }] },
      "chat",
    )
    const next = prepareManagedWebTools(first.payload, "chat")
    expect(next.payload.tools).toEqual(first.payload.tools)
    expect([...next.managed.keys()]).toEqual([...first.managed.keys()])
  }))

test("translator-generated tools:null is not a client opt-out", () =>
  runWithWebTools({ model: "model", messages: [] }, "test", () => {
    expect(
      prepareManagedWebTools(
        { model: "model", input: [], tools: null },
        "responses",
      ).managed.size,
    ).toBe(2)
  }))

test("a translated-away typed fetch retains its forced name and limits", () => {
  const source = {
    tools: [
      {
        type: "web_fetch",
        name: "get_page",
        allowed_domains: ["example.com"],
        max_uses: 2,
      },
    ],
    tool_choice: { type: "tool", name: "get_page" },
  }
  runWithWebTools(source, "test", () => {
    const result = prepareManagedWebTools(
      { tools: null, tool_choice: { type: "function", name: "get_page" } },
      "responses",
    )
    expect(result.managed.get("get_page")?.limits.allowedDomains).toEqual([
      "example.com",
    ])
    expect(result.payload.tool_choice).toEqual({
      type: "function",
      name: "get_page",
    })
  })
})

test("additional_tools and typed declarations cannot take over client names", () => {
  const caller = { type: "function", name: "web_fetch", parameters: {} }
  const source = {
    tools: [caller, { type: "web_fetch", name: "web_fetch" }],
    input: [
      {
        type: "additional_tools",
        tools: [
          { type: "function", name: "_copilot_web_search", parameters: {} },
        ],
      },
    ],
  }
  runWithWebTools(source, "test", () => {
    const result = prepareManagedWebTools(source, "responses")
    expect(result.payload.tools?.[0]).toEqual(caller)
    expect(result.managed.has("web_fetch")).toBe(false)
    expect(result.managed.has("_copilot_web_search")).toBe(false)
    const names = result.payload.tools?.map((t) => t.name)
    expect(new Set(names).size).toBe(names?.length ?? 0)
  })
})

test("keeps hosted Responses search and translates typed fetch to a custom tool", () =>
  runWithWebTools({}, "test", () => {
    const result = prepareManagedWebTools(
      { tools: [{ type: "web_search" }, { type: "web_fetch", max_uses: 2 }] },
      "responses",
    )
    expect(result.payload.tools?.[0]).toEqual({ type: "web_search" })
    expect([...result.managed.values()].map((t) => t.kind)).toEqual(["fetch"])
    expect([...result.managed.values()][0].maxUses).toBe(2)
    expect(result.payload.tools?.[1]).not.toHaveProperty("max_uses")
  }))
