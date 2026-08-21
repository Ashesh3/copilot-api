/* eslint-disable max-lines-per-function -- protocol matrix remains grouped by adapter */
import { describe, expect, mock, test } from "bun:test"

import {
  InvalidGoogleRequestBodyError,
  prepareGoogleRequest,
} from "~/routes/google-ai/google-request-normalization"
import { adaptGoogleToChatCandidate } from "~/routes/google-ai/request-translation"

const adapt = async (
  payload: Record<string, unknown>,
  options: {
    effort?: "low" | "medium" | "high"
    stream?: boolean
    resolveAttachment?: Parameters<
      typeof adaptGoogleToChatCandidate
    >[0]["resolveAttachment"]
  } = {},
) =>
  await adaptGoogleToChatCandidate({
    source: prepareGoogleRequest(payload),
    finalModel: "gpt-4o-mini",
    stream: options.stream ?? false,
    explicitReasoningEffort: options.effort,
    resolveAttachment: options.resolveAttachment,
  })

describe("Google request preparation", () => {
  test("snapshots an open detached source without reading accessors", () => {
    const payload = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      cachedContent: "keep",
      future: { nested: [1, 2] },
    }
    const prepared = prepareGoogleRequest(payload)
    expect(prepared.source).toEqual(payload)
    expect(prepared.source).not.toBe(payload)
    expect(prepared.source.future as object).not.toBe(payload.future)

    let reads = 0
    const hostile = Object.defineProperty({}, "contents", {
      enumerable: true,
      get() {
        reads += 1
        return []
      },
    })
    expect(() => prepareGoogleRequest(hostile)).toThrow(
      InvalidGoogleRequestBodyError,
    )
    expect(reads).toBe(0)
  })

  test("rejects non-record roots with the fixed local error", () => {
    for (const value of [null, [], "body", 1, true]) {
      expect(() => prepareGoogleRequest(value)).toThrow(
        InvalidGoogleRequestBodyError,
      )
    }
  })

  test("keeps empty parsing separate from post-adaptation fatality", async () => {
    const candidate = await adapt({})
    expect(candidate.check.supported).toBe(false)
    expect(candidate.check.findings).toContainEqual({
      class: "message_shape",
      severity: "fatal",
    })
  })
})

