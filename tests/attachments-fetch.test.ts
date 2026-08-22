import { expect, mock, test } from "bun:test"

import * as attachmentsModule from "~/lib/attachments"

test("defines parser-only attachment recovery defaults", () => {
  expect(attachmentsModule.ATTACHMENT_FETCH_MAX_BYTES).toBe(3_145_728)
  expect(attachmentsModule.ATTACHMENT_FETCH_MAX_REDIRECTS).toBe(5)
  expect(attachmentsModule.ATTACHMENT_FETCH_TIMEOUT_MS).toBe(15_000)
  expect(
    attachmentsModule.parseFetchableHttpUrl("http://user:pass@127.1/a"),
  ).toEqual(new URL("http://user:pass@127.1/a"))
  expect(
    attachmentsModule.parseFetchableHttpUrl("file:///private.txt"),
  ).toBeNull()
  expect(attachmentsModule.parseFetchableHttpUrl("relative/path")).toBeNull()
})

test.each([
  "https://example.test/a.png",
  "http://localhost/a.png",
  "http://127.0.0.1/a.png",
  "http://[::1]/a.png",
  "http://10.0.0.1/a.png",
  "http://[fd00::1]/a.png",
  "http://169.254.169.254/latest/meta-data",
  "http://metadata.google.internal/a.png",
  "http://intranet/a.png",
  "http://user:pass@private.test/a.png",
  "http://127.1/a.png",
  "http://2130706433/a.png",
  "http://0x7f000001/a.png",
  "HTTP://EXAMPLE.TEST:80/a/../b.png",
  String.raw`http:\localhost\image.png`,
])("fetches every runtime-valid HTTP(S) target %s", async (value) => {
  const calls: Array<{ init?: RequestInit; url: URL }> = []
  const fetchMock = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      )
      calls.push({ init, url })
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
      )
    },
  )

  const result = await attachmentsModule.fetchUrlAsDataUri(value, {
    fetch: fetchMock as unknown as typeof fetch,
  } as never)

  expect(result).toEqual({ data: "AQID", mediaType: "image/png" })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url.href).toBe(new URL(value).href)
  expect(calls[0]?.init).toMatchObject({
    credentials: "omit",
    headers: { accept: "*/*" },
    redirect: "manual",
  })
})

test.each([
  "",
  "relative/path",
  "data:image/png;base64,AQID",
  "file:///private.png",
  "ftp://example.test/a.png",
  "http://[::1",
  "http://example.test:99999/a.png",
])("does not fetch parser-invalid or non-HTTP value %s", async (value) => {
  const fetchMock = mock(() => Promise.reject(new Error("must not fetch")))
  const result = await attachmentsModule.fetchUrlAsDataUri(value, {
    fetch: fetchMock as unknown as typeof fetch,
  } as never)
  expect(result).toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test("follows manual redirects through unrestricted targets and uses final media", async () => {
  const requested: Array<string> = []
  const fetchMock = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      )
      requested.push(url.href)
      expect(init?.redirect).toBe("manual")
      if (requested.length === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://user:pass@127.1/final.pdf" },
          }),
        )
      }
      return Promise.resolve(new Response(new Uint8Array([4, 5, 6])))
    },
  )

  const result = await attachmentsModule.fetchUrlAsDataUri(
    "https://public.test/start",
    { fetch: fetchMock as unknown as typeof fetch } as never,
  )

  expect(requested).toEqual([
    "https://public.test/start",
    "http://user:pass@127.0.0.1/final.pdf",
  ])
  expect(result).toEqual({ data: "BAUG", mediaType: "application/pdf" })
})

test("allows exactly maxRedirects and rejects one more without fetching it", async () => {
  const requested: Array<string> = []
  const fetchMock = mock((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requested.push(url.href)
    const hop = Number(url.pathname.slice(1))
    return Promise.resolve(
      hop < 6 ?
        new Response(null, {
          status: 307,
          headers: { location: `/${hop + 1}` },
        })
      : new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/png" },
        }),
    )
  })

  expect(
    await attachmentsModule.fetchUrlAsDataUri("https://redirect.test/0", {
      fetch: fetchMock as unknown as typeof fetch,
      maxRedirects: 5,
    } as never),
  ).toBeNull()
  expect(requested).toEqual([
    "https://redirect.test/0",
    "https://redirect.test/1",
    "https://redirect.test/2",
    "https://redirect.test/3",
    "https://redirect.test/4",
    "https://redirect.test/5",
  ])
})

