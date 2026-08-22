import type { ServerSentEventMessage } from "fetch-event-stream"

export const SAFE_RESPONSES_STREAM_ERROR_MESSAGE =
  "Upstream Responses stream failed."

const TERMINAL_EVENT_TYPES = new Set([
  "error",
  "response.completed",
  "response.failed",
  "response.incomplete",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeSequenceNumber(value: unknown): number {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : 0
}

function createSafeError(): Record<string, unknown> {
  return {
    code: "server_error",
    message: SAFE_RESPONSES_STREAM_ERROR_MESSAGE,
    param: null,
    status: 502,
  }
}

function createSyntheticTerminalEvent(
  eventType: string,
  parsed?: Record<string, unknown>,
): Record<string, unknown> {
  const sequenceNumber = safeSequenceNumber(parsed?.sequence_number)
  if (eventType === "error") {
    return {
      type: "error",
      sequence_number: sequenceNumber,
      ...createSafeError(),
    }
  }

  const response = isRecord(parsed?.response) ? parsed.response : undefined
  return {
    type: eventType,
    sequence_number: sequenceNumber,
    response: {
      ...(typeof response?.id === "string" && response.id.length > 0 ?
        { id: response.id }
      : {}),
      ...(response?.object === "response" ? { object: "response" } : {}),
      output: [],
      output_text: "",
      usage: null,
      error: createSafeError(),
      incomplete_details: null,
    },
  }
}

function syntheticTerminalEvent(
  event: ServerSentEventMessage,
  parsed?: Record<string, unknown>,
): ServerSentEventMessage {
  if (!event.event || !TERMINAL_EVENT_TYPES.has(event.event)) return event
  const eventType =
    event.event === "response.completed" ? "response.failed" : event.event
  return {
    ...event,
    event: eventType,
    data: JSON.stringify(createSyntheticTerminalEvent(eventType, parsed)),
  }
}

export function sanitizeResponsesStreamEvent(
  event: ServerSentEventMessage,
): ServerSentEventMessage {
  if (!event.data) return syntheticTerminalEvent(event)

  let parsed: unknown
  try {
    parsed = JSON.parse(event.data) as unknown
  } catch {
    return syntheticTerminalEvent(event)
  }

  if (!isRecord(parsed)) return syntheticTerminalEvent(event)

  const parsedType = parsed.type
  const eventType =
    event.event ?? (typeof parsedType === "string" ? parsedType : undefined)
  if (!eventType || !TERMINAL_EVENT_TYPES.has(eventType)) return event
  if (
    parsedType !== undefined
    && (typeof parsedType !== "string" || parsedType !== eventType)
  ) {
    return syntheticTerminalEvent(event, parsed)
  }

  return {
    ...event,
    data:
      parsedType === undefined ?
        JSON.stringify({ ...parsed, type: eventType })
      : event.data,
  }
}