describe("Google tolerant Chat adaptation", () => {
  test("normalizes singleton containers, future roles, and unknown parts", async () => {
    const marker = "private-future-role"
    const candidate = await adapt({
      contents: {
        role: marker,
        parts: [
          { text: "before" },
          { futurePart: { secret: marker } },
          7,
          { text: "after" },
        ],
      },
      systemInstruction: { parts: { futureSystem: true } },
    })
    expect(candidate.check.supported).toBe(true)
    expect(candidate.payload.messages).toEqual([
      {
        role: "system",
        content: "[Unsupported Google content preserved as context]",
      },
      {
        role: "user",
        content:
          "[Future Google role content]before"
          + "[Unsupported Google content preserved as context]"
          + "[Unsupported Google content preserved as context]after",
      },
    ])
    expect(JSON.stringify(candidate.check)).not.toContain(marker)
  })

  test("pairs same-name calls and responses FIFO with collision-safe IDs", async () => {
    const candidate = await adapt({
      contents: [
        {
          role: "model",
          parts: [
            {
              id: "call_0_1",
              functionCall: { name: "lookup", args: { n: 1 } },
            },
            { functionCall: { name: "lookup", args: { n: 2 } } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "lookup", response: { n: 1 } } },
            { text: "middle" },
            { functionResponse: { name: "lookup", response: { n: 2 } } },
          ],
        },
      ],
    })
    const messages = candidate.payload.messages
    expect(
      messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []),
    ).toEqual(["call_0_1", "call_0_1_1"])
    expect(
      messages.slice(2).map((message) => [message.role, message.tool_call_id]),
    ).toEqual([
      ["tool", "call_0_1"],
      ["user", undefined],
      ["tool", "call_0_1_1"],
    ])
  })

  test("repairs recursive schemas from parametersJsonSchema without mutation", async () => {
    const schema = {
      $schema: "marker",
      type: "OBJECT",
      properties: {
        nested: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { value: { type: "STRING" } },
            required: ["value", "missing", "value"],
          },
        },
      },
    }
    const source = {
      contents: [{ role: "user", parts: [{ text: "use tool" }] }],
      tools: {
        functionDeclarations: {
          name: "lookup",
          parameters: "bad",
          parametersJsonSchema: schema,
        },
      },
    }
    const candidate = await adapt(source)
    expect(candidate.payload.tools?.[0]).toMatchObject({
      type: "function",
      function: {
        name: "lookup",
        strict: false,
        parameters: {
          type: "object",
          properties: {
            nested: {
              type: "array",
              items: {
                type: "object",
                required: ["value"],
                properties: { value: { type: "string" } },
              },
            },
          },
        },
      },
    })
    expect(schema.$schema).toBe("marker")
    expect(schema.type).toBe("OBJECT")
  })

  test("maps tool choice, generation, thinking, and public proxy defaults", async () => {
    const candidate = await adapt(
      {
        contents: { role: "user", parts: { text: "hello" } },
        tools: {
          functionDeclarations: [
            { name: "a", parameters: { type: "object" } },
            { name: "b", parameters: { type: "object" } },
          ],
          googleSearch: { max_uses: 3 },
        },
        toolConfig: {
          functionCallingConfig: {
            mode: "any",
            allowedFunctionNames: ["b", 4, "a"],
          },
        },
        generationConfig: {
          maxOutputTokens: 99,
          temperature: 0.2,
          topP: 0.8,
          stopSequences: ["stop"],
          responseSchema: {
            type: "OBJECT",
            properties: { ok: { type: "BOOLEAN" } },
          },
          thinkingConfig: { thinkingBudget: 512 },
        },
      },
      { effort: "high", stream: true },
    )
    expect(candidate.payload).toMatchObject({
      model: "gpt-4o-mini",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 99,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["stop"],
      tool_choice: "required",
      reasoning_effort: "high",
      snippy: { enabled: false },
    })
    expect(candidate.payload.tools?.map((tool) => tool.function.name)).toEqual([
      "a",
      "b",
    ])
    expect(candidate.payload).not.toHaveProperty("parallel_tool_calls")
    expect(candidate.payload.response_format?.type).toBe("json_schema")
  })

  test("degrades failed URL attachment without exposing its URI", async () => {
    const calls: Array<string> = []
    const candidate = await adapt(
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: "before" },
              {
                fileData: {
                  mimeType: "application/pdf",
                  fileUri:
                    "HTTP://USER:PASS@PRIVATE.TEST:80/a.pdf?secret=marker",
                },
              },
              { text: "after" },
            ],
          },
        ],
      },
      {
        resolveAttachment: ({ value }) => {
          calls.push(value)
          return Promise.resolve(null)
        },
      },
    )
    expect(calls).toEqual([
      "HTTP://USER:PASS@PRIVATE.TEST:80/a.pdf?secret=marker",
    ])
    expect(JSON.stringify(candidate.payload)).toContain("before")
    expect(JSON.stringify(candidate.payload)).toContain("after")
    expect(JSON.stringify(candidate.payload)).toContain(
      "[Google attachment unavailable]",
    )
    expect(JSON.stringify(candidate.payload)).not.toContain("secret=marker")
  })

  test("does not resolve parser-invalid attachment values", async () => {
    const resolveAttachment = mock(() => Promise.resolve(null))
    await adapt(
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  mimeType: "application/pdf",
                  fileUri: "file:///private.pdf",
                },
              },
            ],
          },
        ],
      },
      { resolveAttachment },
    )
    expect(resolveAttachment).toHaveBeenCalledTimes(0)
  })

  test("caches identical attachment values separately by PDF expectation", async () => {
    const calls: Array<{ value: string; expectPdf: boolean }> = []
    await adapt(
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  mimeType: "application/pdf",
                  fileUri: "https://attachment.test/a",
                },
              },
              {
                fileData: {
                  mimeType: "image/png",
                  fileUri: "https://attachment.test/a",
                },
              },
              {
                fileData: {
                  mimeType: "application/pdf",
                  fileUri: "https://attachment.test/a",
                },
              },
            ],
          },
        ],
      },
      {
        resolveAttachment: ({ value, expectPdf }) => {
          calls.push({ value, expectPdf })
          return Promise.resolve(null)
        },
      },
    )
    expect(calls).toEqual([
      { value: "https://attachment.test/a", expectPdf: true },
      { value: "https://attachment.test/a", expectPdf: false },
    ])
  })
})
