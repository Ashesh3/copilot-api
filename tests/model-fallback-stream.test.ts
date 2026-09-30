import { expect, test } from "bun:test"

import { observeModelFallbackStream } from "~/lib/model-fallback-stream"

const encoder = new TextEncoder()

test("a slow consumer does not drain the upstream fallback stream", async () => {
  const frame =
    'data: {"type":"response.output_text.delta","delta":"token"}\n\n'
  let pulls = 0
  let cancelled = false
  let persisted = false
  const upstream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++
        if (pulls > 20) controller.close()
        else controller.enqueue(encoder.encode(frame))
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const observed = observeModelFallbackStream(
    new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    }),
    () => {
      persisted = true
      return Promise.resolve()
    },
  )
  const reader = observed.body?.getReader()
  if (!reader) throw new Error("Expected an observable stream")
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value as Uint8Array)).toBe(frame)
  await Bun.sleep(10)
  expect(pulls).toBeLessThanOrEqual(2)
  await reader.cancel()
  expect(cancelled).toBe(true)
  expect(persisted).toBe(false)
})

function streamingResponse(
  chunks: Array<string>,
  options: { leaveOpen?: boolean; onCancel?: () => void } = {},
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        if (!options.leaveOpen) controller.close()
      },
      cancel() {
        options.onCancel?.()
      },
    }),
    {
      status: 200,
      statusText: "Accepted",
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "x-upstream": "preserved",
      },
    },
  )
}

test.each([
  [
    "Responses completion",
    [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ],
  ],
  [
    "Messages stop",
    [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
  ],
  [
    "Chat done marker",
    [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ],
  ],
  [
    "Chat terminal chunk",
    ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'],
  ],
] as const)(
  "persists before forwarding a successful %s",
  async (_name, chunks) => {
    const order: Array<string> = []
    const original = chunks.join("")
    const observed = observeModelFallbackStream(
      streamingResponse([...chunks]),
      async () => {
        await Promise.resolve()
        order.push("persisted")
      },
    )

    expect(observed.status).toBe(200)
    expect(observed.statusText).toBe("Accepted")
    expect(observed.headers.get("x-upstream")).toBe("preserved")
    const reader = observed.body?.getReader()
    const decoder = new TextDecoder()
    let wire = ""
    while (reader) {
      const next = await reader.read()
      if (next.done) break
      wire += decoder.decode(next.value as Uint8Array, { stream: true })
      if (wire.includes(chunks.at(-1) ?? "")) order.push("terminal delivered")
    }
    wire += decoder.decode()

    expect(wire).toBe(original)
    expect(order).toEqual(["persisted", "terminal delivered"])
  },
)

test.each([
  ["Responses failure", 'data: {"type":"response.failed"}\n\n'],
  ["Responses incomplete", 'data: {"type":"response.incomplete"}\n\n'],
  ["protocol error", 'event: error\ndata: {"type":"error"}\n\n'],
  [
    "malformed data before completion",
    'data: {broken\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n',
  ],
  ["EOF without a terminal", 'data: {"type":"response.created"}\n\n'],
] as const)("does not persist a %s stream", async (_name, wire) => {
  let calls = 0
  const observed = observeModelFallbackStream(streamingResponse([wire]), () => {
    calls++
    return Promise.resolve()
  })

  expect(await observed.text()).toBe(wire)
  expect(calls).toBe(0)
})

test("recognizes a CRLF terminal split across every byte boundary", async () => {
  let calls = 0
  const wire =
    'event: response.completed\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n'
  const chunks = Array.from(wire)
  const observed = observeModelFallbackStream(streamingResponse(chunks), () => {
    calls++
    return Promise.resolve()
  })

  expect(await observed.text()).toBe(chunks.join(""))
  expect(calls).toBe(1)
})

test("does not persist a named completion event without a valid terminal payload", async () => {
  let calls = 0
  const wire =
    'event: response.completed\ndata: {"type":"response.completed"}\n\n'
  const observed = observeModelFallbackStream(streamingResponse([wire]), () => {
    calls++
    return Promise.resolve()
  })
  expect(await observed.text()).toBe(wire)
  expect(calls).toBe(0)
})

test("a Chat finish reason persists only after DONE or clean EOF", async () => {
  const terminal = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
  let doneCalls = 0
  const done = observeModelFallbackStream(
    streamingResponse([terminal, "data: [DONE]\n\n"]),
    () => {
      doneCalls++
      return Promise.resolve()
    },
  )
  expect(await done.text()).toBe(`${terminal}data: [DONE]\n\n`)
  expect(doneCalls).toBe(1)

  let eofCalls = 0
  const eof = observeModelFallbackStream(streamingResponse([terminal]), () => {
    eofCalls++
    return Promise.resolve()
  })
  expect(await eof.text()).toBe(terminal)
  expect(eofCalls).toBe(1)
})

test("a later Chat error poisons an earlier finish reason", async () => {
  let calls = 0
  const wire = [
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'event: error\ndata: {"type":"error"}\n\n',
    "data: [DONE]\n\n",
  ].join("")
  const observed = observeModelFallbackStream(streamingResponse([wire]), () => {
    calls++
    return Promise.resolve()
  })
  expect(await observed.text()).toBe(wire)
  expect(calls).toBe(0)
})

test("truncated trailing data poisons a Chat finish reason at EOF", async () => {
  let calls = 0
  const wire = [
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "event: error\ndata: {broken",
  ].join("")
  const observed = observeModelFallbackStream(streamingResponse([wire]), () => {
    calls++
    return Promise.resolve()
  })
  expect(await observed.text()).toBe(wire)
  expect(calls).toBe(0)
})

test("downstream cancellation cannot persist a deferred Chat terminal", async () => {
  let calls = 0
  let releaseRead: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        ),
      )
      await new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      controller.close()
    },
  })
  const observed = observeModelFallbackStream(
    new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    () => {
      calls++
      return Promise.resolve()
    },
  )
  const reader = observed.body?.getReader()
  if (!reader) throw new Error("Missing observed stream")
  const pending = reader.read()
  await Promise.resolve()
  await reader.cancel()
  releaseRead?.()
  await pending.catch(() => undefined)
  expect(calls).toBe(0)
})

test("oversized complete events pass through without persistence", async () => {
  let calls = 0
  const wire = `data: ${JSON.stringify({
    type: "response.completed",
    response: { status: "completed", padding: "x".repeat(8 * 1024 * 1024) },
  })}\n\n`
  const observed = observeModelFallbackStream(streamingResponse([wire]), () => {
    calls++
    return Promise.resolve()
  })
  expect((await observed.text()).length).toBe(wire.length)
  expect(calls).toBe(0)
})

test("cancels the source and withholds the successful terminal when persistence fails", async () => {
  let cancelled = false
  const observed = observeModelFallbackStream(
    streamingResponse(
      [
        'data: {"type":"response.created"}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      ],
      { leaveOpen: true, onCancel: () => (cancelled = true) },
    ),
    () => Promise.reject(new Error("database unavailable")),
  )
  const reader = observed.body?.getReader()
  expect(reader).toBeDefined()
  if (!reader) throw new Error("Missing observed stream")
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value as Uint8Array)).toContain(
    "response.created",
  )
  let failure: unknown
  try {
    await reader.read()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe("database unavailable")
  expect(cancelled).toBe(true)
})

test("returns non-SSE responses unchanged without observing them", () => {
  const response = Response.json({ ok: true })
  const observed = observeModelFallbackStream(response, () =>
    Promise.reject(new Error("must not run")),
  )
  expect(observed).toBe(response)
})
