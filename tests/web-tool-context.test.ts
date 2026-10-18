import { expect, test } from "bun:test"

import type { WebProtocol } from "~/services/web/tool-context"

import {
  isCallerOwnedWebSearch,
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
    expect(result.managed.size).toBe(0)
  }))

test("preserves Chat custom tools without injecting stateless managed search", () => {
  const source = {
    tools: [
      { type: "custom", custom: { name: "web_search" } },
      { type: "custom", custom: { name: "_copilot_web_search" } },
      { type: "custom", custom: { name: "_copilot_web_search_1" } },
    ],
  }
  runWithWebTools(source, () => {
    const result = prepareManagedWebTools(source, "chat")
    expect(result.payload.tools?.slice(0, 3)).toEqual(source.tools)
    expect([...result.managed.keys()]).toEqual([])
    expect(isCallerOwnedWebSearch("web_search")).toBe(true)
    expect(isCallerOwnedWebSearch("_copilot_web_search")).toBe(true)
    expect(isCallerOwnedWebSearch("_copilot_web_search_1")).toBe(true)
  })
})

test("retains caller ownership when a Chat custom web_search is translated", () => {
  const source = {
    tools: [{ type: "custom", custom: { name: "web_search" } }],
  }
  const translated = {
    tools: [{ type: "function", name: "web_search", parameters: {} }],
  }
  runWithWebTools(source, () => {
    const result = prepareManagedWebTools(translated, "responses")
    expect(result.payload.tools?.[0]).toEqual(translated.tools[0])
    expect([...result.managed.keys()]).toEqual([])
    expect(isCallerOwnedWebSearch("web_search")).toBe(true)
  })
})

