import { HTTPError } from "~/lib/error"
import {
  type LogicalRequestLifecycle,
  startLogicalRequestLog,
} from "~/lib/request-logger"
import {
  clientSessionStorage,
  quotaHeadersStorage,
  requestIdStorage,
  routedAccountStorage,
} from "~/lib/request-session"

export interface ResponsesWebSocketTurn {
  abortController: AbortController
  finalized: boolean
  inputLength: number
  lifecycle?: LogicalRequestLifecycle
  model?: string
  reasoningEffort?: string
  requestedModel?: string
  routingState: { lastUsedAccountId?: number }
  sequence: number
  turnId: string
}

interface ResponsesWebSocketLifecycleData {
  activeTurns: Map<number, ResponsesWebSocketTurn>
  nextTurnSequence: number
  requestId: string
}

export class WebSocketRequestError extends HTTPError {
  readonly errorType: string

  constructor(message: string, status: number, errorType: string) {
    super(message, Response.json({ message }, { status }))
    this.errorType = errorType
  }
}

export function createResponsesWebSocketTurn(
  data: ResponsesWebSocketLifecycleData,
  message: string,
): ResponsesWebSocketTurn {
  const sequence = ++data.nextTurnSequence
  const turn: ResponsesWebSocketTurn = {
    abortController: new AbortController(),
    finalized: false,
    inputLength: new TextEncoder().encode(message).byteLength,
    routingState: {},
    sequence,
    turnId: `${data.requestId}:${sequence}`,
  }
  data.activeTurns.set(sequence, turn)
  return turn
}

export function ensureResponsesWebSocketLifecycle(
  turn: ResponsesWebSocketTurn,
  options?: {
    model?: string
    reasoningEffort?: string
    requestedModel?: string
  },
): LogicalRequestLifecycle {
  if (!turn.lifecycle) {
    turn.lifecycle = startLogicalRequestLog({
      inputLength: turn.inputLength,
      method: "POST",
      model: options?.model ?? turn.model ?? turn.requestedModel ?? "unknown",
      path: "/responses",
      reasoningEffort: options?.reasoningEffort,
      requestedModel: options?.requestedModel ?? turn.requestedModel,
      transport: "Responses WebSocket",
      turnId: turn.turnId,
    })
  } else if (options) {
    turn.lifecycle.update(options)
  }
  return turn.lifecycle
}

export function finalizeResponsesWebSocketTurn(
  data: ResponsesWebSocketLifecycleData,
  turn: ResponsesWebSocketTurn,
  options: {
    error?: unknown
    status: number
    terminalStatus: "COMPLETE" | "ERROR" | "REJECTED" | "ABORTED"
  },
): void {
  const lifecycle = ensureResponsesWebSocketLifecycle(turn)
  const finalized = lifecycle.finalize({
    accountId: turn.routingState.lastUsedAccountId,
    error: options.error,
    status: options.status,
    terminalStatus: options.terminalStatus,
  })
  if (finalized) turn.finalized = true
  data.activeTurns.delete(turn.sequence)
}

export function throwIfWebSocketTurnAborted(
  turn: ResponsesWebSocketTurn,
): void {
  if (!turn.abortController.signal.aborted) return
  const reason: unknown = turn.abortController.signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error("Responses WebSocket request aborted")
  error.name = "AbortError"
  throw error
}

export function classifyWebSocketTerminal(
  error: unknown,
  turn: ResponsesWebSocketTurn,
): {
  status: number
  terminalStatus: "ERROR" | "REJECTED" | "ABORTED"
} {
  if (turn.abortController.signal.aborted || isAbortLikeError(error)) {
    return { status: 499, terminalStatus: "ABORTED" }
  }
  if (error instanceof HTTPError) {
    const status = error.response.status
    return {
      status,
      terminalStatus: status < 500 ? "REJECTED" : "ERROR",
    }
  }
  return { status: 500, terminalStatus: "ERROR" }
}

export async function runWithWebSocketRequestContext(
  sessionId: string | undefined,
  turn: ResponsesWebSocketTurn,
  callback: () => Promise<void>,
): Promise<void> {
  await requestIdStorage.run(turn.turnId, async () => {
    await clientSessionStorage.run(sessionId, async () => {
      await quotaHeadersStorage.run({}, async () => {
        await routedAccountStorage.run(turn.routingState, callback)
      })
    })
  })
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  const causeMessage =
    error.cause instanceof Error ? error.cause.message.toLowerCase() : ""
  return (
    error.name === "AbortError"
    || message.includes("aborted")
    || causeMessage.includes("aborted")
  )
}
