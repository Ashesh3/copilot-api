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

test("attachment omission notes never expose a supplied URL", async () => {
  const marker = "userinfo:password@private.test/path?signature=secret-marker"
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = mock(() =>
    Promise.resolve(new Response("", { status: 404 })),
  ) as unknown as typeof fetch
  const payload = {
    model: "claude-current",
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: { type: "url" as const, url: `http://${marker}` },
          },
          {
            type: "document" as const,
            source: { type: "url" as const, url: `http://${marker}` },
          },
        ],
      },
    ],
  }

  await normalizeAnthropicAttachments(payload)

  expect(JSON.stringify(payload)).not.toContain(marker)
})

test("does not log redirect, oversize, or timeout secrets", async () => {
  const markers = [
    "redirect-location-secret",
    "oversize-query-secret",
    "timeout-user-secret",
  ]
  const warnSpy = spyOn(consola, "warn")
  try {
    await fetchUrlAsDataUri(`https://example.test/start?secret=${markers[0]}`, {
      fetch: (() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: {
              location: `file:///${markers[0]}`,
            },
          }),
        )) as unknown as typeof fetch,
    })
    await fetchUrlAsDataUri(`https://example.test/a?secret=${markers[1]}`, {
      fetch: (() =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2]), {
            headers: { "content-length": "2" },
          }),
        )) as unknown as typeof fetch,
      maxBytes: 1,
    })
    await fetchUrlAsDataUri(`https://${markers[2]}:pass@example.test/a`, {
      fetch: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              init.signal?.reason instanceof Error ?
                init.signal.reason
              : new Error("attachment aborted"),
            ),
          )
        })) as unknown as typeof fetch,
      timeoutMs: 1,
    })
    const output = JSON.stringify(warnSpy.mock.calls)
    for (const marker of markers) expect(output).not.toContain(marker)
  } finally {
    warnSpy.mockRestore()
  }
})
