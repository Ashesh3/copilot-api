import { expect, test } from "bun:test"

import { parseDataUri } from "~/lib/attachments"
import { LocalHTTPError } from "~/lib/error"
import {
  recoverResponsesPayload,
  resizeResponsesImage,
  type ResponsesImageResizer,
} from "~/services/copilot/responses-payload-recovery"

const tinyImage = (size: number) => `data:image/png;base64,${"A".repeat(size)}`

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const shrinkToTarget: ResponsesImageResizer = ({
  dataUri,
  targetDataUriBytes,
}) => Promise.resolve(dataUri.slice(0, targetDataUriBytes))

test("returns the original ordinary payload when it is within the hard cap", async () => {
  const payload = { model: "gpt-5.6-sol", input: "hello" }
  const result = await recoverResponsesPayload(payload, {
    maxBytes: 1024,
    recoveryMarginBytes: 64,
    resizeImage: shrinkToTarget,
  })

  expect(result.payload).toBe(payload)
  expect(result.reduced).toBe(false)
})

test("downscales nested tool-result images before removing them", async () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "function_call_output",
        call_id: "call_image",
        output: [{ type: "input_image", image_url: tinyImage(4000) }],
      },
    ],
  }
  const original = structuredClone(payload)
  const result = await recoverResponsesPayload(payload, {
    maxBytes: 1800,
    recoveryMarginBytes: 100,
    resizeImage: shrinkToTarget,
  })

  expect(result.finalBytes).toBeLessThanOrEqual(1700)
  expect(result.downscaledImages).toBe(1)
  expect(result.removedHistoricalBinaries).toBe(0)
  expect(JSON.stringify(result.payload)).toContain("data:image/png;base64")
  expect(payload).toEqual(original)
})

test("removes historical binaries before current-turn binaries", async () => {
  const historyImage = tinyImage(3000)
  const currentImage = `data:image/png;base64,${"C".repeat(3000)}`
  const payload = {
    model: "gpt-5.6-sol",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn_current" }),
    },
    input: [
      {
        type: "function_call_output",
        call_id: "call_history",
        output: [{ type: "input_image", image_url: historyImage }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_old" },
      },
      {
        type: "function_call_output",
        call_id: "call_current",
        output: [{ type: "input_image", image_url: currentImage }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
      },
    ],
  }

  const result = await recoverResponsesPayload(payload, {
    maxBytes: 3900,
    recoveryMarginBytes: 100,
    resizeImage: () => Promise.resolve(null),
  })
  const serialized = JSON.stringify(result.payload)

  expect(result.removedHistoricalBinaries).toBe(1)
  expect(result.removedCurrentBinaries).toBe(0)
  expect(serialized).not.toContain(historyImage)
  expect(serialized).toContain(currentImage)
  expect(serialized).toContain(
    "omitted to fit the CAPI Responses request-size limit",
  )
})

test("removes current-turn binary only as the final recoverable fallback", async () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: tinyImage(3000) }],
      },
    ],
  }

  const result = await recoverResponsesPayload(payload, {
    maxBytes: 1500,
    recoveryMarginBytes: 100,
    resizeImage: () => Promise.resolve(null),
  })

  expect(result.removedCurrentBinaries).toBe(1)
  expect(result.finalBytes).toBeLessThanOrEqual(1400)
})

test("handles nested screenshots and files without changing external descriptors", async () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "function_call_output",
        call_id: "call_nested",
        output: [
          {
            type: "computer_call_output",
            output: {
              type: "computer_screenshot",
              image_url: tinyImage(2000),
            },
          },
          {
            type: "input_file",
            filename: "inline.pdf",
            file_data: `data:application/pdf;base64,${"B".repeat(2000)}`,
          },
          {
            type: "input_file",
            filename: "external.pdf",
            file_data: "https://example.com/external.pdf",
            file_id: "file_external",
          },
        ],
      },
    ],
  }

  const result = await recoverResponsesPayload(payload, {
    maxBytes: 1800,
    recoveryMarginBytes: 100,
    resizeImage: () => Promise.resolve(null),
  })
  const serialized = JSON.stringify(result.payload)

  expect(result.removedHistoricalBinaries).toBe(2)
  expect(serialized).toContain("https://example.com/external.pdf")
  expect(serialized).toContain("file_external")
  expect(serialized).not.toContain("data:image/png;base64")
  expect(serialized).not.toContain("data:application/pdf;base64")
})

test("preserves ordinary tool text commands IDs and ordering", async () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "function_call",
        call_id: "call_keep",
        name: "shell",
        arguments: JSON.stringify({ command: "Get-Date" }),
      },
      {
        type: "function_call_output",
        call_id: "call_keep",
        output: `BEGIN-${"x".repeat(3000)}-END`,
      },
      {
        type: "input_image",
        image_url: tinyImage(3000),
        detail: "high",
      },
    ],
  }

  const result = await recoverResponsesPayload(payload, {
    maxBytes: 3900,
    recoveryMarginBytes: 100,
    resizeImage: () => Promise.resolve(null),
  })
  const recoveredInput = result.payload.input

  expect(recoveredInput[0]).toEqual(payload.input[0])
  expect(recoveredInput[1]).toEqual(payload.input[1])
  expect(JSON.stringify(recoveredInput)).toContain("BEGIN-")
  expect(JSON.stringify(recoveredInput)).toContain("-END")
})

test("raises a safe local 413 when preserved ordinary content cannot fit", async () => {
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "developer",
        content: "preserved".repeat(500),
      },
    ],
  }

  let thrown: unknown
  try {
    await recoverResponsesPayload(payload, {
      maxBytes: 1000,
      recoveryMarginBytes: 100,
      resizeImage: () => Promise.resolve(null),
    })
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(LocalHTTPError)
  const local = thrown as LocalHTTPError
  expect(local.response.status).toBe(413)
  expect(local.clientBody).toMatchObject({
    error: {
      code: "responses_payload_too_large",
      max_bytes: 1000,
      recovery_margin_bytes: 100,
      type: "error",
    },
  })
})

test.skipIf(typeof Bun.Image !== "function")(
  "re-encodes a decodable oversized PNG with Bun.Image",
  async () => {
    const padded = Buffer.concat([
      Buffer.from(PNG_B64, "base64"),
      Buffer.alloc(256 * 1024, 0),
    ])
    const original = `data:image/png;base64,${padded.toString("base64")}`
    const resized = await resizeResponsesImage({
      dataUri: original,
      mediaType: "image/png",
      targetDataUriBytes: 32 * 1024,
    })

    expect(resized).not.toBeNull()
    if (resized === null) throw new Error("Expected a resized PNG data URI")
    expect(Buffer.byteLength(resized)).toBeLessThanOrEqual(32 * 1024)
    expect(parseDataUri(resized)?.mediaType).toBe("image/png")
  },
)