test.each([
  { status: 301, location: null },
  { status: 302, location: "file:///private" },
  { status: 303, location: "http://[::1" },
])("rejects unusable redirect %#", async ({ location, status }) => {
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(null, {
        status,
        headers: location ? { location } : undefined,
      }),
    ),
  )
  expect(
    await attachmentsModule.fetchUrlAsDataUri("https://redirect.test/start", {
      fetch: fetchMock as unknown as typeof fetch,
    } as never),
  ).toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("cancels a declared-oversize body without retaining or reading content", async () => {
  let pulls = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
    pull() {
      pulls += 1
      return new Promise<void>(() => {})
    },
  })
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(body, {
        headers: {
          "content-length": "4",
          "content-type": "image/png",
        },
      }),
    ),
  )

  expect(
    await attachmentsModule.fetchUrlAsDataUri("https://size.test/a.png", {
      fetch: fetchMock as unknown as typeof fetch,
      maxBytes: 3,
    } as never),
  ).toBeNull()
  expect(pulls).toBeLessThanOrEqual(1)
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test("returns an empty attachment for a declared-oversize null body", async () => {
  expect(
    await attachmentsModule.fetchUrlAsDataUri(
      "https://size.test/null-body.png",
      {
        fetch: (() =>
          Promise.resolve(
            new Response(null, {
              headers: {
                "content-length": "4",
                "content-type": "image/png",
              },
            }),
          )) as unknown as typeof fetch,
        maxBytes: 3,
      },
    ),
  ).toEqual({ data: "", mediaType: "image/png" })
})

test("does not wait for declared-oversize body cancellation", async () => {
  let cancelCalled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelCalled = true
      return new Promise<void>(() => {})
    },
    pull() {
      return new Promise<void>(() => {})
    },
  })

  const result = await Promise.race([
    attachmentsModule.fetchUrlAsDataUri("https://size.test/stuck.png", {
      fetch: (() =>
        Promise.resolve(
          new Response(body, {
            headers: {
              "content-length": "4",
              "content-type": "image/png",
            },
          }),
        )) as unknown as typeof fetch,
      maxBytes: 3,
    }),
    new Promise<"test-timeout">((resolve) => {
      setTimeout(() => resolve("test-timeout"), 100)
    }),
  ])

  expect(result).toBeNull()
  expect(cancelCalled).toBe(true)
  expect(body.locked).toBe(false)
})

test("suppresses a late declared-oversize cancellation rejection", async () => {
  let rejectCancel: ((reason: Error) => void) | undefined
  let cancelCalled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelCalled = true
      return new Promise<void>((_resolve, reject) => {
        rejectCancel = reject
      })
    },
    pull() {
      return new Promise<void>(() => {})
    },
  })
  const unhandled: Array<unknown> = []
  const onUnhandled = (event: Event) => {
    const rejection = event as Event & { reason?: unknown }
    unhandled.push(rejection.reason)
    event.preventDefault()
  }
  globalThis.addEventListener("unhandledrejection", onUnhandled)
  try {
    expect(
      await attachmentsModule.fetchUrlAsDataUri(
        "https://size.test/reject.png",
        {
          fetch: (() =>
            Promise.resolve(
              new Response(body, {
                headers: {
                  "content-length": "4",
                  "content-type": "image/png",
                },
              }),
            )) as unknown as typeof fetch,
          maxBytes: 3,
        },
      ),
    ).toBeNull()
    if (!rejectCancel) throw new Error("cancel was not requested")
    rejectCancel(new Error("late cancel failure"))
    await Promise.resolve()
    await Promise.resolve()
    expect(cancelCalled).toBe(true)
    expect(body.locked).toBe(false)
    expect(unhandled).toEqual([])
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled)
  }
})