const requiredClientTools: Array<{
  name: string
  protocol: WebProtocol
  source: Record<string, unknown>
}> = [
  {
    name: "Chat required function",
    protocol: "chat",
    source: {
      tools: [{ type: "function", function: { name: "get_weather" } }],
      tool_choice: "required",
    },
  },
  {
    name: "Chat required custom tool",
    protocol: "chat",
    source: {
      tools: [{ type: "custom", custom: { name: "get_weather" } }],
      tool_choice: "required",
    },
  },
  {
    name: "Responses required function",
    protocol: "responses",
    source: {
      tools: [{ type: "function", name: "get_weather" }],
      tool_choice: "required",
    },
  },
  {
    name: "Responses required allowed tools",
    protocol: "responses",
    source: {
      tools: [{ type: "function", name: "get_weather" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "get_weather" }],
      },
    },
  },
  {
    name: "Messages any tool",
    protocol: "messages",
    source: {
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    },
  },
  {
    name: "Google ANY function",
    protocol: "chat",
    source: {
      tools: [{ functionDeclarations: [{ name: "get_weather" }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    },
  },
  {
    name: "Google normalized any function",
    protocol: "chat",
    source: {
      tools: [{ functionDeclarations: [{ name: "get_weather" }] }],
      toolConfig: { functionCallingConfig: { mode: "any" } },
    },
  },
]

test.each(requiredClientTools)(
  "$name cannot be fulfilled by a default web tool",
  ({ protocol, source }) =>
    runWithWebTools(source, () => {
      const prepared = prepareManagedWebTools(source, protocol)
      expect(prepared.payload).toEqual(source)
      expect(prepared.managed.size).toBe(0)
      // Translating the payload must not lose the original caller constraint.
      expect(
        prepareManagedWebTools({ model: "translated" }, protocol).managed.size,
      ).toBe(0)
    }),
)

test.each([
  { type: "tool_search", execution: "client", parameters: {} },
  { type: "shell", environment: { type: "local" } },
  { type: "apply_patch" },
  { type: "computer", display_width: 1024, display_height: 768 },
  { type: "client_future_tool" },
])("required unnamed Responses declaration stays caller-owned: %j", (tool) => {
  const source = { tools: [tool], tool_choice: "required" }
  runWithWebTools(source, () => {
    const prepared = prepareManagedWebTools(source, "responses")
    expect(prepared.payload).toEqual(source)
    expect(prepared.managed.size).toBe(0)
    expect(
      prepareManagedWebTools({ model: "translated" }, "messages").managed.size,
    ).toBe(0)
  })
})

test.each(["web_search", "web_search_preview"])(
  "required hosted %s retains its declaration and enabled web context",
  (type) => {
    const source = { tools: [{ type }], tool_choice: "required" }
    runWithWebTools(source, () => {
      const prepared = prepareManagedWebTools(source, "responses")
      expect(webToolsContext()?.enabled).toBe(true)
      expect(prepared.payload).toEqual(source)
      expect(prepared.managed.size).toBe(0)
      // A translated hosted web tool remains eligible for managed execution.
      expect(
        prepareManagedWebTools({ model: "translated" }, "messages").managed
          .size,
      ).toBe(1)
    })
  },
)

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

test("required server-only search remains managed on service reentry", () => {
  const source = {
    model: "model",
    input: "Find the latest release",
    tool_choice: "required",
  }
  runWithWebTools(source, () => {
    const first = prepareManagedWebTools(source, "responses")
    const next = prepareManagedWebTools(first.payload, "responses")
    expect([...first.managed.keys()]).toEqual(["_copilot_web_search"])
    expect([...next.managed.keys()]).toEqual(["_copilot_web_search"])
    expect(next.payload.tools).toEqual(first.payload.tools)
  })
})

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

test.each(["additional_tools", "tool_search_output"])(
  "%s and typed declarations cannot take over client names",
  (type) => {
    const caller = { type: "function", name: "web_search", parameters: {} }
    const source = {
      tools: [caller, { type: "web_search", name: "web_search" }],
      input: [
        {
          type,
          tools: [
            { type: "function", name: "_copilot_web_search", parameters: {} },
          ],
        },
      ],
    }
    runWithWebTools(source, () => {
      const result = prepareManagedWebTools(source, "responses", {
        nativeResponses: true,
      })
      expect(result.payload.tools?.[0]).toEqual(caller)
      expect(result.managed.has("web_search")).toBe(false)
      expect(result.managed.has("_copilot_web_search")).toBe(false)
      expect(result.payload.tools).toEqual(source.tools)
      expect(result.managed.size).toBe(0)
    })
  },
)

test.each(["web_search", "web_search_preview"])(
  "forced native %s remains hosted beside a caller web_search function",
  (type) => {
    const caller = { type: "function", name: "web_search", parameters: {} }
    const hosted = {
      type,
      filters: { allowed_domains: ["example.com"] },
      external_web_access: false,
    }
    const source = {
      tools: [caller, hosted],
      tool_choice: { type },
      input: "search",
    }
    const original = structuredClone(source)
    runWithWebTools(source, () => {
      const result = prepareManagedWebTools(source, "responses", {
        nativeResponses: true,
      })
      expect(result.payload).toEqual(source)
      expect(result.managed.size).toBe(0)
      expect(isCallerOwnedWebSearch("web_search")).toBe(true)
      expect(
        prepareManagedWebTools(result.payload, "responses", {
          nativeResponses: true,
        }).payload,
      ).toEqual(source)
    })
    expect(source).toEqual(original)
  },
)

test("required discovered client tools cannot be fulfilled by default web search", () => {
  const source = {
    input: [
      {
        type: "tool_search_output",
        call_id: "discovery",
        execution: "client",
        tools: [
          { type: "function", name: "_copilot_web_search", parameters: {} },
        ],
      },
    ],
    tool_choice: "required",
  }
  runWithWebTools(source, () => {
    const result = prepareManagedWebTools(source, "responses")
    expect(result.payload).toEqual(source)
    expect(result.managed.size).toBe(0)
    expect(isCallerOwnedWebSearch("_copilot_web_search")).toBe(true)
    expect(
      prepareManagedWebTools({ model: "translated" }, "messages").managed.size,
    ).toBe(0)
  })
})

test("keeps hosted Responses search without adding a separate fetch tool", () =>
  runWithWebTools({}, () => {
    const result = prepareManagedWebTools(
      { tools: [{ type: "web_search" }, { type: "web_fetch", max_uses: 2 }] },
      "responses",
      { nativeResponses: true },
    )
    expect(result.payload.tools?.[0]).toEqual({ type: "web_search" })
    expect(result.managed.size).toBe(0)
    expect(result.payload.tools?.[1]).toEqual({
      type: "web_fetch",
      max_uses: 2,
    })
  }))
