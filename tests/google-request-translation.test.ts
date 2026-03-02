import { expect, test } from "bun:test"

import { translateGoogleToOpenAI } from "../src/routes/google-ai/request-translation"

test("translates inlineData and fileData parts instead of dropping them", () => {
  const translated = translateGoogleToOpenAI(
    {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Please analyze these inputs." },
            {
              inlineData: {
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
              },
            },
            {
              fileData: {
                mimeType: "application/pdf",
                fileUri: "https://example.com/spec.pdf",
              },
            },
          ],
        },
      ],
    },
    "gpt-4o-mini",
    false,
  )

  const userMessage = translated.messages[0]
  expect(userMessage.role).toBe("user")
  expect(Array.isArray(userMessage.content)).toBe(true)

  const parts = userMessage.content as Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >

  expect(parts.some((part) => part.type === "image_url")).toBe(true)
  expect(
    parts.some(
      (part) =>
        part.type === "image_url"
        && part.image_url.url
          === "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    ),
  ).toBe(true)
  expect(
    parts.some(
      (part) =>
        part.type === "text"
        && part.text
          === "[fileData:application/pdf] https://example.com/spec.pdf",
    ),
  ).toBe(true)
})
