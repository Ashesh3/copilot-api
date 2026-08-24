import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import {
  TOKENIZER_EXACT_TEXT_BUDGET_BYTES,
  TOKENIZER_JSON_VALUE_BUDGET,
  estimateTokenCount,
  getTokenCount,
  numTokensForTools,
} from "~/lib/tokenizer"

const model = {
  id: "test-model",
  name: "Test Model",
  object: "model",
  version: "1",
  capabilities: {
    family: "test",
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
} satisfies Model

const payload = (
  content: ChatCompletionsPayload["messages"][number]["content"],
): ChatCompletionsPayload => ({
  model: model.id,
  messages: [{ role: "user", content }],
})

const largeBinaryDataUri = (mediaType: string, sizeBytes: number): string =>
  `data:${mediaType};base64,${randomBytes(sizeBytes).toString("base64")}`

function rejectJsonStringify<T extends object>(value: T): T {
  Object.defineProperty(value, "toJSON", {
    enumerable: false,
    value() {
      throw new Error("unbounded JSON.stringify")
    },
  })
  return value
}

function createRecordingEncoder() {
  const calls: Array<string> = []
  return {
    calls,
    options: {
      loadEncoder: () =>
        Promise.resolve({
          encode(text: string) {
            calls.push(text)
            return Array.from({ length: text.length }, () => 0)
          },
        }),
    },
  }
}

function encodedBytes(calls: Array<string>): number {
  return calls.reduce(
    (total, text) => total + Buffer.byteLength(text, "utf8"),
    0,
  )
}

// eslint-disable-next-line max-lines-per-function -- one safety matrix shares adversarial fixtures
describe("tokenizer safety", () => {
  test("does not send inline image data to the text tokenizer", async () => {
    const { calls, options } = createRecordingEncoder()
    const imageUrl = largeBinaryDataUri("image/jpeg", 8 * 1024 * 1024)

    const count = await getTokenCount(
      payload([
        { type: "text", text: "how's the weather" },
        { type: "image_url", image_url: { url: imageUrl } },
      ]),
      model,
      options,
    )

    expect(calls).toEqual(["user", "how's the weather"])
    expect(count.input).toBeLessThan(1_000)
  })

  test("shares one exact-tokenization budget across oversized text and tools", async () => {
    const { calls, options } = createRecordingEncoder()
    const largeText = randomBytes(TOKENIZER_EXACT_TEXT_BUDGET_BYTES).toString(
      "base64",
    )
    const request = payload([
      { type: "text", text: largeText },
      { type: "text", text: largeText },
    ])
    request.messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "large_call",
          type: "function",
          function: { name: "large_tool", arguments: largeText },
        },
      ],
    })
    request.tools = Array.from({ length: 8 }, (_, index) => ({
      type: "function" as const,
      function: {
        name: `tool_${index}`,
        description: largeText,
        parameters: {
          type: "object",
          properties: {
            value: { type: "string", description: largeText },
          },
        },
      },
    }))

    const count = await getTokenCount(request, model, options)

    expect(calls.length).toBeGreaterThan(0)
    expect(encodedBytes(calls)).toBeLessThanOrEqual(
      TOKENIZER_EXACT_TEXT_BUDGET_BYTES,
    )
    expect(count.input + count.output).toBeGreaterThan(0)
  })

  test("bounds estimateTokenCount for oversized text, files, and tools", async () => {
    const { calls, options } = createRecordingEncoder()
    const largeText = randomBytes(
      TOKENIZER_EXACT_TEXT_BUDGET_BYTES * 2,
    ).toString("base64")
    const request = payload([
      { type: "text", text: largeText },
      {
        type: "image_url",
        image_url: {
          url: largeBinaryDataUri("image/png", 8 * 1024 * 1024),
        },
      },
      {
        type: "file",
        file: {
          filename: "large.pdf",
          file_data: largeBinaryDataUri("application/pdf", 8 * 1024 * 1024),
        },
      },
    ])
    request.tools = [
      {
        type: "function",
        function: {
          name: "large_tool",
          description: largeText,
          parameters: { type: "object", description: largeText },
        },
      },
    ]

    const count = await estimateTokenCount(request, options)

    expect(calls.length).toBeGreaterThan(0)
    expect(encodedBytes(calls)).toBeLessThanOrEqual(
      TOKENIZER_EXACT_TEXT_BUDGET_BYTES,
    )
    expect(count).toBeGreaterThan(0)
  })

  test("does not stringify unbounded tool calls or nested schemas", async () => {
    const { options } = createRecordingEncoder()
    const largeText = "z".repeat(TOKENIZER_EXACT_TEXT_BUDGET_BYTES * 4)
    const toolCall = rejectJsonStringify({
      id: "large_call",
      type: "function" as const,
      function: { name: "large_tool", arguments: largeText },
    })
    const schemaBranch = rejectJsonStringify({
      anyOf: Array.from({ length: 256 }, (_, index) => ({
        type: "object",
        properties: {
          [`value_${index}`]: { type: "string", examples: [largeText] },
        },
      })),
    })
    const request = payload("hello")
    request.messages.push({
      role: "assistant",
      content: null,
      tool_calls: [toolCall],
    })
    request.tools = [
      {
        type: "function",
        function: {
          name: "nested_tool",
          parameters: schemaBranch,
        },
      },
    ]

    const count = await getTokenCount(request, model, options)
    expect(count.input + count.output).toBeGreaterThan(0)
  })

  test("stops inspecting schemas at the shared JSON value budget", async () => {
    const { options } = createRecordingEncoder()
    let highestReadIndex = -1
    const branches = new Proxy(
      Array.from({ length: TOKENIZER_JSON_VALUE_BUDGET * 10 }, () => ({
        type: "string",
      })),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            highestReadIndex = Math.max(highestReadIndex, Number(property))
            if (highestReadIndex >= TOKENIZER_JSON_VALUE_BUDGET) {
              throw new Error("schema traversal exceeded budget")
            }
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      },
    )
    const request = payload("hello")
    request.tools = [
      {
        type: "function",
        function: {
          name: "wide_schema",
          parameters: { anyOf: branches },
        },
      },
    ]

    const count = await getTokenCount(request, model, options)

    expect(count.input).toBeGreaterThan(0)
    expect(highestReadIndex).toBeLessThan(TOKENIZER_JSON_VALUE_BUDGET)
  })

  test("saturates when huge content appears after the value budget", async () => {
    const parts = Array.from({ length: TOKENIZER_JSON_VALUE_BUDGET }, () => ({
      type: "text" as const,
      text: "",
    }))
    parts.push({
      type: "text",
      text: "x".repeat(8 * 1024 * 1024),
    })

    const count = await getTokenCount(payload(parts), model)

    expect(count.input).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("saturates when a huge message appears after the value budget", async () => {
    const request = payload("hello")
    request.messages = Array.from(
      { length: TOKENIZER_JSON_VALUE_BUDGET },
      () => ({ role: "user" as const, content: "" }),
    )
    request.messages.push({
      role: "user",
      content: "x".repeat(8 * 1024 * 1024),
    })

    const count = await getTokenCount(request, model)

    expect(count.input).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("saturates both channels when skipped message roles are unknown", async () => {
    const request = payload("hello")
    request.messages = Array.from(
      { length: TOKENIZER_JSON_VALUE_BUDGET },
      () => ({ role: "user" as const, content: "" }),
    )
    request.messages.push({
      role: "assistant",
      content: "x".repeat(8 * 1024 * 1024),
    })

    const count = await getTokenCount(request, model)

    expect(count).toEqual({
      input: Number.MAX_SAFE_INTEGER,
      output: Number.MAX_SAFE_INTEGER,
    })
  })

  test("clamps the exported tool-only counter after saturation", () => {
    const { calls, options } = createRecordingEncoder()
    const encoderPromise = options.loadEncoder()
    const constants = {
      funcInit: 7,
      propInit: 3,
      propKey: 3,
      enumInit: -3,
      enumItem: 3,
      funcEnd: 12,
    }
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "wide_schema",
          parameters: {
            anyOf: Array.from(
              { length: TOKENIZER_JSON_VALUE_BUDGET * 2 },
              () => ({ type: "string" }),
            ),
          },
        },
      },
    ]

    return encoderPromise.then((encoder) => {
      expect(numTokensForTools(tools, encoder, constants)).toBe(
        Number.MAX_SAFE_INTEGER,
      )
      expect(calls.length).toBeGreaterThan(0)
    })
  })

  test("measures the exact budget in UTF-8 bytes without splitting text", async () => {
    const { calls, options } = createRecordingEncoder()
    const unicodeText = "🙂".repeat(TOKENIZER_EXACT_TEXT_BUDGET_BYTES)

    await getTokenCount(payload(unicodeText), model, options)

    expect(encodedBytes(calls)).toBeLessThanOrEqual(
      TOKENIZER_EXACT_TEXT_BUDGET_BYTES,
    )
    expect(
      calls.every(
        (text) => Buffer.from(text, "utf8").toString("utf8") === text,
      ),
    ).toBe(true)
  })

  test.each(["漢", "🙂"])(
    "does not undercount dense %s text after exhausting the exact budget",
    async (character) => {
      const budgetFiller = "a".repeat(TOKENIZER_EXACT_TEXT_BUDGET_BYTES)
      const text = character.repeat(4_000)
      const { options } = createRecordingEncoder()
      const exactInput =
        6 + "user".length + budgetFiller.length + Array.from(text).length

      const bounded = await getTokenCount(
        payload([
          { type: "text", text: budgetFiller },
          { type: "text", text },
        ]),
        model,
        options,
      )

      expect(bounded.input).toBeGreaterThanOrEqual(exactInput)
    },
  )

  test("preserves exact counts for ordinary text payloads", async () => {
    const count = await getTokenCount(payload("hello"), model)

    expect(count).toEqual({ input: 8, output: 0 })
  })

  test("preserves exact counts for ordinary tool calls and schemas", async () => {
    const request = payload("weather")
    request.messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "weather", arguments: '{"city":"Delhi"}' },
        },
      ],
    })
    request.tools = [
      {
        type: "function",
        function: {
          name: "weather",
          description: "Get weather.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name." },
            },
            required: ["city"],
          },
        },
      },
    ]

    const count = await getTokenCount(request, model)

    expect(count).toEqual({ input: 48, output: 52 })
  })
})
