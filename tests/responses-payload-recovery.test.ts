import { expect, test } from "bun:test"

import { parseDataUri } from "~/lib/attachments"
import { LocalHTTPError } from "~/lib/error"
import {
  recoverResponsesPayload,
  resizeResponsesImage,
  resizeResponsesImageWithFactory,
  type ResponsesImageFactory,
  type ResponsesImageResizer,
} from "~/services/copilot/responses-payload-recovery"

const tinyImage = (size: number) => `data:image/png;base64,${"A".repeat(size)}`

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const shrinkToTarget: ResponsesImageResizer = ({
  dataUri,
  targetDataUriBytes,
}) =>
  Promise.resolve({
    dataUri: dataUri.slice(0, targetDataUriBytes),
    outcome: "resized",
  })

const invalidImage = () => Promise.resolve({ outcome: "invalid" as const })
const unshrinkableImage = () =>
  Promise.resolve({ outcome: "unshrinkable" as const })

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

test("treats one byte below the hard cap as unchanged", async () => {
  const maxBytes = 256
  const payload = { model: "m", input: "" }
  const overheadBytes = Buffer.byteLength(JSON.stringify(payload))
  payload.input = "x".repeat(maxBytes - 1 - overheadBytes)

  const result = await recoverResponsesPayload(payload, {
    maxBytes,
    recoveryMarginBytes: 16,
  })

  expect(Buffer.byteLength(JSON.stringify(payload))).toBe(maxBytes - 1)
  expect(result.payload).toBe(payload)
  expect(result.reduced).toBe(false)
})

test("rejects preserved content exactly at the hard cap", async () => {
  const maxBytes = 256
  const payload = { model: "m", input: "" }
  const overheadBytes = Buffer.byteLength(JSON.stringify(payload))
  payload.input = "x".repeat(maxBytes - overheadBytes)

  let thrown: unknown
  try {
    await recoverResponsesPayload(payload, {
      maxBytes,
      recoveryMarginBytes: 16,
    })
  } catch (error) {
    thrown = error
  }

  expect(Buffer.byteLength(JSON.stringify(payload))).toBe(maxBytes)
  expect(thrown).toBeInstanceOf(LocalHTTPError)
  expect((thrown as LocalHTTPError).clientBody).toMatchObject({
    error: { code: "responses_payload_too_large", payload_bytes: maxBytes },
  })
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

test("removes an invalid image even when another image shrinks enough to fit", async () => {
  const failedImage = `data:image/png;base64,${"F".repeat(1000)}`
  const shrinkableImage = `data:image/png;base64,${"S".repeat(4000)}`
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "function_call_output",
        call_id: "call_mixed_images",
        output: [
          { type: "input_image", image_url: failedImage },
          { type: "input_image", image_url: shrinkableImage },
        ],
      },
    ],
  }

  const result = await recoverResponsesPayload(payload, {
    maxBytes: 3000,
    recoveryMarginBytes: 100,
    resizeImage: ({ dataUri, targetDataUriBytes }) =>
      dataUri === failedImage ? invalidImage() : (
        Promise.resolve({
          dataUri: dataUri.slice(0, targetDataUriBytes),
          outcome: "resized",
        })
      ),
  })
  const serialized = JSON.stringify(result.payload)

  expect(result.downscaledImages).toBe(1)
  expect(result.removedHistoricalBinaries).toBe(1)
  expect(serialized).not.toContain(failedImage)
  expect(serialized).toContain("data:image/png;base64")
  expect(serialized).toContain(
    "omitted to fit the CAPI Responses request-size limit",
  )
})

test("removes a malformed data image when another image shrinks enough to fit", async () => {
  const malformedImage = "data:image/png,not-base64"
  const shrinkableImage = `data:image/png;base64,${"S".repeat(4000)}`
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "function_call_output",
        call_id: "call_malformed_image",
        output: [
          { type: "computer_screenshot", image_url: malformedImage },
          { type: "input_image", image_url: shrinkableImage },
        ],
      },
    ],
  }

  const result = await recoverResponsesPayload(payload, {
    maxBytes: 3000,
    recoveryMarginBytes: 100,
    resizeImage: ({ dataUri, targetDataUriBytes }) =>
      dataUri === malformedImage ? invalidImage() : (
        Promise.resolve({
          dataUri: dataUri.slice(0, targetDataUriBytes),
          outcome: "resized",
        })
      ),
  })
  const serialized = JSON.stringify(result.payload)

  expect(result.downscaledImages).toBe(1)
  expect(result.removedHistoricalBinaries).toBe(1)
  expect(serialized).not.toContain(malformedImage)
  expect(serialized).toContain("data:image/png;base64")
})

test("removes historical binaries before current-turn binaries", async () => {
  const historyImage = tinyImage(2500)
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
        type: "message",
        role: "user",
        content: "inspect the latest screenshot",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
      },
      {
        type: "function_call_output",
        call_id: "call_current",
        output: [{ type: "input_image", image_url: currentImage }],
      },
    ],
  }

  const result = await recoverResponsesPayload(payload, {
    maxBytes: 3900,
    recoveryMarginBytes: 100,
    resizeImage: unshrinkableImage,
  })
  const serialized = JSON.stringify(result.payload)

  expect(result.removedHistoricalBinaries).toBe(1)
  expect(result.removedCurrentBinaries).toBe(0)
  expect(serialized).not.toContain(historyImage)
  expect(serialized).toContain(currentImage)
})

