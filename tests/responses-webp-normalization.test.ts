import { expect, test } from "bun:test"

import type {
  ResponseInputImage,
  ResponseInputMessage,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import { normalizeResponsesAttachments } from "~/services/copilot/create-responses"

test("transcodes WebP input images before forwarding to Copilot", async () => {
  const webpDataUri = `data:image/webp;base64,${Buffer.from("webp-input").toString("base64")}`
  const jpegDataUri = `data:image/jpeg;base64,${Buffer.from("jpeg-output").toString("base64")}`
  const payload: ResponsesPayload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: webpDataUri, detail: "auto" },
        ],
      },
    ],
  }

  await normalizeResponsesAttachments(payload, undefined, (input) => {
    expect(input.mediaType).toBe("image/webp")
    expect(input.dataUri).toBe(webpDataUri)
    return Promise.resolve({ dataUri: jpegDataUri, outcome: "resized" })
  })

  const message = (payload.input as Array<ResponseInputMessage>)[0]
  const image = (message.content as Array<ResponseInputImage>)[0]
  expect(image.image_url).toBe(jpegDataUri)
})

test("transcodes WebP images fetched from URLs", async () => {
  const originalFetch = globalThis.fetch
  const webpBytes = Buffer.from("fetched-webp")
  const jpegDataUri = `data:image/jpeg;base64,${Buffer.from("jpeg-output").toString("base64")}`
  const payload: ResponsesPayload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.test/image.webp",
            detail: "auto",
          },
        ],
      },
    ],
  }
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
    Promise.resolve(
      new Response(webpBytes, {
        headers: { "content-type": "image/webp" },
      }),
    )) as unknown as typeof fetch

  try {
    await normalizeResponsesAttachments(payload, undefined, (input) => {
      expect(input.dataUri).toBe(
        `data:image/webp;base64,${webpBytes.toString("base64")}`,
      )
      return Promise.resolve({ dataUri: jpegDataUri, outcome: "resized" })
    })
  } finally {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  }

  const message = (payload.input as Array<ResponseInputMessage>)[0]
  const image = (message.content as Array<ResponseInputImage>)[0]
  expect(image.image_url).toBe(jpegDataUri)
})

test("transcodes WebP computer screenshots inside object outputs", async () => {
  const webpDataUri = `data:image/webp;base64,${Buffer.from("webp-screen").toString("base64")}`
  const jpegDataUri = `data:image/jpeg;base64,${Buffer.from("jpeg-screen").toString("base64")}`
  const payload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "computer_call_output",
        call_id: "call_screen",
        output: {
          type: "computer_screenshot",
          image_url: webpDataUri,
        },
      },
    ],
  } as ResponsesPayload

  await normalizeResponsesAttachments(payload, undefined, (input) => {
    expect(input.dataUri).toBe(webpDataUri)
    return Promise.resolve({ dataUri: jpegDataUri, outcome: "resized" })
  })

  const item = (payload.input as Array<Record<string, unknown>>)[0]
  expect(item.output).toEqual({
    type: "computer_screenshot",
    image_url: jpegDataUri,
  })
})
