/* eslint-disable max-lines, max-lines-per-function, max-params, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-non-null-assertion -- assertions walk untyped wire JSON. */
import { describe, expect, test } from "bun:test"

import type {
  AssistantDiffOp,
  CanonicalItem,
  CanonicalView,
  InterceptPhase,
} from "~/lib/intercept/types"

import {
  applyCanonicalDiffOps,
  CanonicalEditError,
  detectProtocol,
  parseCanonicalView,
  parseSseEvents,
  serializeCanonicalItemsToBody,
} from "~/lib/intercept/canonical"

type Json = Record<string, any>

const SSE = "text/event-stream"

function view(
  path: string,
  phase: InterceptPhase,
  body: string,
  contentType?: string,
) {
  return parseCanonicalView({ path, phase, body, contentType })
}

function edit(
  canonical: CanonicalView,
  body: string,
  ops: Array<AssistantDiffOp>,
  contentType?: string,
): string {
  return serializeCanonicalItemsToBody({
    originalBody: body,
    canonical,
    items: applyCanonicalDiffOps(canonical.items, ops),
    contentType,
  })
}

function itemById(canonical: CanonicalView, id: string): CanonicalItem {
  const item = canonical.items.find((entry) => entry.id === id)
  if (!item) throw new Error(`missing ${id}`)
  return item
}

function sseData(body: string): Array<Json> {
  return parseSseEvents(body)
    .filter((ev) => ev.data && ev.data !== "[DONE]")
    .map((ev) => JSON.parse(ev.data) as Json)
}

