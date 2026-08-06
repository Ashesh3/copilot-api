import { expect, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import {
  fitResponsesCompactionPayload,
  isResponsesCompactionRequest,
} from "../src/services/copilot/compaction-payload"

test("detects object and JSON-string Codex compaction metadata", () => {
  const turnMetadata = JSON.stringify({ request_kind: "compaction" })

  expect(
    isResponsesCompactionRequest({
      model: "gpt-5.6-sol",
      client_metadata: {
        "x-codex-turn-metadata": turnMetadata,
      },
    }),
  ).toBe(true)
  expect(
    isResponsesCompactionRequest({
      model: "gpt-5.6-sol",
      client_metadata: JSON.stringify({
        "x-codex-turn-metadata": turnMetadata,
      }),
    }),
  ).toBe(true)
  expect(
    isResponsesCompactionRequest({
      model: "gpt-5.6-sol",
      client_metadata: {
        "x-codex-turn-metadata": { request_kind: "compaction" },
      },
    }),
  ).toBe(true)
  expect(
    isResponsesCompactionRequest({
      model: "gpt-5.6-sol",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
      },
    }),
  ).toBe(false)
  expect(
    isResponsesCompactionRequest({
      model: "gpt-5.6-sol",
      client_metadata: { "x-codex-turn-metadata": "not json" },
    }),
  ).toBe(false)
  expect(
    isResponsesCompactionRequest({
      model: "gpt-5.6-sol",
      client_metadata: "not json",
    }),
  ).toBe(false)
})

test("returns the original small payload without mutation", () => {
  const payload = { model: "gpt-5.6-sol", input: "hello" }

  const result = fitResponsesCompactionPayload(payload, 1024)

  expect(result.payload).toBe(payload)
  expect(result).toMatchObject({
    omittedBinaryBlocks: 0,
    reduced: false,
    truncatedToolOutputBytes: 0,
  })
  expect(result.finalBytes).toBe(result.originalBytes)
})