test("keeps an unshrinkable current image when historical removal is sufficient", async () => {
  const historyFile = `data:application/pdf;base64,${"H".repeat(3000)}`
  const currentImage = `data:image/png;base64,${"C".repeat(1500)}`
  const payload = {
    model: "gpt-5.6-sol",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn_current" }),
    },
    input: [
      {
        type: "input_file",
        filename: "history.pdf",
        file_data: historyFile,
      },
      {
        type: "message",
        role: "user",
        content: "use the current screenshot",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
      },
      { type: "input_image", image_url: currentImage },
    ],
  }

  const result = await recoverResponsesPayload(payload, {
    maxBytes: 2050,
    recoveryMarginBytes: 100,
    resizeImage: unshrinkableImage,
  })
  const serialized = JSON.stringify(result.payload)

  expect(result.removedHistoricalBinaries).toBe(1)
  expect(result.removedCurrentBinaries).toBe(0)
  expect(serialized).not.toContain(historyFile)
  expect(serialized).toContain(currentImage)
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
    resizeImage: unshrinkableImage,
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
            output: { type: "computer_screenshot", image_url: tinyImage(2000) },
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
    resizeImage: unshrinkableImage,
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
    resizeImage: unshrinkableImage,
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
      resizeImage: unshrinkableImage,
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

    expect(resized.outcome).toBe("resized")
    if (resized.outcome !== "resized") {
      throw new Error("Expected a resized PNG data URI")
    }
    expect(Buffer.byteLength(resized.dataUri)).toBeLessThanOrEqual(32 * 1024)
    expect(parseDataUri(resized.dataUri)?.mediaType).toBe("image/png")
  },
)

test("transcodes WebP images to JPEG for Copilot Responses", async () => {
  let jpegQuality: number | undefined

  class FakeImage {
    jpeg(options?: { quality?: number }): this {
      jpegQuality = options?.quality
      return this
    }

    metadata(): Promise<{ format: "webp"; height: number; width: number }> {
      return Promise.resolve({ format: "webp", height: 64, width: 64 })
    }

    png(): this {
      throw new Error("WebP normalization must encode JPEG")
    }

    resize(): this {
      throw new Error("WebP normalization must preserve dimensions")
    }

    buffer(): Promise<Buffer> {
      return Promise.resolve(Buffer.from("jpeg-output"))
    }

    webp(): this {
      throw new Error("WebP normalization must not re-encode WebP")
    }
  }

  const imageFactory: ResponsesImageFactory = () => new FakeImage()
  const normalized = await resizeResponsesImageWithFactory(
    {
      dataUri: `data:image/webp;base64,${Buffer.from("webp-input").toString("base64")}`,
      mediaType: "image/webp",
      targetDataUriBytes: Number.MAX_SAFE_INTEGER,
    },
    imageFactory,
  )

  expect(normalized).toEqual({
    dataUri: `data:image/jpeg;base64,${Buffer.from("jpeg-output").toString("base64")}`,
    outcome: "resized",
  })
  expect(jpegQuality).toBe(80)
})

test.skipIf(typeof Bun.Image !== "function")(
  "transcodes a real WebP fixture to a JPEG data URI",
  async () => {
    const webpBase64 =
      "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA="
    const normalized = await resizeResponsesImage({
      dataUri: `data:image/webp;base64,${webpBase64}`,
      mediaType: "image/webp",
      targetDataUriBytes: Number.MAX_SAFE_INTEGER,
    })

    expect(normalized.outcome).toBe("resized")
    if (normalized.outcome !== "resized") {
      throw new Error("Expected a transcoded WebP image")
    }
    const parsed = parseDataUri(normalized.dataUri)
    expect(parsed?.mediaType).toBe("image/jpeg")
    expect(Buffer.from(parsed?.data ?? "", "base64").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    )
  },
)

test("checks the eighth resized image candidate before giving up", async () => {
  let encodeCount = 0

  class FakeImage {
    jpeg(): this {
      return this
    }

    metadata(): Promise<{ format: "png"; height: number; width: number }> {
      return Promise.resolve({ format: "png", height: 100, width: 100 })
    }

    png(): this {
      return this
    }

    resize(): this {
      return this
    }

    buffer(): Promise<Buffer> {
      const bytes = encodeCount === 8 ? 10 : 300
      encodeCount += 1
      return Promise.resolve(Buffer.alloc(bytes))
    }

    webp(): this {
      return this
    }
  }

  const imageFactory: ResponsesImageFactory = () => new FakeImage()
  const resized = await resizeResponsesImageWithFactory(
    {
      dataUri: `data:image/png;base64,${Buffer.alloc(300).toString("base64")}`,
      mediaType: "image/png",
      targetDataUriBytes: 100,
    },
    imageFactory,
  )

  expect(encodeCount).toBe(9)
  expect(resized.outcome).toBe("resized")
  if (resized.outcome !== "resized") {
    throw new Error("Expected the eighth resized image")
  }
  expect(Buffer.byteLength(resized.dataUri)).toBeLessThanOrEqual(100)
})
