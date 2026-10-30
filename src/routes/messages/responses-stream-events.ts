import type { ResponseStreamEvent } from "~/services/copilot/create-responses"

/** Copilot relays provider keep-alive frames while a model works silently. */
export interface ResponseKeepaliveEvent {
  type: "keepalive"
  sequence_number?: number
}

export interface ResponseRefusalDeltaEvent {
  type: "response.refusal.delta"
  content_index: number
  delta: string
  item_id?: string
  output_index: number
  sequence_number?: number
}

export interface ResponseRefusalDoneEvent {
  type: "response.refusal.done"
  content_index: number
  refusal: string
  item_id?: string
  output_index: number
  sequence_number?: number
}

/** Responses stream frames the Messages translation understands. */
export type TranslatableResponsesStreamEvent =
  | ResponseStreamEvent
  | ResponseKeepaliveEvent
  | ResponseRefusalDeltaEvent
  | ResponseRefusalDoneEvent
