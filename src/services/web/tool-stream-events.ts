import type { WebProtocol } from "./tool-context"
import type { ManagedWebDispatch, WebEvent } from "./tool-loop"
import type { ManagedWebUsage } from "./tool-usage"

import { isRecord } from "./tool-context"

/** Where the next event of a multi-round managed stream lands for the client. */
export interface StreamPosition {
  protocol: WebProtocol
  offset: number
  sequence: number
  id?: unknown
  usage?: Record<string, unknown>
  output?: Array<Record<string, unknown>>
}

/** A streamed round whose upstream response is complete. */
export interface FinishedStreamRound<State> {
  state: State
  response: Record<string, unknown>
  /** The zero-based upstream round. */
  index: number
  position: StreamPosition
  /** Usage summed over every round so far. */
  usage: Record<string, unknown> | undefined
  /** Responses output already sent to the client, in order. */
  output: Array<Record<string, unknown>>
  observedUsage: ManagedWebUsage
  dispatch: ManagedWebDispatch
}

export function remap(
  event: WebEvent,
  parsed: Record<string, unknown>,
  position: StreamPosition,
): WebEvent {
  const { offset, id, protocol } = position
  const output = { ...parsed }
  if (typeof output.index === "number") output.index += offset
  if (typeof output.output_index === "number") output.output_index += offset
  if (protocol === "responses") {
    output.sequence_number = position.sequence++
    if (isRecord(output.response) && id)
      output.response = { ...output.response, id }
  }
  if (protocol === "chat" && id) output.id = id
  return { ...event, data: JSON.stringify(output) }
}

export function eventFor(
  type: string,
  body: Record<string, unknown>,
): WebEvent {
  return { event: type, data: JSON.stringify({ ...body, type }) }
}

/** Replay held or terminal events at the client's position in the stream. */
export function* placeEvents(
  events: Iterable<WebEvent>,
  position: StreamPosition,
): Generator<WebEvent> {
  for (const event of events) {
    if (event.data === "[DONE]") {
      yield event
      continue
    }
    const parsed = JSON.parse(event.data ?? "{}") as Record<string, unknown>
    yield remap(event, parsed, position)
  }
}
