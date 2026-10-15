import { expect, test } from "bun:test"

import {
  prepareManagedWebTools,
  runWithWebTools,
  webToolsContext,
} from "~/services/web/tool-context"

test("normal inference gets one search-and-open tool, never a local fetch tool", () =>
  runWithWebTools({}, () => {
    const result = prepareManagedWebTools(
      { model: "model", messages: [] },
      "messages",
    )
    expect([...result.managed.values()].map((t) => t.kind)).toEqual(["search"])
    expect(result.payload.tools).toHaveLength(1)
    expect(JSON.stringify(result.payload.tools)).toContain("URL")
    expect(JSON.stringify(result.payload.tools)).not.toContain("web_fetch")
  }))

test("does not alter request tools or take ownership of client names", () =>
  runWithWebTools({}, () => {
    const caller = {
      name: "_copilot_web_search",
      input_schema: { type: "object" },
    }
    const source = { model: "model", tools: [caller] }
    const result = prepareManagedWebTools(source, "messages")
    expect(source.tools).toEqual([caller])
    expect(result.payload.tools?.[0]).toEqual(caller)
    expect(result.managed.has("_copilot_web_search")).toBe(false)
    expect(result.managed.size).toBe(1)
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
  runWithWebTools(source, () => {
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
  runWithWebTools({}, () => {
    const first = prepareManagedWebTools(
      { tools: [{ type: "function", function: { name: "web_search" } }] },
      "chat",
    )
    const next = prepareManagedWebTools(first.payload, "chat")
    expect(next.payload.tools).toEqual(first.payload.tools)
    expect([...next.managed.keys()]).toEqual([...first.managed.keys()])
  }))

test("translator-generated tools:null is not a client opt-out", () =>
  runWithWebTools({ model: "model", messages: [] }, () => {
    expect(
      prepareManagedWebTools(
        { model: "model", input: [], tools: null },
        "responses",
      ).managed.size,
    ).toBe(1)
  }))

test("typed fetch is not rewritten or executed by the gateway", () => {
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
  runWithWebTools(source, () => {
    const result = prepareManagedWebTools(source, "messages")
    expect(result.managed.has("get_page")).toBe(false)
    expect(result.payload.tools?.[0]).toEqual(source.tools[0])
  })
})

test("additional_tools and typed declarations cannot take over client names", () => {
  const caller = { type: "function", name: "web_search", parameters: {} }
  const source = {
    tools: [caller, { type: "web_search", name: "web_search" }],
    input: [
      {
        type: "additional_tools",
        tools: [
          { type: "function", name: "_copilot_web_search", parameters: {} },
        ],
      },
    ],
  }
  runWithWebTools(source, () => {
    const result = prepareManagedWebTools(source, "responses")
    expect(result.payload.tools?.[0]).toEqual(caller)
    expect(result.managed.has("web_search")).toBe(false)
    expect(result.managed.has("_copilot_web_search")).toBe(false)
    const names = result.payload.tools?.map((t) => t.name)
    expect(new Set(names).size).toBe(names?.length ?? 0)
  })
})

test("keeps hosted Responses search without adding a separate fetch tool", () =>
  runWithWebTools({}, () => {
    const result = prepareManagedWebTools(
      { tools: [{ type: "web_search" }, { type: "web_fetch", max_uses: 2 }] },
      "responses",
    )
    expect(result.payload.tools?.[0]).toEqual({ type: "web_search" })
    expect(result.managed.size).toBe(0)
    expect(result.payload.tools?.[1]).toEqual({
      type: "web_fetch",
      max_uses: 2,
    })
  }))
