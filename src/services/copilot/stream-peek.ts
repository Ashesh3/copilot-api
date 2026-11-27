import { parseSseEvents } from "~/lib/intercept/canonical"

export interface PeekedStreamEvent {
  event?: string
  data?: string
}

/**
 * The bytes up to the first complete SSE event, read from the response
 * itself. A tee'd copy would lose its queued bytes if upstream failed
 * meanwhile, since erroring a stream discards what it still holds.
 */
async function readFirstStreamEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{
  chunks: Array<Uint8Array>
  event?: PeekedStreamEvent
  failure?: { error: unknown }
  done: boolean
}> {
  const decoder = new TextDecoder()
  const chunks: Array<Uint8Array> = []
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (!done) {
        chunks.push(value)
        text += decoder.decode(value, { stream: true })
      }
      const normalized = text.replaceAll(/\r\n?/g, "\n")
      const end = normalized.lastIndexOf("\n\n")
      const event = parseSseEvents(
        done || end === -1 ? normalized : normalized.slice(0, end),
      ).at(0)
      if (done || (end !== -1 && event)) return { chunks, event, done }
    }
  } catch (error) {
    return { chunks, failure: { error }, done: true }
  }
}

/**
 * Peek at the first SSE event, then hand back a response that still delivers
 * every byte: those already read, then the rest, or the upstream failure
 * once the bytes before it are delivered.
 */
export async function peekFirstStreamEvent(
  response: Response,
): Promise<{ event?: PeekedStreamEvent; response: Response }> {
  if (!response.body) return { response }
  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const first = await readFirstStreamEvent(reader)
  let pending: Array<Uint8Array> = first.chunks
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = pending.shift()
        if (next) {
          controller.enqueue(next)
          return
        }
        if (first.failure) {
          controller.error(first.failure.error)
          return
        }
        if (first.done) {
          controller.close()
          return
        }
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      },
      async cancel(reason) {
        pending = []
        await reader.cancel(reason)
      },
    },
    // Pull only on demand, so upstream backpressure is unchanged.
    { highWaterMark: 0 },
  )
  return {
    event: first.event,
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  }
}
