/* eslint-disable max-lines-per-function -- tolerant source matrix stays reviewable together */
import { describe, expect, test } from "bun:test"

import { LocalHTTPError } from "~/lib/error"
import { prepareChatCompletionsRequest } from "~/routes/chat-completions/chat-contract"

describe("tolerant Chat source preparation", () => {
  test("recovers singleton messages, future roles, and scalar content", () => {
    const prepared = prepareChatCompletionsRequest({
      model: "future-model",
      messages: {
        role: "future-private-role",
        content: 7,
        future: { nested: true },
      },
    })

    expect(prepared.source.messages).toEqual([
      {
        role: "future-private-role",
        content: "7",
        future: { nested: true },
      },
    ])
    expect(prepared.findings).toEqual([
      { class: "message_shape", severity: "adapted" },
      { class: "message_role", severity: "exact" },
      { class: "content_part", severity: "adapted" },
    ])
  })

  test("skips unusable siblings while preserving unknown native content", () => {
    const unknownPart = { type: "future-private-part", payload: { value: 1 } }
    const prepared = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        null,
        12,
        {
          content: [null, "text-scalar", unknownPart],
        },
      ],
    })

    expect(prepared.source.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "text-scalar" }, unknownPart],
      },
    ])
    expect(prepared.findings).toContainEqual({
      class: "message_shape",
      severity: "omitted",
    })
    expect(prepared.findings).toContainEqual({
      class: "message_role",
      severity: "adapted",
    })
  })

  test("preserves incomplete and malformed tool history without global pairing gates", () => {
    const prepared = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "duplicate",
              type: "function",
              function: { name: "first", arguments: "not-json" },
            },
            {
              id: "duplicate",
              type: "future-tool-call",
              function: { name: "second", arguments: 7 },
            },
          ],
        },
        { role: "user", content: "interleaved" },
        { role: "tool", tool_call_id: "orphan", content: "result" },
      ],
    })

    expect(prepared.source.messages).toHaveLength(3)
    expect(prepared.source.messages[0]?.tool_calls).toHaveLength(2)
    expect(prepared.source.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "orphan",
    })
    expect(prepared.findings).toContainEqual({
      class: "tool_history",
      severity: "exact",
    })
  })

  test("merges usable modern and legacy tools without mutating schemas", () => {
    const modernParameters = { type: "", properties: null }
    const payload = {
      model: "future-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        null,
        { type: "future-private-tool", private: true },
        {
          type: "function",
          function: { name: "modern", parameters: modernParameters },
        },
      ],
      functions: [{ name: "legacy", parameters: null }, { name: "" }],
      tool_choice: { type: "future-choice", private: true },
      function_call: { name: "legacy" },
    }

    const prepared = prepareChatCompletionsRequest(payload)

    expect(prepared.source.tools).toEqual([
      { type: "future-private-tool", private: true },
      {
        type: "function",
        function: {
          name: "modern",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "legacy",
          parameters: { type: "object", properties: {} },
        },
      },
    ])
    expect(prepared.source.tool_choice).toEqual({
      type: "future-choice",
      private: true,
    })
    expect(prepared.source).not.toHaveProperty("functions")
    expect(prepared.source).not.toHaveProperty("function_call")
    expect(modernParameters).toEqual({ type: "", properties: null })
  })

  test("drops null token aliases and prefers max_completion_tokens", () => {
    const nulls = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: null,
      max_completion_tokens: null,
    })
    const dual = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 11,
      max_completion_tokens: 22,
    })

    expect(nulls.source).not.toHaveProperty("max_tokens")
    expect(nulls.source).not.toHaveProperty("max_completion_tokens")
    expect(dual.source).toMatchObject({
      max_completion_tokens: 22,
    })
    expect(dual.source).not.toHaveProperty("max_tokens")
  })

  test("prefers max_completion_tokens when translating dual token aliases", () => {
    const prepared = prepareChatCompletionsRequest({
      model: "future-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 11,
      max_completion_tokens: 22,
    })

    expect(prepared.source.max_completion_tokens).toBe(22)
  })

  test("owns a detached serializable source snapshot", () => {
    const payload = {
      model: "future-model",
      messages: [
        {
          role: "user",
          content: [{ type: "future-part", nested: { marker: "private" } }],
        },
      ],
      future: { nested: [1, 2] },
    }
    const prepared = prepareChatCompletionsRequest(payload)

    expect(prepared.source).not.toBe(payload)
    expect(prepared.source.messages).not.toBe(payload.messages)
    expect(prepared.source.future).not.toBe(payload.future)
    ;(prepared.source.future as { nested: Array<number> }).nested.push(3)
    expect(payload.future.nested).toEqual([1, 2])
  })

  test.each([
    { name: "blank model", body: { model: " ", messages: [{ content: "x" }] } },
    {
      name: "no usable message",
      body: { model: "m", messages: [null, 1, {}] },
    },
  ])("keeps the $name hard boundary", ({ body }) => {
    expect(() => prepareChatCompletionsRequest(body)).toThrow(LocalHTTPError)
  })

  test("keeps hostile serialization hard boundaries", () => {
    const cyclic: Record<string, unknown> = {
      model: "m",
      messages: [{ content: "x" }],
    }
    cyclic.self = cyclic

    expect(() => prepareChatCompletionsRequest(cyclic)).toThrow(LocalHTTPError)
    expect(() =>
      prepareChatCompletionsRequest({
        model: "m",
        messages: [{ content: "x" }],
        future: 1n,
      }),
    ).toThrow(LocalHTTPError)
  })

  test("rejects accessor, symbol, function, and sparse-array inputs", () => {
    const accessor = {
      model: "m",
      messages: [{ content: "x" }],
      get privateValue() {
        return "private"
      },
    }
    const symbol = {
      model: "m",
      messages: [{ content: "x" }],
      [Symbol("private")]: "private",
    }
    const fn = {
      model: "m",
      messages: [{ content: "x" }],
      callback: () => "private",
    }
    const messages: Array<unknown> = []
    messages.length = 2
    messages[1] = { content: "x" }

    for (const body of [accessor, symbol, fn, { model: "m", messages }]) {
      expect(() => prepareChatCompletionsRequest(body)).toThrow(LocalHTTPError)
    }
  })

  test("allows repeated acyclic aliases by taking an owned clone", () => {
    const shared = { type: "future-part", nested: { value: 1 } }
    const prepared = prepareChatCompletionsRequest({
      model: "m",
      messages: [
        { role: "user", content: [shared] },
        { role: "user", content: [shared] },
      ],
    })

    const first = (prepared.source.messages[0]?.content as Array<unknown>)[0]
    const second = (prepared.source.messages[1]?.content as Array<unknown>)[0]
    expect(first).not.toBe(shared)
    expect(second).toBe(first)
  })
})