test("accepts exact byte cap and stops streamed overflow promptly", async () => {
  const exact = await attachmentsModule.fetchUrlAsDataUri(
    "https://size.test/exact.png",
    {
      fetch: (() =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          }),
        )) as unknown as typeof fetch,
      maxBytes: 3,
    } as never,
  )
  expect(exact).toEqual({ data: "AQID", mediaType: "image/png" })

  let pulls = 0
  let cancelled = false
  const overflowBody = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
    pull(controller) {
      pulls += 1
      controller.enqueue(
        pulls === 1 ? new Uint8Array([1, 2]) : new Uint8Array([3, 4]),
      )
    },
  })
  expect(
    await attachmentsModule.fetchUrlAsDataUri(
      "https://size.test/overflow.png",
      {
        fetch: (() =>
          Promise.resolve(
            new Response(overflowBody, {
              headers: { "content-type": "image/png" },
            }),
          )) as unknown as typeof fetch,
        maxBytes: 3,
      } as never,
    ),
  ).toBeNull()
  expect(pulls).toBeLessThanOrEqual(3)
  expect(cancelled).toBe(true)
  expect(overflowBody.locked).toBe(false)
})

test("reuses one request-local promise per URL and PDF expectation", async () => {
  let calls = 0
  const resolve = attachmentsModule.createAttachmentFetchResolver({
    fetch: (() => {
      calls += 1
      return Promise.resolve(
        new Response(new Uint8Array([1]), {
          headers: { "content-type": "application/octet-stream" },
        }),
      )
    }) as unknown as typeof fetch,
  })
  await Promise.all([
    resolve({ expectPdf: false, value: "https://cache.test/a" }),
    resolve({ expectPdf: false, value: "https://cache.test/a" }),
  ])
  await resolve({ expectPdf: true, value: "https://cache.test/a" })
  expect(calls).toBe(2)
})

test("propagates an already-aborted caller reason exactly", async () => {
  const controller = new AbortController()
  const reason = new Error("caller stopped before fetch")
  controller.abort(reason)
  const fetchMock = mock(() => Promise.reject(new Error("must not fetch")))

  try {
    await attachmentsModule.fetchUrlAsDataUri("https://abort.test/a.png", {
      fetch: fetchMock as unknown as typeof fetch,
      signal: controller.signal,
    })
    throw new Error("expected caller abort")
  } catch (error) {
    expect(error).toBe(reason)
  }
  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test("propagates caller abort during fetch and turns timeout into null", async () => {
  const caller = new AbortController()
  const callerReason = new Error("caller stopped")
  const waitForAbort = mock(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(
            init.signal?.reason instanceof Error ?
              init.signal.reason
            : new Error("attachment aborted"),
          ),
        )
      }),
  )
  const callerPromise = attachmentsModule.fetchUrlAsDataUri(
    "https://abort.test/caller.png",
    {
      fetch: waitForAbort as unknown as typeof fetch,
      signal: caller.signal,
      timeoutMs: 10_000,
    } as never,
  )
  caller.abort(callerReason)
  try {
    await callerPromise
    throw new Error("expected caller abort")
  } catch (error) {
    expect(error).toBe(callerReason)
  }

  expect(
    await attachmentsModule.fetchUrlAsDataUri(
      "https://abort.test/timeout.png",
      {
        fetch: waitForAbort as unknown as typeof fetch,
        timeoutMs: 1,
      } as never,
    ),
  ).toBeNull()
})

