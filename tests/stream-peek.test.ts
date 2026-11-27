import { expect, test } from "bun:test"

import { peekFirstStreamEvent } from "~/services/copilot/stream-peek"

function sse(chunks: Array<string>, failure?: Error): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift()
        if (next !== undefined) controller.enqueue(encoder.encode(next))
        else if (failure) controller.error(failure)
        else controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

test("finds an event split across chunks and with CR line endings", async () => {
  const { event, response } = await peekFirstStreamEvent(
    sse([
      'data: {"error":{"mess',
      'age":"Overloaded"}}\r\r',
      "data: [DONE]\r\r",
    ]),
  )

  expect(event?.data).toBe('{"error":{"message":"Overloaded"}}')
  expect(await response.text()).toBe(
    'data: {"error":{"message":"Overloaded"}}\r\rdata: [DONE]\r\r',
  )
})

test("stops looking after a long comment-only prefix and loses no bytes", async () => {
  const comments = Array.from({ length: 40 }, () => `: ${"x".repeat(2000)}\n\n`)
  const { event, response } = await peekFirstStreamEvent(
    sse([...comments, "data: late\n\n"]),
  )

  expect(event).toBeUndefined()
  expect(await response.text()).toBe(`${comments.join("")}data: late\n\n`)
})

test("delivers bytes received before an upstream failure", async () => {
  const { response } = await peekFirstStreamEvent(
    sse(["data: partial"], new Error("socket reset")),
  )
  const reader = response.body?.getReader() as
    | ReadableStreamDefaultReader<Uint8Array>
    | undefined
  if (!reader) throw new Error("No body")

  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe("data: partial")
  const failure: unknown = await reader.read().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(String(failure)).toContain("socket reset")
})
