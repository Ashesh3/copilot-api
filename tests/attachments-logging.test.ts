import { afterEach, expect, mock, spyOn, test } from "bun:test"
import consola from "consola"

import { fetchUrlAsDataUri } from "~/lib/attachments"

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