test("cancels a pending body read and propagates the caller reason", async () => {
  const controller = new AbortController()
  const reason = new Error("caller aborted pending body")
  let cancelled = false
  let readStartedResolve: (() => void) | undefined
  const readStarted = new Promise<void>((resolve) => {
    readStartedResolve = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
    pull() {
      readStartedResolve?.()
      return new Promise<void>(() => {})
    },
  })
  const promise = attachmentsModule.fetchUrlAsDataUri(
    "https://abort.test/pending.png",
    {
      fetch: (() =>
        Promise.resolve(
          new Response(body, { headers: { "content-type": "image/png" } }),
        )) as unknown as typeof fetch,
      signal: controller.signal,
      timeoutMs: 10_000,
    },
  )
  await readStarted
  controller.abort(reason)

  try {
    await promise
    throw new Error("expected caller abort")
  } catch (error) {
    expect(error).toBe(reason)
  }
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test("cancels a pending body read on timeout without a late rejection", async () => {
  let cancelled = false
  let readStartedResolve: (() => void) | undefined
  const readStarted = new Promise<void>((resolve) => {
    readStartedResolve = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
    pull() {
      readStartedResolve?.()
      return new Promise<void>(() => {})
    },
  })
  const promise = attachmentsModule.fetchUrlAsDataUri(
    "https://abort.test/pending-timeout.png",
    {
      fetch: (() =>
        Promise.resolve(
          new Response(body, { headers: { "content-type": "image/png" } }),
        )) as unknown as typeof fetch,
      timeoutMs: 1,
    },
  )
  await readStarted

  expect(await promise).toBeNull()
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

test("evicts a rejected cache entry but retains ordinary null", async () => {
  let calls = 0
  const resolve = attachmentsModule.createAttachmentFetchResolver({
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              init.signal?.reason instanceof Error ?
                init.signal.reason
              : new Error("attachment aborted"),
            ),
          )
        })
      }
      if (calls === 2) {
        return Promise.resolve(
          new Response(new Uint8Array([1]), {
            headers: { "content-type": "image/png" },
          }),
        )
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as unknown as typeof fetch,
  })
  const controller = new AbortController()
  const first = resolve({
    expectPdf: false,
    signal: controller.signal,
    value: "https://cache.test/retry.png",
  })
  controller.abort(new Error("cancel first consumer"))
  try {
    await first
    throw new Error("expected cache abort")
  } catch (error) {
    expect(error).toHaveProperty("message", "cancel first consumer")
  }

  expect(
    await resolve({
      expectPdf: false,
      value: "https://cache.test/retry.png",
    }),
  ).toEqual({ data: "AQ==", mediaType: "image/png" })
  expect(
    await resolve({ expectPdf: false, value: "https://cache.test/null.png" }),
  ).toBeNull()
  expect(
    await resolve({ expectPdf: false, value: "https://cache.test/null.png" }),
  ).toBeNull()
  expect(calls).toBe(3)
})

test("shares a concurrent rejected cache promise then retries after eviction", async () => {
  let calls = 0
  const resolve = attachmentsModule.createAttachmentFetchResolver({
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      calls += 1
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              init.signal?.reason instanceof Error ?
                init.signal.reason
              : new Error("attachment aborted"),
            ),
          )
        })
      }
      return Promise.resolve(
        new Response(new Uint8Array([2]), {
          headers: { "content-type": "image/png" },
        }),
      )
    }) as unknown as typeof fetch,
  })
  const controller = new AbortController()
  const first = resolve({
    expectPdf: false,
    signal: controller.signal,
    value: "https://cache.test/concurrent.png",
  })
  const second = resolve({
    expectPdf: false,
    signal: controller.signal,
    value: "https://cache.test/concurrent.png",
  })
  controller.abort(new Error("cancel concurrent consumers"))

  const settled = await Promise.allSettled([first, second])
  expect(settled.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ])
  expect(calls).toBe(1)
  expect(
    await resolve({
      expectPdf: false,
      value: "https://cache.test/concurrent.png",
    }),
  ).toEqual({ data: "Ag==", mediaType: "image/png" })
  expect(calls).toBe(2)
})

test.each([
  {
    expected: "image/jpeg",
    headers: { "content-type": "image/jpeg; charset=binary" },
    url: "https://media.test/file.pdf",
    expectPdf: true,
  },
  {
    expected: "image/png",
    headers: { "content-type": "application/octet-stream" },
    url: "https://media.test/file.png",
    expectPdf: false,
  },
  {
    expected: "application/pdf",
    headers: {},
    url: "https://media.test/file",
    expectPdf: true,
  },
  {
    expected: "application/octet-stream",
    headers: {},
    url: "https://media.test/file",
    expectPdf: false,
  },
])(
  "uses media precedence %#",
  async ({ expectPdf, expected, headers, url }) => {
    const result = await attachmentsModule.fetchUrlAsDataUri(url, {
      expectPdf,
      fetch: (() =>
        Promise.resolve(
          new Response(null, { headers }),
        )) as unknown as typeof fetch,
    } as never)
    expect(result).toEqual({ data: "", mediaType: expected })
  },
)
