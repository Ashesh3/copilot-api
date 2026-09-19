const FAILURE_EVENTS = new Set([
  "error",
  "response.failed",
  "response.incomplete",
])
const FAILURE_STATUSES = new Set(["failed", "incomplete", "cancelled"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRecord(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function hasError(value: unknown): boolean {
  return isRecord(value) || (typeof value === "string" && value.length > 0)
}

function hasFailureStatus(value: unknown): boolean {
  return typeof value === "string" && FAILURE_STATUSES.has(value)
}

function hasFailureRecord(
  record: Record<string, unknown> | undefined,
  event?: string,
): boolean {
  if (!record) return false
  if (hasError(record.error)) return true
  if (typeof record.type === "string" && FAILURE_EVENTS.has(record.type))
    return true
  if (record.object === "response" && hasFailureStatus(record.status))
    return true
  if (
    (event === "response.completed" || record.type === "response.completed")
    && isRecord(record.response)
  ) {
    return (
      hasError(record.response.error)
      || hasFailureStatus(record.response.status)
    )
  }
  return false
}

interface StreamFrame {
  event?: string
  data: string
}

function* streamFrames(body: string): Generator<StreamFrame> {
  let event: string | undefined
  let data: Array<string> = []
  for (const [, line] of body.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/gu)) {
    if (!line) {
      yield { event, data: data.join("\n") }
      event = undefined
      data = []
      continue
    }
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const rawValue = colon === -1 ? "" : line.slice(colon + 1)
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue
    if (field === "event") event = value
    if (field === "data") data.push(value)
  }
  if (event !== undefined || data.length > 0)
    yield { event, data: data.join("\n") }
}

/** Inspect protocol envelopes only; output text and captured bytes stay intact. */
export function hasFailedLlmDebugResponse(options: {
  body: string | null
  contentType?: string
}): boolean {
  if (!options.body) return false
  const body =
    options.body.codePointAt(0) === 0xfeff ?
      options.body.slice(1)
    : options.body
  const contentType = options.contentType?.split(";", 1)[0].trim().toLowerCase()
  if (contentType !== "text/event-stream")
    return hasFailureRecord(parseRecord(body))

  for (const frame of streamFrames(body)) {
    if (frame.event && FAILURE_EVENTS.has(frame.event)) return true
    if (hasFailureRecord(parseRecord(frame.data), frame.event)) return true
  }
  return false
}
