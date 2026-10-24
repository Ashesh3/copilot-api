import { AsyncLocalStorage } from "node:async_hooks"

import type { ResponseUsage } from "~/services/copilot/create-responses"

import type { ResponsesWebSocketState } from "./websocket"
import type { ResponsesWebSocketTurn } from "./websocket-lifecycle"

export interface ResponsesWebSocketOutputFrame {
  type?: unknown
  response?: { id?: unknown; usage?: ResponseUsage | null }
  output_index?: unknown
  item?: unknown
}

export interface InterruptedResponseFrame {
  type: "response.incomplete"
  sequence_number: number
  response: Record<string, unknown> & {
    id: string
    status: "incomplete"
    incomplete_details: { reason: "interrupted" }
    output: Array<Record<string, unknown>>
  }
}

interface InterruptibleResponse {
  id: string
  envelope: Record<string, unknown>
  completedItems: Map<number, Record<string, unknown>>
  pendingItems: Map<number, string>
  finished: boolean
  interrupting: boolean
  finish: (frame: InterruptedResponseFrame) => Promise<boolean>
}

// A finished turn is released with its request; only its existing continuation
// snapshot survives on the connection. Control frames never allocate turns.
const responses = new WeakMap<ResponsesWebSocketTurn, InterruptibleResponse>()

export function trackInterruptibleResponse(
  turn: ResponsesWebSocketTurn,
  frame: ResponsesWebSocketOutputFrame,
  finish: (frame: InterruptedResponseFrame) => Promise<boolean>,
): void {
  let current = responses.get(turn)
  const response = frame.response
  if (!current && typeof response?.id === "string" && response.id) {
    current = {
      id: response.id,
      envelope: { ...response },
      completedItems: new Map(),
      pendingItems: new Map(),
      finished: false,
      interrupting: false,
      // Controls arrive in a different callback. Retain the original routing,
      // memory affinity, response headers and usage context for finalization.
      finish: AsyncLocalStorage.bind(finish),
    }
    responses.set(turn, current)
  }
  if (!current) return
  if (response?.id === current.id) {
    current.envelope = { ...current.envelope, ...response }
  }
  if (
    frame.type === "response.completed"
    || frame.type === "response.incomplete"
    || frame.type === "response.failed"
    || frame.type === "error"
  ) {
    // Mark before send(): a completed response can race its own interrupt.
    current.finished = true
  }
  trackOutputItems(current, frame)
}

function trackOutputItems(
  current: InterruptibleResponse,
  frame: ResponsesWebSocketOutputFrame,
): void {
  const index = frame.output_index
  const item = frame.item
  if (
    typeof index !== "number"
    || !Number.isSafeInteger(index)
    || index < 0
    || typeof item !== "object"
    || item === null
    || Array.isArray(item)
  )
    return
  const output = item as Record<string, unknown>
  if (frame.type === "response.output_item.done") {
    current.completedItems.set(index, structuredClone(output))
    current.pendingItems.delete(index)
  } else if (
    frame.type === "response.output_item.added"
    && typeof output.id === "string"
    && !current.completedItems.has(index)
  ) {
    current.pendingItems.set(index, output.id)
  }
}

export async function interruptResponsesWebSocket(
  ws: ResponsesWebSocketState,
  responseId: string,
): Promise<void> {
  const turn = [...ws.data.activeTurns.values()].find(
    (candidate) => responses.get(candidate)?.id === responseId,
  )
  const current = turn && responses.get(turn)
  if (!current) {
    if (ws.data.responseSnapshots.has(responseId)) {
      acknowledgeInterrupt(ws, responseId)
    } else {
      ws.send(
        JSON.stringify({
          type: "response.interrupt.failed",
          response_id: responseId,
          error: {
            code: "response_not_found",
            message:
              "The response is not available on this WebSocket connection.",
          },
        }),
      )
    }
    return
  }
  if (current.finished || current.interrupting) {
    acknowledgeInterrupt(ws, responseId)
    return
  }
  current.interrupting = true
  try {
    acknowledgeInterrupt(ws, responseId)
    for (const [index, itemId] of current.pendingItems) {
      if (ws.data.closed) return
      ws.send(
        JSON.stringify({
          type: "response.output_item.interrupted",
          sequence_number: turn.failureState.sequenceNumber++,
          output_index: index,
          item_id: itemId,
        }),
      )
    }
    if (!ws.data.closed) {
      await current.finish(createInterruptedFrame(turn, current))
    }
  } finally {
    // Commit the resumable terminal before cancelling fetch. Otherwise the
    // normal abort guard would replace it with an aborted/error lifecycle.
    const error = new Error("Responses WebSocket response interrupted")
    error.name = "AbortError"
    turn.abortController.abort(error)
  }
}

function acknowledgeInterrupt(
  ws: ResponsesWebSocketState,
  responseId: string,
): void {
  ws.send(
    JSON.stringify({
      type: "response.interrupt.accepted",
      response_id: responseId,
    }),
  )
}

function createInterruptedFrame(
  turn: ResponsesWebSocketTurn,
  current: InterruptibleResponse,
): InterruptedResponseFrame {
  const output = [...current.completedItems]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item)
  return {
    type: "response.incomplete",
    sequence_number: turn.failureState.sequenceNumber,
    response: {
      ...current.envelope,
      id: current.id,
      object: "response",
      created_at: turn.failureState.createdAt,
      model: turn.requestedModel ?? turn.failureState.model,
      status: "incomplete",
      incomplete_details: { reason: "interrupted" },
      error: null,
      output,
      output_text: completedOutputText(output),
      usage: turn.failureState.usage,
    },
  }
}

function completedOutputText(output: Array<Record<string, unknown>>): string {
  let text = ""
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type === "output_text" && typeof part.text === "string") {
        text += part.text
      }
    }
  }
  return text
}
