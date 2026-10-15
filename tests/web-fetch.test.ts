/* eslint-disable @typescript-eslint/require-await -- Async transport fixtures intentionally resolve immediately. */
import { expect, test } from "bun:test"

import { WebDocumentStore } from "~/services/web/document-store"
import { executeWebFetch } from "~/services/web/fetch-page"

test("fetches a redirected page with tables and absolute links without credentials", async () => {
  const headers: Array<Headers> = []
  const result = await executeWebFetch(
    { url: "https://pages.test/start" },
    {
      request: async (url, init) => {
        headers.push(new Headers(init.headers))
        if (url.pathname === "/start")
          return new Response(null, {
            status: 302,
            headers: { location: "/episodes" },
          })
        return new Response(
          '<html><head><title>Episodes</title></head><body><h1>Episodes</h1><table><thead><tr><th>Title</th><th>Date</th></tr></thead><tbody><tr><td>Fame</td><td>2010</td></tr></tbody></table><a href="/next">Next</a><script>runSecret()</script></body></html>',
          {
            headers: { "content-type": "text/html" },
          },
        )
      },
    },
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(result.document.url).toBe("https://pages.test/episodes")
  expect(result.document.title).toBe("Episodes")
  expect(result.content).toContain("| Fame | 2010 |")
  expect(result.document.links).toEqual([
    { id: 1, url: "https://pages.test/next", text: "Next" },
  ])
  expect(result.content).not.toContain("runSecret")
  for (const h of headers) {
    expect(h.has("authorization")).toBe(false)
    expect(h.has("cookie")).toBe(false)
  }
})

test.each([
  ["file:///etc/passwd", "invalid_tool_input"],
  ["https://name:password@pages.test/", "invalid_tool_input"],
])("rejects invalid fetch URL %s before network I/O", async (url, code) => {
  let sent = false
  const result = await executeWebFetch(
    { url },
    {
      request: async () => {
        sent = true
        return new Response("bad")
      },
    },
  )
  expect(result).toMatchObject({ ok: false, code })
  expect(sent).toBe(false)
})

test("reports rate limiting without substituting a summary", async () => {
  const result = await executeWebFetch(
    { url: "https://pages.test/" },
    { request: async () => new Response("Too many requests", { status: 429 }) },
  )
  expect(result).toMatchObject({
    ok: false,
    code: "too_many_requests",
    status: 429,
  })
})

test("applies domain restrictions to redirect targets", async () => {
  let calls = 0
  const result = await executeWebFetch(
    { url: "https://pages.test/" },
    {
      limits: { allowedDomains: ["pages.test"] },
      request: async () => {
        calls++
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.test/" },
        })
      },
    },
  )
  expect(result).toMatchObject({ ok: false, code: "url_not_allowed" })
  expect(calls).toBe(1)
})

test("bounds redirects and cancels oversized downloads", async () => {
  const redirect = await executeWebFetch(
    { url: "https://pages.test/" },
    {
      limits: { maxRedirects: 1 },
      request: async () =>
        new Response(null, { status: 302, headers: { location: "/loop" } }),
    },
  )
  expect(redirect).toMatchObject({ ok: false, code: "redirect_limit" })
  let cancelled = false
  const result = await executeWebFetch(
    { url: "https://pages.test/" },
    {
      limits: { maxBytes: 3 },
      request: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("1234"))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    },
  )
  expect(result).toMatchObject({ ok: false, code: "content_too_large" })
  expect(cancelled).toBe(true)
})

test("deadline covers a body that hangs after headers", async () => {
  let cancelled = false
  const result = await executeWebFetch(
    { url: "https://pages.test/" },
    {
      limits: { timeoutMs: 10 },
      request: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
        ),
    },
  )
  expect(result).toMatchObject({ ok: false, code: "timeout" })
  expect(cancelled).toBe(true)
})

test("caller cancellation is propagated", async () => {
  const controller = new AbortController()
  const promise = executeWebFetch(
    { url: "https://pages.test/" },
    {
      signal: controller.signal,
      request: async () => new Response(new ReadableStream()),
    },
  )
  controller.abort(new DOMException("cancelled", "AbortError"))
  const result = await promise.catch((error: unknown) => error)
  expect(result).toBeInstanceOf(Error)
  expect(String(result)).toContain("cancelled")
})

test("rejects binary formats and invalid pagination", async () => {
  expect(
    await executeWebFetch({ url: "https://pages.test/", start_index: -1 }),
  ).toMatchObject({ ok: false, code: "invalid_tool_input" })
  expect(
    await executeWebFetch(
      { url: "https://pages.test/" },
      {
        request: async () =>
          new Response("PDF", {
            headers: { "content-type": "application/pdf" },
          }),
      },
    ),
  ).toMatchObject({ ok: false, code: "unsupported_content_type" })
})

test("unicode pagination makes progress and reassembles the document", async () => {
  let content = ""
  let offset: number | null = 0
  while (offset !== null) {
    const result = await executeWebFetch(
      { url: "https://pages.test/", max_length: 2, start_index: offset },
      {
        request: async () =>
          new Response("A😀BC", { headers: { "content-type": "text/plain" } }),
      },
    )
    if (!result.ok) throw new Error(result.message)
    content += result.content
    expect(
      result.next_start_index === null || result.next_start_index > offset,
    ).toBe(true)
    offset = result.next_start_index
  }
  expect(content).toBe("A😀BC")
})

test("document references are scoped, expired, and bounded", async () => {
  const page = await executeWebFetch(
    { url: "https://pages.test/" },
    {
      request: async () =>
        new Response("one", { headers: { "content-type": "text/plain" } }),
    },
  )
  if (!page.ok) throw new Error(page.message)
  let now = 0
  const store = new WebDocumentStore({
    now: () => now,
    ttlMs: 10,
    maxDocumentsPerScope: 1,
  })
  const ref = store.put("credential:child-a", page.document)
  expect(ref).not.toBeNull()
  if (ref === null) throw new Error("Expected stored reference")
  expect(store.get("credential:child-b", ref)).toBeUndefined()
  expect(store.get("other:child-a", ref)).toBeUndefined()
  expect(store.get("credential:child-a", ref)?.text).toBe("one")
  const next = store.put("credential:child-a", {
    ...page.document,
    text: "two",
  })
  expect(store.get("credential:child-a", ref)).toBeUndefined()
  expect(store.get("credential:child-a", next ?? "missing")?.text).toBe("two")
  now = 11
  expect(store.get("credential:child-a", next ?? "missing")).toBeUndefined()
})
