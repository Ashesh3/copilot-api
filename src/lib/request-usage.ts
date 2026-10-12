import { normalizeUsageTokenCount } from "~/lib/storage/usage-counters"
import { recordUsage } from "~/lib/usage-tracker"

interface RequestUsage {
  estimatedInputTokens?: number
  inputTokens?: number
  outputTokens?: number
  model?: string
}

/** Estimates describe the request; only upstream usage contributes to totals. */
export function diagnosticInputTokens(
  usage: RequestUsage | undefined,
): number | undefined {
  return (
    normalizeUsageTokenCount(usage?.inputTokens)
    ?? normalizeUsageTokenCount(usage?.estimatedInputTokens)
    ?? undefined
  )
}

/** Observe stream termination without parsing, buffering, or reading ahead. */
export function observeRequestUsage(
  response: Response,
  readUsage: () => RequestUsage | undefined,
): Response {
  let recorded = false
  const finish = () => {
    if (recorded) return
    recorded = true
    const usage = readUsage()
    if (usage?.inputTokens === undefined && usage?.outputTokens === undefined) {
      return
    }
    recordUsage(
      usage.inputTokens === undefined ? 0 : usage.inputTokens,
      usage.outputTokens === undefined ? 0 : usage.outputTokens,
      usage.model,
    )
  }
  const contentType = response.headers.get("content-type")
  if (
    !response.body
    || contentType?.split(";", 1)[0].trim().toLowerCase()
      !== "text/event-stream"
  ) {
    finish()
    return response
  }

  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read()
          if (cancelled) return
          if (result.done) {
            finish()
            reader.releaseLock()
            controller.close()
          } else {
            controller.enqueue(result.value)
          }
        } catch (error) {
          if (cancelled) return
          finish()
          reader.releaseLock()
          controller.error(error)
        }
      },
      async cancel(reason: unknown) {
        // Pending reads can resolve before asynchronous source cleanup ends.
        cancelled = true
        try {
          await reader.cancel(reason)
        } finally {
          finish()
          reader.releaseLock()
        }
      },
    },
    { highWaterMark: 0 },
  )
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