test("elides inline attachments and truncates the largest tool result immutably", () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "keep neighboring text" },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${"a".repeat(2048)}`,
            detail: "high",
          },
          {
            type: "input_file",
            filename: "evidence.pdf",
            file_data: `data:application/pdf;base64,${"b".repeat(2048)}`,
          },
        ],
      },
      {
        type: "custom_tool_call",
        call_id: "call_large",
        name: "exec",
        input: "run the canonical command",
      },
      {
        type: "custom_tool_call_output",
        id: "ctco_large",
        call_id: "call_large",
        status: "completed",
        output: `BEGIN🙂${"x".repeat(7000)}🙂END`,
      },
      {
        type: "function_call_output",
        id: "fco_small",
        call_id: "call_small",
        output: "small result stays exact",
      },
    ],
  }
  const original = structuredClone(payload)

  const result = fitResponsesCompactionPayload(payload, 2400)
  const serialized = JSON.stringify(result.payload)

  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(2400)
  expect(payload).toEqual(original)
  expect(serialized).toContain("keep neighboring text")
  expect(serialized).toContain("run the canonical command")
  expect(serialized).toContain("ctco_large")
  expect(serialized).toContain("call_large")
  expect(serialized).toContain("BEGIN🙂")
  expect(serialized).toContain("🙂END")
  expect(serialized).toContain("small result stays exact")
  expect(serialized).toContain("UTF-8 bytes omitted during compaction")
  expect(serialized).toContain("inline image bytes omitted during compaction")
  expect(serialized).toContain("inline file bytes omitted during compaction")
  expect(serialized).not.toContain("data:image/png;base64")
  expect(serialized).not.toContain("data:application/pdf;base64")
  expect(serialized).not.toContain("�")
  expect(result.omittedBinaryBlocks).toBe(2)
  expect(result.truncatedToolOutputBytes).toBeGreaterThan(0)
  expect(result.reduced).toBe(true)
})

test("truncates text blocks inside tool-output arrays without reordering them", () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "function_call_output",
        call_id: "call_array",
        output: [
          { type: "input_text", text: `FIRST-${"a".repeat(4000)}-FIRST-END` },
          { type: "input_text", text: "middle stays exact" },
          { type: "output_text", text: `LAST-${"z".repeat(3000)}-LAST-END` },
        ],
      },
    ],
  }

  const result = fitResponsesCompactionPayload(payload, 2600)
  const output = (
    result.payload.input[0] as {
      output: Array<{ text: string }>
    }
  ).output

  expect(output).toHaveLength(3)
  expect(output[0]?.text).toStartWith("FIRST-")
  expect(output[0]?.text).toEndWith("-FIRST-END")
  expect(output[1]?.text).toBe("middle stays exact")
  expect(output[2]?.text).toStartWith("LAST-")
  expect(output[2]?.text).toEndWith("-LAST-END")
})

test("raises a local 413 when preserved content alone exceeds the budget", () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "developer",
        content: "preserved".repeat(1000),
      },
    ],
  }

  let thrown: unknown
  try {
    fitResponsesCompactionPayload(payload, 512)
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(HTTPError)
  expect((thrown as HTTPError).response.status).toBe(413)
  expect((thrown as HTTPError).message).toContain(
    "preserved conversation content",
  )
})

test("elides computer screenshots nested in tool output", () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "computer_call_output",
        call_id: "call_screenshot",
        output: {
          type: "computer_screenshot",
          image_url: `data:image/png;base64,${"a".repeat(4096)}`,
        },
      },
    ],
  }

  const result = fitResponsesCompactionPayload(payload, 512)
  const serialized = JSON.stringify(result.payload)

  expect(serialized).toContain("inline image bytes omitted during compaction")
  expect(serialized).not.toContain("data:image/png;base64")
  expect(result.omittedBinaryBlocks).toBe(1)
})

test("preserves textual input_file descriptors while eliding raw base64", () => {
  const textual = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "input_file",
        filename: "reference.pdf",
        file_data: "https://example.com/reference.pdf",
      },
      {
        type: "function_call_output",
        call_id: "call_textual_file",
        output: "reducible output ".repeat(400),
      },
    ],
  }
  const rawBase64 = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "input_file",
        filename: "reference.pdf",
        file_data: "a".repeat(4096),
      },
    ],
  }

  const textualResult = fitResponsesCompactionPayload(textual, 1700)
  expect(textualResult.reduced).toBe(true)
  expect(JSON.stringify(textualResult.payload)).toContain(
    "https://example.com/reference.pdf",
  )
  expect(
    JSON.stringify(fitResponsesCompactionPayload(rawBase64, 512).payload),
  ).toContain("inline file bytes omitted during compaction")
})

test("does not introduce replacement characters for lone surrogates", () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "function_call_output",
        call_id: "call_surrogate",
        output: `BEGIN\ud800${"x".repeat(7000)}\udc00END`,
      },
    ],
  }

  const result = fitResponsesCompactionPayload(payload, 1800)
  const output = (result.payload.input[0] as { output: string }).output

  expect(output).toStartWith("BEGIN\ud800")
  expect(output).toEndWith("\udc00END")
  expect(output.includes("�")).toBe(false)
})

test("keeps valid emoji intact when malformed surrogates force source slicing", () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "function_call_output",
        call_id: "call_mixed_surrogate",
        output:
          `${"a".repeat(510)}🙂PREFIX\ud800`
          + "x".repeat(7000)
          + `\udc00SUFFIX🙂${"z".repeat(510)}`,
      },
    ],
  }

  const result = fitResponsesCompactionPayload(payload, 2300)
  const output = (result.payload.input[0] as { output: string }).output

  expect(
    Array.from(output).filter((character) => character === "🙂"),
  ).toHaveLength(2)
  expect(output.includes("�")).toBe(false)
})