function toSse(events: Array<Json>, named: boolean): string {
  return events
    .map((ev) =>
      named ?
        `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
      : `data: ${JSON.stringify(ev)}\n\n`,
    )
    .join("")
}

describe("protocol detection", () => {
  test("embeddings, images and decisions are raw-only generic JSON", () => {
    for (const path of [
      "/embeddings",
      "/v1/images/generations",
      "/v1/decisions",
    ]) {
      const body = JSON.stringify({ model: "m", input: "hello" })
      const parsed = view(path, "request", body)
      expect(parsed.protocol).toBe("generic_json")
      expect(parsed.editable).toBe(false)
      expect(parsed.readOnlyReason).toBeString()
      expect(parsed.items).toEqual([])
      expect(() =>
        serializeCanonicalItemsToBody({
          originalBody: body,
          canonical: parsed,
          items: [],
        }),
      ).toThrow(CanonicalEditError)
    }
    expect(detectProtocol("/embeddings", { input: ["a", "b"] })).toBe(
      "generic_json",
    )
    expect(detectProtocol("/unknown", { input: "hello" })).toBe("generic_json")
  })

  test("upstream error JSON is read-only", () => {
    const parsed = view(
      "/chat/completions",
      "response",
      JSON.stringify({ error: { message: "bad" } }),
    )
    expect(parsed.editable).toBe(false)
  })
})

describe("Chat Completions requests", () => {
  const original = {
    model: "gpt-4o",
    temperature: 0.2,
    messages: [
      { role: "system", content: "Be brief.", name: "policy" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Describe this",
            cache_control: { type: "ephemeral" },
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA", detail: "high" },
          },
        ],
      },
      {
        role: "assistant",
        content: null,
        reasoning_text: "thinking",
        reasoning_opaque: "opaque-blob",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "look", arguments: '{"a":1}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "look", content: "result" },
    ],
  }
  const body = JSON.stringify(original)
  const parsed = view("/chat/completions", "request", body)

  test("parses parts per item; images are opaque placeholders", () => {
    expect(parsed.items.map((i) => i.id)).toEqual([
      "msg-0",
      "msg-1-p-0",
      "msg-1-p-1",
      "msg-2-think",
      "msg-2-tc-0",
      "msg-3",
    ])
    const image = itemById(parsed, "msg-1-p-1")
    expect(image.opaque).toBe(true)
    expect(image.content).toBe("[image]")
  })

  test("editing one text part leaves every other node untouched", () => {
    const out = JSON.parse(
      edit(parsed, body, [
        { op: "replace", id: "msg-1-p-0", content: "Describe it in detail" },
      ]),
    ) as Json
    expect(out.messages[1].content[0]).toEqual({
      type: "text",
      text: "Describe it in detail",
      cache_control: { type: "ephemeral" },
    })
    expect(out.messages[1].content[1]).toEqual(
      original.messages[1].content![1] as Json,
    )
    expect(out.messages[0]).toEqual(original.messages[0])
    expect(out.messages[2]).toEqual(original.messages[2])
    expect(out.messages[3]).toEqual(original.messages[3])
    expect(out.temperature).toBe(0.2)
  })

  test("unchanged items return the original body byte-for-byte", () => {
    expect(
      serializeCanonicalItemsToBody({
        originalBody: body,
        canonical: parsed,
        items: parsed.items,
      }),
    ).toBe(body)
  })

  test("opaque items can be deleted but not edited", () => {
    expect(() =>
      edit(parsed, body, [{ op: "replace", id: "msg-1-p-1", content: "x" }]),
    ).toThrow(CanonicalEditError)
    const changed = parsed.items.map((i) =>
      i.id === "msg-1-p-1" ? { ...i, content: "edited" } : i,
    )
    expect(() =>
      serializeCanonicalItemsToBody({
        originalBody: body,
        canonical: parsed,
        items: changed,
      }),
    ).toThrow(CanonicalEditError)
    const kindChanged = parsed.items.map((i) =>
      i.id === "msg-1-p-1" ? { ...i, kind: "assistant" as const } : i,
    )
    expect(() =>
      serializeCanonicalItemsToBody({
        originalBody: body,
        canonical: parsed,
        items: kindChanged,
      }),
    ).toThrow(CanonicalEditError)

    const out = JSON.parse(
      edit(parsed, body, [{ op: "delete", id: "msg-1-p-1" }]),
    ) as Json
    expect(out.messages[1].content).toEqual([original.messages[1].content![0]])
  })

  test("deleting every part removes the message; deleting reasoning removes its fields", () => {
    const out = JSON.parse(
      edit(parsed, body, [
        { op: "delete", id: "msg-1-p-0" },
        { op: "delete", id: "msg-1-p-1" },
        { op: "delete", id: "msg-2-think" },
      ]),
    ) as Json
    expect(out.messages).toHaveLength(3)
    expect(out.messages[1].reasoning_text).toBeUndefined()
    expect(out.messages[1].reasoning_opaque).toBeUndefined()
    expect(out.messages[1].tool_calls).toEqual(original.messages[2].tool_calls)
  })

  test("a kind change becomes a new message at the same position", () => {
    const items = parsed.items.map((i) =>
      i.id === "msg-0" ? { ...i, kind: "developer" as const } : i,
    )
    const out = JSON.parse(
      serializeCanonicalItemsToBody({
        originalBody: body,
        canonical: parsed,
        items,
      }),
    ) as Json
    expect(out.messages[0]).toEqual({ role: "developer", content: "Be brief." })
    expect(out.messages[1]).toEqual(original.messages[1])
  })

  test("tool arguments: content-only replace updates both; invalid JSON throws", () => {
    const [replaced] = applyCanonicalDiffOps(
      parsed.items.filter((i) => i.id === "msg-2-tc-0"),
      [{ op: "replace", id: "msg-2-tc-0", content: '{"a":2}' }],
    )
    expect(replaced.toolArguments).toBe('{"a":2}')
    expect(replaced.content).toBe('{"a":2}')

    const out = JSON.parse(
      edit(parsed, body, [
        { op: "replace", id: "msg-2-tc-0", content: '{"a":2}' },
      ]),
    ) as Json
    expect(out.messages[2].tool_calls[0].function.arguments).toBe('{"a":2}')
    expect(out.messages[2].tool_calls[0].id).toBe("call_1")

    expect(() =>
      edit(parsed, body, [
        { op: "replace", id: "msg-2-tc-0", toolArguments: "{not json" },
      ]),
    ).toThrow(CanonicalEditError)
    expect(() =>
      edit(parsed, body, [
        {
          op: "insert_after",
          afterId: "msg-2-tc-0",
          kind: "tool_call",
          toolName: "x",
          content: "nope",
        },
      ]),
    ).toThrow(CanonicalEditError)
  })

  test("unknown target IDs are rejected", () => {
    expect(() =>
      applyCanonicalDiffOps(parsed.items, [{ op: "delete", id: "msg-99" }]),
    ).toThrow(CanonicalEditError)
    expect(() =>
      applyCanonicalDiffOps(parsed.items, [
        { op: "insert_after", afterId: "nope", kind: "user", content: "x" },
      ]),
    ).toThrow(CanonicalEditError)
  })

  test("inserted tool calls join the assistant message", () => {
    const out = JSON.parse(
      edit(parsed, body, [
        {
          op: "insert_after",
          afterId: "msg-2-tc-0",
          kind: "tool_call",
          toolName: "more",
          toolCallId: "call_2",
          content: '{"b":true}',
        },
      ]),
    ) as Json
    expect(out.messages).toHaveLength(4)
    expect(out.messages[2].tool_calls[1]).toEqual({
      id: "call_2",
      type: "function",
      function: { name: "more", arguments: '{"b":true}' },
    })
  })
})

describe("Anthropic Messages requests", () => {
  const original: Json = {
    model: "claude-sonnet-4",
    max_tokens: 100,
    system: [
      { type: "text", text: "System A", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look", cache_control: { type: "ephemeral" } },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig-123" },
          { type: "redacted_thinking", data: "enc" },
          {
            type: "text",
            text: "Calling",
            citations: [{ type: "char_location", cited_text: "x" }],
          },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "run",
            input: { cmd: "ls" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        ],
      },
    ],
  }
  const body = JSON.stringify(original)
  const parsed = view("/v1/messages", "request", body)

  test("signed thinking, redacted thinking and images are opaque", () => {
    expect(itemById(parsed, "msg-1-blk-0").opaque).toBe(true)
    expect(itemById(parsed, "msg-1-blk-1").opaque).toBe(true)
    expect(itemById(parsed, "msg-1-blk-1").content).toBe("[redacted thinking]")
    expect(itemById(parsed, "msg-0-blk-1").content).toBe("[image]")
    expect(itemById(parsed, "sys-0").kind).toBe("system")
  })

  test("editing one text block keeps signatures, images and cache_control", () => {
    const out = JSON.parse(
      edit(parsed, body, [
        { op: "replace", id: "msg-0-blk-0", content: "Look closely" },
      ]),
    ) as Json
    expect(out.messages[0].content[0]).toEqual({
      type: "text",
      text: "Look closely",
      cache_control: { type: "ephemeral" },
    })
    expect(out.messages[0].content[1]).toEqual(original.messages[0].content[1])
    expect(out.messages[1]).toEqual(original.messages[1])
    expect(out.messages[2]).toEqual(original.messages[2])
    expect(out.system).toEqual(original.system)
  })

  test("editing system and assistant text keeps per-block fields", () => {
    const out = JSON.parse(
      edit(parsed, body, [
        { op: "replace", id: "sys-0", content: "System B" },
        { op: "replace", id: "msg-1-blk-2", content: "Calling now" },
      ]),
    ) as Json
    expect(out.system).toEqual([
      { type: "text", text: "System B", cache_control: { type: "ephemeral" } },
    ])
    expect(out.messages[1].content[2].citations).toEqual(
      original.messages[1].content[2].citations,
    )
    expect(out.messages[1].content[0]).toEqual(original.messages[1].content[0])
  })

  test("signed thinking cannot be edited or retyped, only removed", () => {
    expect(() =>
      edit(parsed, body, [
        { op: "replace", id: "msg-1-blk-0", content: "other" },
      ]),
    ).toThrow(CanonicalEditError)
    const out = JSON.parse(
      edit(parsed, body, [{ op: "delete", id: "msg-1-blk-0" }]),
    ) as Json
    expect(out.messages[1].content).toEqual(
      original.messages[1].content.slice(1),
    )
  })

  test("tool_use input must be a JSON object", () => {
    expect(() =>
      edit(parsed, body, [
        { op: "replace", id: "msg-1-blk-3", toolArguments: "[1,2]" },
      ]),
    ).toThrow(CanonicalEditError)
    expect(() =>
      edit(parsed, body, [
        { op: "replace", id: "msg-1-blk-3", toolArguments: "{bad" },
      ]),
    ).toThrow(CanonicalEditError)
    const out = JSON.parse(
      edit(parsed, body, [
        { op: "replace", id: "msg-1-blk-3", content: '{"cmd":"pwd"}' },
      ]),
    ) as Json
    expect(out.messages[1].content[3]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "run",
      input: { cmd: "pwd" },
    })
  })

  test("inserted user text after the last message becomes a new message", () => {
    const out = JSON.parse(
      edit(parsed, body, [
        {
          op: "insert_after",
          afterId: "msg-2-blk-0",
          kind: "user",
          content: "Continue",
        },
      ]),
    ) as Json
    expect(out.messages).toHaveLength(4)
    expect(out.messages[3]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Continue" }],
    })
    expect(out.messages[2]).toEqual(original.messages[2])
  })
})

describe("Responses requests", () => {
  const original = {
    model: "gpt-5",
    instructions: "Be helpful",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Find it" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "plan" }],
        encrypted_content: "ENCRYPTED",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "search",
        namespace: "collab",
        arguments: '{"q":"a"}',
        status: "completed",
      },
      { type: "function_call_output", call_id: "call_1", output: "found" },
      {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { query: "x" },
      },
    ],
  }
  const body = JSON.stringify(original)
  const parsed = view("/responses", "request", body)

  test("encrypted reasoning and unknown items are opaque, never dropped", () => {
    expect(parsed.items.map((i) => i.id)).toEqual([
      "sys-0",
      "in-0-p-0",
      "in-0-p-1",
      "in-1",
      "in-2",
      "in-3",
      "in-4",
    ])
    expect(itemById(parsed, "in-1").opaque).toBe(true)
    expect(itemById(parsed, "in-4").opaque).toBe(true)
    expect(itemById(parsed, "in-4").content).toBe("[web_search_call]")
  })

  test("editing function_call arguments preserves namespace and ids", () => {
    const out = JSON.parse(
      edit(parsed, body, [
        { op: "replace", id: "in-2", toolArguments: '{"q":"b"}' },
      ]),
    ) as Json
    expect(out.input[2]).toEqual({
      ...original.input[2],
      arguments: '{"q":"b"}',
    })
    expect(out.input[1]).toEqual(original.input[1])
    expect(out.input[4]).toEqual(original.input[4])
    expect(out.input[0]).toEqual(original.input[0])
    expect(out.instructions).toBe("Be helpful")
  })

  test("text part edits keep the image part; deleting instructions removes the key", () => {
    const out = JSON.parse(
      edit(parsed, body, [
        { op: "replace", id: "in-0-p-0", content: "Find it now" },
        { op: "delete", id: "sys-0" },
      ]),
    ) as Json
    expect(out.input[0].content).toEqual([
      { type: "input_text", text: "Find it now" },
      original.input[0].content![1],
    ])
    expect("instructions" in out).toBe(false)
  })

  test("encrypted reasoning cannot be edited", () => {
    expect(() =>
      edit(parsed, body, [{ op: "replace", id: "in-1", content: "new plan" }]),
    ).toThrow(CanonicalEditError)
  })

  test("string input stays a string when edited", () => {
    const simple = JSON.stringify({ model: "gpt-5", input: "hi" })
    const simpleView = view("/responses", "request", simple)
    const out = JSON.parse(
      edit(simpleView, simple, [
        { op: "replace", id: "in-0", content: "hello" },
      ]),
    ) as Json
    expect(out.input).toBe("hello")
  })
})

describe("JSON responses", () => {
  test("Chat n=2 keeps both choices and the reasoning_text field", () => {
    const original = {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "A",
            reasoning_text: "r0",
            reasoning_opaque: "o0",
          },
          finish_reason: "stop",
        },
        {
          index: 1,
          message: { role: "assistant", content: "B" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }
    const body = JSON.stringify(original)
    const parsed = view("/chat/completions", "response", body)
    expect(parsed.items.map((i) => i.id)).toEqual([
      "out-0-think",
      "out-0",
      "out-1",
    ])

    const out = JSON.parse(
      edit(parsed, body, [
        { op: "replace", id: "out-1", content: "B2" },
        { op: "replace", id: "out-0-think", content: "r0 edited" },
      ]),
    ) as Json
    expect(out.choices).toHaveLength(2)
    expect(out.choices[1].message.content).toBe("B2")
    expect(out.choices[0].message.reasoning_text).toBe("r0 edited")
    expect(out.choices[0].message.reasoning_content).toBeUndefined()
    expect(out.choices[0].message.reasoning_opaque).toBe("o0")
    expect(out.usage).toEqual(original.usage)
    expect(out.id).toBe("chatcmpl-1")

    const deleted = JSON.parse(
      edit(parsed, body, [{ op: "delete", id: "out-0-think" }]),
    ) as Json
    expect(deleted.choices[0].message).toEqual({
      role: "assistant",
      content: "A",
    })
    expect(deleted.choices[1]).toEqual(original.choices[1])
  })

  test("Chat finish_reason follows tool-call presence", () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
    })
    const parsed = view("/chat/completions", "response", body)
    const added = JSON.parse(
      edit(parsed, body, [
        {
          op: "insert_after",
          afterId: "out-0",
          kind: "tool_call",
          toolName: "t",
          content: "{}",
        },
      ]),
    ) as Json
    expect(added.choices[0].finish_reason).toBe("tool_calls")
    expect(added.choices[0].message.tool_calls[0].function).toEqual({
      name: "t",
      arguments: "{}",
    })

    const withCall = JSON.stringify(added)
    const callView = view("/chat/completions", "response", withCall)
    const removed = JSON.parse(
      edit(callView, withCall, [{ op: "delete", id: "out-0-tc-0" }]),
    ) as Json
    expect(removed.choices[0].finish_reason).toBe("stop")
    expect(removed.choices[0].message.tool_calls).toBeUndefined()
  })

  test("Anthropic keeps signature, ids, usage and reconciles stop_reason", () => {
    const original = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [
        { type: "thinking", thinking: "t", signature: "sig" },
        { type: "text", text: "Hello" },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 7 },
    }
    const body = JSON.stringify(original)
    const parsed = view("/v1/messages", "response", body)
    const out = JSON.parse(
      edit(parsed, body, [
        { op: "replace", id: "out-1", content: "Hi" },
        {
          op: "insert_after",
          afterId: "out-1",
          kind: "tool_call",
          toolName: "run",
          toolCallId: "toolu_9",
          content: '{"x":1}',
        },
      ]),
    ) as Json
    expect(out.content[0]).toEqual(original.content[0])
    expect(out.content[1]).toEqual({ type: "text", text: "Hi" })
    expect(out.content[2]).toEqual({
      type: "tool_use",
      id: "toolu_9",
      name: "run",
      input: { x: 1 },
    })
    expect(out.stop_reason).toBe("tool_use")
    expect(out.usage).toEqual(original.usage)
    expect(out.id).toBe("msg_1")
    expect(() =>
      edit(parsed, body, [
        {
          op: "insert_after",
          afterId: "out-1",
          kind: "thinking",
          content: "x",
        },
      ]),
    ).toThrow(CanonicalEditError)
  })

  test("Responses recomputes or removes output_text", () => {
    const original = {
      id: "resp_1",
      object: "response",
      status: "completed",
      model: "gpt-5",
      output: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "E" },
        {
          type: "message",
          id: "msg_1",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Old", annotations: [] }],
        },
      ],
      output_text: "Old",
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    }
    const body = JSON.stringify(original)
    const parsed = view("/responses", "response", body)
    const out = JSON.parse(
      edit(parsed, body, [{ op: "replace", id: "out-1-p-0", content: "New" }]),
    ) as Json
    expect(out.output_text).toBe("New")
    expect(out.output[0]).toEqual(original.output[0])
    expect(out.output[1].id).toBe("msg_1")
    expect(out.usage).toEqual(original.usage)

    const removed = JSON.parse(
      edit(parsed, body, [{ op: "delete", id: "out-1-p-0" }]),
    ) as Json
    expect(removed.output).toHaveLength(1)
    expect("output_text" in removed).toBe(false)
  })
})

describe("SSE responses", () => {
  test("Chat stream keeps ids, usage, choices and [DONE]", () => {
    const base = {
      id: "chatcmpl-9",
      object: "chat.completion.chunk",
      created: 123,
      model: "gpt-4o",
      system_fingerprint: "fp",
    }
    const body =
      toSse(
        [
          {
            ...base,
            choices: [
              { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
          },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: { reasoning_text: "think" },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: { reasoning_opaque: "OP" },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [
              { index: 0, delta: { content: "Hel" }, finish_reason: null },
            ],
          },
          {
            ...base,
            choices: [
              { index: 0, delta: { content: "lo" }, finish_reason: null },
            ],
          },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          },
        ],
        false,
      ) + "data: [DONE]\n\n"
    const parsed = view("/chat/completions", "response", body, SSE)
    expect(parsed.editable).toBe(true)
    expect(itemById(parsed, "out-0").content).toBe("Hello")

    const rebuilt = edit(
      parsed,
      body,
      [{ op: "replace", id: "out-0", content: "Bye" }],
      SSE,
    )
    expect(rebuilt.endsWith("data: [DONE]\n\n")).toBe(true)
    const chunks = sseData(rebuilt)
    for (const chunk of chunks) {
      expect(chunk.id).toBe("chatcmpl-9")
      expect(chunk.created).toBe(123)
      expect(chunk.system_fingerprint).toBe("fp")
    }
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    })
    expect(
      chunks.some((c) => c.choices[0].delta.reasoning_text === "think"),
    ).toBe(true)
    expect(
      chunks.some((c) => c.choices[0].delta.reasoning_opaque === "OP"),
    ).toBe(true)
    const reparsed = view("/chat/completions", "response", rebuilt, SSE)
    expect(itemById(reparsed, "out-0").content).toBe("Bye")
    expect(itemById(reparsed, "out-0-think").content).toBe("think")

    const noDone = body.replace("data: [DONE]\n\n", "")
    const noDoneView = view("/chat/completions", "response", noDone, SSE)
    expect(
      edit(
        noDoneView,
        noDone,
        [{ op: "replace", id: "out-0", content: "x" }],
        SSE,
      ),
    ).not.toContain("[DONE]")
  })

  test("Chat stream with n=2 and a separate usage chunk", () => {
    const base = {
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
    }
    const usageChunk = { ...base, choices: [], usage: { total_tokens: 9 } }
    const body = toSse(
      [
        {
          ...base,
          choices: [
            { index: 0, delta: { content: "A" }, finish_reason: null },
            { index: 1, delta: { content: "B" }, finish_reason: null },
          ],
        },
        {
          ...base,
          choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
            { index: 1, delta: {}, finish_reason: "stop" },
          ],
        },
        usageChunk,
      ],
      false,
    )
    const parsed = view("/chat/completions", "response", body, SSE)
    expect(parsed.items.map((i) => i.id)).toEqual(["out-0", "out-1"])
    const rebuilt = edit(
      parsed,
      body,
      [
        {
          op: "insert_after",
          afterId: "out-1",
          kind: "tool_call",
          toolName: "t",
          toolCallId: "call_x",
          content: "{}",
        },
      ],
      SSE,
    )
    const chunks = sseData(rebuilt)
    expect(chunks.at(-1)).toEqual(usageChunk)
    const finishes = chunks
      .flatMap((c) => c.choices as Array<Json>)
      .filter((c) => c.finish_reason)
      .map((c) => [c.index, c.finish_reason])
    expect(finishes).toEqual([
      [0, "stop"],
      [1, "tool_calls"],
    ])
  })

  test("Anthropic stream keeps id, usage, signature and tool input", () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_7",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 11,
            output_tokens: 1,
            cache_read_input_tokens: 4,
          },
        },
      },
      { type: "ping" },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "ponder" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "SIG" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: "RD" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 2 },
      {
        type: "content_block_start",
        index: 3,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "run",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 3,
        delta: { type: "input_json_delta", partial_json: '{"cmd":' },
      },
      {
        type: "content_block_delta",
        index: 3,
        delta: { type: "input_json_delta", partial_json: '"ls"}' },
      },
      { type: "content_block_stop", index: 3 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 42 },
      },
      { type: "message_stop" },
    ]
    const body = toSse(events, true)
    const parsed = view("/v1/messages", "response", body, SSE)
    expect(parsed.editable).toBe(true)
    expect(itemById(parsed, "out-0").opaque).toBe(true)
    expect(itemById(parsed, "out-3").toolArguments).toBe(
      JSON.stringify({ cmd: "ls" }, null, 2),
    )

    const rebuilt = edit(
      parsed,
      body,
      [{ op: "replace", id: "out-2", content: "Hi" }],
      SSE,
    )
    const out = sseData(rebuilt)
    expect(out[0]).toEqual(events[0])
    expect(
      out.find((e) => e.delta?.type === "signature_delta")?.delta.signature,
    ).toBe("SIG")
    expect(
      out.find((e) => e.content_block?.type === "redacted_thinking")
        ?.content_block,
    ).toEqual({ type: "redacted_thinking", data: "RD" })
    expect(
      out.find((e) => e.delta?.type === "input_json_delta")?.delta.partial_json,
    ).toBe('{"cmd":"ls"}')
    const messageDelta = out.find((e) => e.type === "message_delta")
    expect(messageDelta?.usage).toEqual({ output_tokens: 42 })
    expect(messageDelta?.delta.stop_reason).toBe("tool_use")
    expect(out.at(-1)).toEqual({ type: "message_stop" })

    const reparsed = view("/v1/messages", "response", rebuilt, SSE)
    expect(reparsed.items.map((i) => i.content)).toEqual(
      parsed.items.map((i) => (i.id === "out-2" ? "Hi" : i.content)),
    )

    const noTool = edit(parsed, body, [{ op: "delete", id: "out-3" }], SSE)
    expect(
      sseData(noTool).find((e) => e.type === "message_delta")?.delta
        .stop_reason,
    ).toBe("end_turn")
  })

  test("Responses stream keeps ids, usage, terminal event and full lifecycle", () => {
    const created = {
      id: "resp_42",
      object: "response",
      status: "in_progress",
      model: "gpt-5",
      output: [],
    }
    const msgItem = {
      id: "msg_1",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Partial", annotations: [] }],
    }
    const fcItem = {
      id: "fc_1",
      type: "function_call",
      status: "completed",
      call_id: "call_1",
      name: "run",
      namespace: "ns",
      arguments: '{"a":1}',
    }
    const finalResponse = {
      ...created,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [msgItem, fcItem],
      usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
    }
    const events = [
      { type: "response.created", sequence_number: 0, response: created },
      { type: "response.in_progress", sequence_number: 1, response: created },
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: { ...msgItem, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 3,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "Partial",
      },
      {
        type: "response.output_item.done",
        sequence_number: 4,
        output_index: 0,
        item: msgItem,
      },
      {
        type: "response.output_item.done",
        sequence_number: 5,
        output_index: 1,
        item: fcItem,
      },
      {
        type: "response.incomplete",
        sequence_number: 6,
        response: finalResponse,
      },
    ]
    const body = toSse(events, true)
    const parsed = view("/responses", "response", body, SSE)
    expect(parsed.editable).toBe(true)
    expect(parsed.stopReason).toBe("incomplete")

    const rebuilt = edit(
      parsed,
      body,
      [{ op: "replace", id: "out-0-p-0", content: "Edited" }],
      SSE,
    )
    const out = sseData(rebuilt)
    expect(out.map((e) => e.sequence_number)).toEqual(out.map((_, i) => i))
    expect(out.map((e) => e.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.incomplete",
    ])
    const terminal = out.at(-1)!
    expect(terminal.response.id).toBe("resp_42")
    expect(terminal.response.status).toBe("incomplete")
    expect(terminal.response.incomplete_details).toEqual({
      reason: "max_output_tokens",
    })
    expect(terminal.response.usage).toEqual(finalResponse.usage)
    expect(terminal.response.output[1]).toEqual(fcItem)
    expect(terminal.response.output[0].content[0].text).toBe("Edited")
    expect(out[0].response).toEqual(created)
    for (const event of parseSseEvents(rebuilt)) {
      expect(event.event).toBe((JSON.parse(event.data) as Json).type)
    }

    const reparsed = view("/responses", "response", rebuilt, SSE)
    expect(itemById(reparsed, "out-0-p-0").content).toBe("Edited")
    expect(reparsed.stopReason).toBe("incomplete")
  })

  test("truncated or failed streams are read-only", () => {
    const chat =
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hal"},"finish_reason":null}]}\n\n'
    const anthropic = toSse(
      [
        { type: "message_start", message: { id: "m", content: [], usage: {} } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hal" },
        },
      ],
      true,
    )
    const responses = toSse(
      [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "r", output: [] },
        },
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          delta: "Hal",
        },
      ],
      true,
    )
    const errored = toSse(
      [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: "r", output: [] },
        },
        { type: "error", sequence_number: 1, message: "boom" },
        {
          type: "response.failed",
          sequence_number: 2,
          response: { id: "r", status: "failed", output: [] },
        },
      ],
      true,
    )
    for (const [path, body] of [
      ["/chat/completions", chat],
      ["/v1/messages", anthropic],
      ["/responses", responses],
      ["/responses", errored],
    ] as const) {
      const parsed = view(path, "response", body, SSE)
      expect(parsed.editable).toBe(false)
      expect(parsed.readOnlyReason).toBeString()
      expect(() =>
        serializeCanonicalItemsToBody({
          originalBody: body,
          canonical: parsed,
          items: parsed.items,
          contentType: SSE,
        }),
      ).toThrow(CanonicalEditError)
    }
  })
})
