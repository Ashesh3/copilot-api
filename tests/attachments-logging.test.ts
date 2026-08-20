import { afterEach, expect, mock, spyOn, test } from "bun:test"
import consola from "consola"

import { fetchUrlAsDataUri } from "~/lib/attachments"
import { normalizeAnthropicAttachments } from "~/routes/messages/attachment-normalization"

const originalFetch = globalThis.fetch

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("does not log signed attachment URLs or upstream status text", async () => {
  const urlMarker = "signed-url-private-marker"
  const statusMarker = "attachment-private-status"
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(() =>
    Promise.resolve(
      new Response("", { status: 403, statusText: statusMarker }),
    ),
  ) as unknown as typeof fetch
  const warnSpy = spyOn(consola, "warn")

  try {
    expect(
      await fetchUrlAsDataUri(
        `https://example.test/image.webp?signature=${urlMarker}`,
      ),
    ).toBeNull()
    const output = JSON.stringify(warnSpy.mock.calls)
    expect(output).not.toContain(urlMarker)
    expect(output).not.toContain(statusMarker)
  } finally {
    warnSpy.mockRestore()
  }
})

test("does not log attachment transport error details", async () => {
  const urlMarker = "transport-url-private-marker"
  const errorMarker = "transport-error-private-marker"
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(() => {
    throw new Error(errorMarker)
  }) as unknown as typeof fetch
  const warnSpy = spyOn(consola, "warn")

  try {
    expect(
      await fetchUrlAsDataUri(
        `https://example.test/image.webp?signature=${urlMarker}`,
      ),
    ).toBeNull()
    const output = JSON.stringify(warnSpy.mock.calls)
    expect(output).not.toContain(urlMarker)
    expect(output).not.toContain(errorMarker)
  } finally {
    warnSpy.mockRestore()
  }
})

test.each([
  {
    content: {
      type: "image" as const,
      source: {
        type: "url" as const,
        url: "https://example.test/image.png?signature=image-url-private-marker",
      },
    },
    marker: "image-url-private-marker",
  },
  {
    content: {
      type: "document" as const,
      source: {
        type: "url" as const,
        url: "https://example.test/report.pdf?signature=document-url-private-marker",
      },
    },
    marker: "document-url-private-marker",
  },
])(
  "does not log raw $content.type attachment descriptors",
  async ({ content, marker }) => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(() =>
      Promise.resolve(new Response("", { status: 404 })),
    ) as unknown as typeof fetch
    const warnSpy = spyOn(consola, "warn")

    try {
      const payload = {
        model: "claude-current",
        messages: [{ role: "user" as const, content: [content] }],
      }
      await normalizeAnthropicAttachments(payload)

      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(marker)
    } finally {
      warnSpy.mockRestore()
    }
  },
)
