import { describe, expect, test } from "bun:test"

import { parseResponsesBody } from "../ui/src/lib/responses-body"

// A 1x1 PNG keeps the fixture small; the envelope matches a live Copilot
// Images response.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
// The first bytes of a JFIF file: FF D8 FF E0 ... "JFIF".
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQ=="

const USAGE = {
  input_tokens: 20,
  input_tokens_details: { image_tokens: 0, text_tokens: 20 },
  output_tokens: 229,
  output_tokens_details: { image_tokens: 229, text_tokens: 0 },
  total_tokens: 249,
}

const COPILOT_USAGE = {
  token_details: [
    {
      batch_size: 1_000_000,
      cost_per_batch: 3_000_000_000_000,
      model: "gpt-image-2.5-sunburst",
      token_count: 229,
      token_type: "image_output",
    },
  ],
  total_nano_aiu: 697_000_000,
}

function imagesBody(
  data: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    created: 1_791_462_736,
    background: "opaque",
    data,
    output_format: "png",
    quality: "low",
    size: "1254x1254",
    usage: USAGE,
    copilot_usage: COPILOT_USAGE,
    ...overrides,
  })
}

describe("Images API response bodies", () => {
  test("turn Copilot's base64 output into inline data URLs", () => {
    const parsed = parseResponsesBody(imagesBody([{ b64_json: PNG_BASE64 }]))

    expect(parsed).toMatchObject({
      assistantText: "",
      copilotUsage: COPILOT_USAGE,
      errorMessage: null,
      events: [],
      isPartial: false,
      status: null,
      toolCalls: [],
      usage: USAGE,
    })
    expect(parsed?.response?.size).toBe("1254x1254")
    expect(parsed?.images).toEqual([
      {
        byteLength: Buffer.from(PNG_BASE64, "base64").length,
        dataUrl: `data:image/png;base64,${PNG_BASE64}`,
        index: 0,
        mimeType: "image/png",
        revisedPrompt: null,
        url: null,
      },
    ])
  })

  test("trust the file signature over a mislabeled output format", () => {
    const parsed = parseResponsesBody(imagesBody([{ b64_json: JPEG_BASE64 }]))

    expect(parsed?.images?.[0]?.mimeType).toBe("image/jpeg")
    expect(parsed?.images?.[0]?.dataUrl).toBe(
      `data:image/jpeg;base64,${JPEG_BASE64}`,
    )
  })

  test("fall back to the declared format for an unknown signature", () => {
    const parsed = parseResponsesBody(
      imagesBody([{ b64_json: "AAAAAAAA" }], { output_format: "webp" }),
    )

    expect(parsed?.images?.[0]).toMatchObject({
      byteLength: 6,
      dataUrl: "data:image/webp;base64,AAAAAAAA",
      mimeType: "image/webp",
    })
  })

  test("keep remote and malformed images without loading them", () => {
    const parsed = parseResponsesBody(
      imagesBody(
        [
          { b64_json: "not base64!" },
          { url: "https://images.example/cat.png", revised_prompt: "A cat" },
          { b64_json: "AAAAAAAA" },
        ],
        { output_format: undefined },
      ),
    )

    expect(parsed?.images).toEqual([
      {
        byteLength: null,
        dataUrl: null,
        index: 0,
        mimeType: null,
        revisedPrompt: null,
        url: null,
      },
      {
        byteLength: null,
        dataUrl: null,
        index: 1,
        mimeType: null,
        revisedPrompt: "A cat",
        url: "https://images.example/cat.png",
      },
      {
        byteLength: 6,
        dataUrl: null,
        index: 2,
        mimeType: null,
        revisedPrompt: null,
        url: null,
      },
    ])
  })

  test("keep several images in response order", () => {
    const parsed = parseResponsesBody(
      imagesBody([{ b64_json: PNG_BASE64 }, { b64_json: JPEG_BASE64 }]),
    )

    expect(
      parsed?.images?.map((image) => [image.index, image.mimeType]),
    ).toEqual([
      [0, "image/png"],
      [1, "image/jpeg"],
    ])
  })

  test.each([
    [
      "an embeddings list",
      {
        object: "list",
        data: [{ object: "embedding", embedding: [0.1], index: 0 }],
        model: "text-embedding-3-small",
      },
    ],
    [
      "a model list",
      { object: "list", data: [{ id: "gpt-image-2.5-sunburst" }] },
    ],
    ["an empty image list", { created: 1_791_462_736, data: [] }],
    [
      "image entries without a creation time",
      { data: [{ b64_json: PNG_BASE64 }] },
    ],
  ])("leave %s unrecognized", (_case, body) => {
    expect(parseResponsesBody(JSON.stringify(body))).toBeNull()
  })
})
