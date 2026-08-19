import type { SafeHttpErrorInspection } from "~/lib/error"
import type { RoutingAffinity } from "~/lib/routing-affinity"

import {
  type CopilotRequestAttribution,
  runWithCopilotRequestAttribution,
} from "~/lib/copilot-request-context"
import {
  isAbortError,
  isHTTPError,
  LocalHTTPError,
  snapshotSafeHttpError,
} from "~/lib/error"
import {
  type LogicalRequestLifecycle,
  startLogicalRequestLog,
} from "~/lib/request-logger"
import {
  createRoutingTelemetryRequestState,
  copilotResponseHeadersStorage,
  requestIdStorage,
  routedAccountStorage,
  type RoutingTelemetryRequestState,
  routingTelemetryStorage,
} from "~/lib/request-session"
import { runWithRoutingAffinity } from "~/lib/routing-affinity"

export interface ResponsesWebSocketTurn {
  abortController: AbortController
  finalized: boolean
  inputLength: number
  lifecycle?: LogicalRequestLifecycle
  model?: string
  reasoningEffort?: string
  requestedModel?: string
  routingState: { lastUsedAccountId?: number }
  telemetryState: RoutingTelemetryRequestState
  sequence: number
  turnId: string
}

interface ResponsesWebSocketLifecycleData {
  activeTurns: Map<number, ResponsesWebSocketTurn>
  nextTurnSequence: number
  requestId: string
}

export class WebSocketRequestError extends LocalHTTPError {
  readonly errorCode: string
  readonly errorType: string

  // The protocol-native error tuple is intentionally explicit at throw sites.
  // eslint-disable-next-line max-params
  constructor(
    message: string,
    status: number,
    errorType: string,
    errorCode = "bad_request",
  ) {
    const clientBody = {
      error: {
        code: errorCode,
        message,
        type: errorType,
      },
    }
    super(message, Response.json(clientBody, { status }), clientBody)
    this.errorCode = errorCode
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
    telemetryState: createRoutingTelemetryRequestState("Responses WebSocket"),
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
      telemetryState: turn.telemetryState,
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
    errorInspection?: SafeHttpErrorInspection
    status: number
    terminalStatus: "COMPLETE" | "ERROR" | "REJECTED" | "ABORTED"
  },
): void {
  const lifecycle = ensureResponsesWebSocketLifecycle(turn)
  const finalized = lifecycle.finalize({
    accountId: turn.routingState.lastUsedAccountId,
    error: options.error,
    errorInspection: options.errorInspection,
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
  errorInspection?: SafeHttpErrorInspection
  status: number
  terminalStatus: "ERROR" | "REJECTED" | "ABORTED"
} {
  if (turn.abortController.signal.aborted || isAbortError(error)) {
    return { status: 499, terminalStatus: "ABORTED" }
  }
  if (isHTTPError(error)) {
    const errorInspection = snapshotSafeHttpError(error)
    const { status } = errorInspection
    return {
      errorInspection,
      status,
      terminalStatus: status < 500 ? "REJECTED" : "ERROR",
    }
  }
  return { status: 500, terminalStatus: "ERROR" }
}

// The public lifecycle interface keeps affinity, attribution, turn, and work explicit.
// eslint-disable-next-line max-params
export async function runWithWebSocketRequestContext<T>(
  affinity: RoutingAffinity | undefined,
  attribution: CopilotRequestAttribution,
  turn: ResponsesWebSocketTurn,
  callback: () => Promise<T>,
): Promise<T> {
  return await requestIdStorage.run(
    turn.turnId,
    async () =>
      await runWithRoutingAffinity(
        affinity,
        async () =>
          await runWithCopilotRequestAttribution(
            attribution,
            async () =>
              await copilotResponseHeadersStorage.run(
                {},
                async () =>
                  await routedAccountStorage.run(
                    turn.routingState,
                    async () =>
                      await routingTelemetryStorage.run(
                        turn.telemetryState,
                        callback,
                      ),
                  ),
              ),
          ),
      ),
  )
}
