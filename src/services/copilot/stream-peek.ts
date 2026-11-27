import { parseSseEvents } from "~/lib/intercept/canonical"

export interface PeekedStreamEvent {
  event?: string
  data?: string
}

/**
 * How far to look for the first event. Past this, the stream is delivered
 * without inspection; a provider error event is far smaller.
 */
const FIRST_EVENT_PEEK_BYTES = 64 * 1024

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
  let bytes = 0
  // Blocks before this offset are complete and held no event (comments).
  let parsedTo = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (!done) {
        chunks.push(value)
        bytes += value.byteLength
        text += decoder.decode(value, { stream: true })
      }
      const normalized = text.replaceAll(/\r\n?/g, "\n")
      const end = done ? normalized.length : normalized.lastIndexOf("\n\n")
      if (end > parsedTo) {
        const event = parseSseEvents(normalized.slice(parsedTo, end)).at(0)
        if (event) return { chunks, event, done }
        parsedTo = end
      }
      if (done || bytes > FIRST_EVENT_PEEK_BYTES) return { chunks, done }
    }
  } catch (error) {
    // With nothing to deliver yet, fail the send itself, before the client
    // is committed to a streamed success.
    if (chunks.length === 0) throw error
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
