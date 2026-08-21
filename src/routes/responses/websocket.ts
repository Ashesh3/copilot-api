/* eslint-disable max-lines */
import consola from "consola"
import { randomUUID } from "node:crypto"

import type { HttpErrorInspection } from "~/lib/error"
import type { RoutingAffinity } from "~/lib/routing-affinity"
import type { NativeMessagesRequestOptions } from "~/routes/messages/native-handler"

import {
  runWithRoutedModelSelection,
  selectRoutedModel,
} from "~/lib/account-router"
import {
  recordCopilotContractEvent,
  recordCopilotMessagesBeta,
} from "~/lib/copilot-contract-observability"
import { resolveRequestCredential } from "~/lib/credential-resolver"
import { isHTTPError, reportHttpErrorForTransport } from "~/lib/error"
import {
  applyModelRedirect,
  formatModelRedirectResult,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  type ReasoningEffort,
  normalizeReasoningEffortForModel,
  parseReasoningEffort,
  parseModelSuffix,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import { resolveProtectedCredential } from "~/lib/protected-credential"
import { reportNonDefaultBehavior } from "~/lib/request-logger"
import { getCopilotResponseHeaders } from "~/lib/request-session"
import {
  resolveResponsesRoutingAffinity,
  resolveRoutingAffinityFromHeaders,
} from "~/lib/routing-affinity"
import { resolveWebSearchCalls } from "~/routes/messages/web-search-helpers"
import {
  fitResponsesCompactionPayload,
  isResponsesCompactionRequest,
} from "~/services/copilot/compaction-payload"
import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  type ResponsesResult,
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"
import { sanitizeAnthropicRequestHeaderOptions } from "~/services/copilot/messages-contract"

import {
  convertWebSearchTool,
  disableParallelWebSearch,
  normalizeResponsesReasoning,
  prepareResponsesRouteForTransport,
  responsesToChatCompletions,
  streamChatCompletionsAsResponses,
  useFunctionApplyPatch,
} from "./handler"
import { executeResponsesMessagesBridge } from "./messages-bridge"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  emitResponsesFailureAsStream,
  updateResponsesFailureState,
} from "./stream-lifecycle"
import { expandCompactionItems, getResponsesRequestOptions } from "./utils"
import {
  classifyWebSocketTerminal,
  createResponsesWebSocketTurn,
  ensureResponsesWebSocketLifecycle,
  finalizeResponsesWebSocketTurn,
  type ResponsesWebSocketTurn,
  runWithWebSocketRequestContext,
  throwIfWebSocketTurnAborted,
  WebSocketRequestError,
} from "./websocket-lifecycle"
import {
  addResponsesWebSocketMetadata,
  classifyEmittedWebSocketTerminal,
  mergeEffectiveNativeMessagesOptions,
  mergeContinuationInput,
  parseResponsesWebSocketFrame,
  rehydrateContinuationPayloadFromSnapshot,
  resolveResponsesContinuation,
} from "./websocket-protocol"

const WS_PATHS = new Set(["/v1/responses", "/responses"])

export interface ResponsesWebSocketData {
  activeTurns: Map<number, ResponsesWebSocketTurn>
  closed: boolean
  nextTurnSequence: number
  type: "responses"
  requestId: string
  affinity?: RoutingAffinity
  nativeMessagesOptions: NativeMessagesRequestOptions
  effectiveNativeMessagesOptions: NativeMessagesRequestOptions
  responseSnapshots: Map<string, ResponsesPayload>
}

export interface ResponsesWebSocketState {
  data: ResponsesWebSocketData
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface WebSocketErrorFrameOptions {
  code: string
  message: string
  status: number
  param?: string
  requestId?: string
  type?: string
  upstreamBody?: string | ReadonlyArray<number>
  upstreamContentType?: string
}

interface ResponseCompletedFrame {
  response?: {
    id?: unknown
    output?: unknown
  }
  type?: string
}

/**
 * Check if a request is a responses WebSocket upgrade and handle it.
 * Returns "upgraded" if the upgrade was handled, "auth_failed" if auth failed,
 * or "no_match" if the path didn't match.
 */
export async function tryUpgradeResponsesWebSocket(
  req: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): Promise<"upgraded" | "auth_failed" | "no_match"> {
  const url = new URL(req.url)
  if (!WS_PATHS.has(url.pathname)) {
    return "no_match"
  }

  const auth = await resolveProtectedCredential(
    req,
    async () => await resolveRequestCredential(req, ["user:inference"]),
  )
  if (auth.status !== "authorized") return "auth_failed"

  const requestId =
    req.headers.get("x-request-id")
    ?? req.headers.get("x-client-request-id")
    ?? randomUUID()
  const affinity = resolveRoutingAffinityFromHeaders(req.headers)
  const nativeMessagesOptions = sanitizeAnthropicRequestHeaderOptions({
    anthropicBeta: req.headers.get("anthropic-beta"),
    anthropicVersion: req.headers.get("anthropic-version"),
    modelProviderPreference: req.headers.get("x-model-provider-preference"),
  })

  const data: ResponsesWebSocketData = {
    type: "responses",
    activeTurns: new Map<number, ResponsesWebSocketTurn>(),
    closed: false,
    nextTurnSequence: 0,
    requestId,
    affinity,
    nativeMessagesOptions,
    effectiveNativeMessagesOptions: { ...nativeMessagesOptions },
    responseSnapshots: new Map<string, ResponsesPayload>(),
  }
  if (!server.upgrade(req, { data })) return "no_match"
  return "upgraded"
}

// Bun WebSocket handler for responses
export const responsesWebSocket = {
  open(_ws: { data: ResponsesWebSocketData }) {
    consola.debug("[responses-ws] WebSocket connected")
  },

  // Protocol validation and turn lifecycle intentionally share one dispatcher.

  // The dispatcher is intentionally linear so every preflight/stream branch
  // shares one turn owner and one terminal guard.
  // eslint-disable-next-line complexity, max-lines-per-function
  async message(
    ws: ResponsesWebSocketState,
    message: string | Buffer | Uint8Array,
  ) {
    if (ws.data.closed) return

    const parsed = parseResponsesWebSocketFrame(message)
    if (!parsed.ok) {
      sendWebSocketError(ws, parsed.error)
      return
    }
    if (typeof message !== "string") return

    const {
      attribution,
      initiator,
      nativeMessagesOptions,
      payload: parsedPayload,
      requestedModel,
    } = parsed.value
    parsedPayload.stream = true
    ws.data.effectiveNativeMessagesOptions =
      mergeEffectiveNativeMessagesOptions(
        ws.data.effectiveNativeMessagesOptions,
        nativeMessagesOptions,
      )
    const turnNativeMessagesOptions = {
      ...ws.data.effectiveNativeMessagesOptions,
    }
    const turn = createResponsesWebSocketTurn(ws.data, message)
    turn.requestedModel = requestedModel
    turn.model = requestedModel
    ensureResponsesWebSocketLifecycle(turn, {
      model: requestedModel ?? "unknown",
      requestedModel,
    })

    try {
      const { affinity, payload } = await prepareResponseCreate(
        ws.data,
        parsedPayload,
      )
      await runWithWebSocketRequestContext(
        affinity,
        attribution,
        turn,
        async () => {
          await handleResponseCreate(ws, {
            initiator,
            payload,
            requestedModel,
            nativeMessagesOptions: turnNativeMessagesOptions,
            turn,
          })
        },
      )
      if (turn.terminal.state === "open") {
        await failWebSocketTurn(ws, turn, { kind: "source_ended" })
      }
    } catch (error) {
      const terminal = await classifyWebSocketTerminal(error, turn)
      const errorInspection = terminal.errorInspection
      if (
        terminal.terminalStatus !== "ABORTED"
        && turn.outputStarted
        && turn.terminal.state === "open"
      ) {
        await failWebSocketTurn(ws, turn, {
          kind: "thrown",
          error,
          ...(errorInspection ? { inspection: errorInspection } : {}),
        })
        if (errorInspection?.kind === "upstream") {
          reportHttpErrorForTransport(errorInspection, {
            method: "POST",
            path: "/responses",
          })
        }
        return
      }
      const normalized = normalizeWebSocketError(error, errorInspection)
      const committed = await turn.terminal.fail({
        kind: "thrown",
        error,
        ...(errorInspection ? { inspection: errorInspection } : {}),
      })
      if (terminal.terminalStatus === "ABORTED") {
        consola.debug(`[responses-ws] ${turn.turnId} aborted`)
        return
      }
      if (!committed) return
      if (errorInspection?.kind === "upstream") {
        reportHttpErrorForTransport(errorInspection, {
          method: "POST",
          path: "/responses",
        })
      }
      consola.error(`[responses-ws] ${turn.turnId} error`, {
        code: normalized.code,
        status: terminal.status,
      })
      try {
        sendWebSocketError(ws, normalized)
      } catch {
        // Client already disconnected, nothing to do
      }
    }
  },

  close(ws: { data: ResponsesWebSocketData }) {
    ws.data.closed = true
    for (const turn of ws.data.activeTurns.values()) {
      const abortError = new Error("Responses WebSocket closed")
      abortError.name = "AbortError"
      turn.abortController.abort(abortError)
      if (!turn.terminal.abort()) continue
      ensureResponsesWebSocketLifecycle(turn)
      finalizeResponsesWebSocketTurn(ws.data, turn, {
        error: abortError,
        status: 499,
        terminalStatus: "ABORTED",
      })
    }
    ws.data.responseSnapshots.clear()
    ws.data.effectiveNativeMessagesOptions = {}
    consola.debug("[responses-ws] WebSocket closed")
  },
}

async function prepareResponseCreate(
  data: ResponsesWebSocketData,
  rawPayload: ResponsesPayload,
): Promise<{
  affinity: RoutingAffinity | undefined
  payload: ResponsesPayload
}> {
  const previousResponseId = rawPayload.previous_response_id
  const payloadForResolution =
    (
      typeof previousResponseId === "string"
      && typeof rawPayload.model === "string"
    ) ?
      {
        ...rawPayload,
        model: await normalizeRequestedWebSocketModel(rawPayload),
      }
    : rawPayload
  const resolution = resolveResponsesContinuation(
    data.responseSnapshots,
    payloadForResolution,
  )
  if (!resolution.ok) {
    if (resolution.code === "previous_response_not_found") {
      recordCopilotContractEvent({
        kind: "websocket_continuation",
        outcome: "not_found",
      })
    }
    throw new WebSocketRequestError(
      resolution.message,
      resolution.status,
      "invalid_request_error",
      resolution.code,
    )
  }
  recordCopilotContractEvent({
    kind: "websocket_continuation",
    outcome:
      rawPayload.previous_response_id === undefined ?
        "new_thread"
      : "rehydrated",
  })
  const payload = resolution.payload
  const frameAffinity = resolveResponsesRoutingAffinity(payload.client_metadata)
  return { affinity: data.affinity ?? frameAffinity, payload }
}

function storeResponseSnapshot(
  snapshots: Map<string, ResponsesPayload>,
  responseId: string,
  payload: ResponsesPayload,
): void {
  snapshots.set(responseId, payload)
}

// Routing preparation and dispatch remain together to preserve the per-turn
// request context through native and translated writers.
// eslint-disable-next-line max-lines-per-function
async function handleResponseCreate(
  ws: ResponsesWebSocketState,
  options: {
    initiator?: "agent" | "user"
    nativeMessagesOptions: NativeMessagesRequestOptions
    payload: ResponsesPayload
    requestedModel: string | undefined
    turn: ResponsesWebSocketTurn
  },
): Promise<void> {
  const {
    initiator: initiatorOverride,
    payload,
    requestedModel,
    nativeMessagesOptions,
    turn,
  } = options
  turn.requestedModel = requestedModel
  turn.model = requestedModel

  const reasoningEffort = await waitForWebSocketTurn(
    applyResponsesWebSocketRouting(payload),
    turn,
  )
  throwIfWebSocketTurnAborted(turn)
  turn.model = payload.model
  turn.reasoningEffort = reasoningEffort
  ensureResponsesWebSocketLifecycle(turn, {
    model: payload.model,
    reasoningEffort,
    requestedModel,
  })

  expandCompactionItems(payload)
  disableParallelWebSearch(payload)
  throwIfWebSocketTurnAborted(turn)

  const routedModel = selectRoutedModel(payload.model)
  const selectedModel = routedModel.model
  const route = await waitForWebSocketTurn(
    prepareResponsesRouteForTransport({
      payload,
      selectedModel,
      signal: turn.abortController.signal,
    }),
    turn,
  )
  const preparedPayload = route.preparedPayload
  if (route.decision.target === "/v1/messages") {
    recordCopilotMessagesBeta(nativeMessagesOptions.anthropicBeta)
  }

  if (isSyntheticWarmupRequest(preparedPayload)) {
    await handleSyntheticWarmupRequest(ws, preparedPayload, turn)
    return
  }

  const { vision, initiator: inferredInitiator } =
    getResponsesRequestOptions(preparedPayload)
  const initiator = initiatorOverride ?? inferredInitiator

  await runWithRoutedModelSelection(routedModel, async () => {
    if (
      await dispatchTranslatedWebSocketEndpoint({
        initiator,
        nativeMessagesOptions,
        preparedPayload,
        requestedModel,
        routeTarget: route.decision.target,
        turn,
        ws,
      })
    ) {
      return
    }

    // Native responses streaming
    const response = await waitForWebSocketTurn(
      createResponses(preparedPayload, {
        vision,
        initiator,
        prepared: true,
        signal: turn.abortController.signal,
      }),
      turn,
    )
    throwIfWebSocketTurnAborted(turn)

    if (!isAsyncIterable(response)) {
      // Shouldn't happen since we forced stream: true, but handle gracefully
      await handleNonStreamingResponsesResult(ws, {
        payload: preparedPayload,
        response,
        turn,
      })
      return
    }

    const idTracker = createStreamIdTracker()
    for await (const chunk of response) {
      const data = (chunk as { data?: string }).data
      if (!data) continue

      const event = (chunk as { event?: string }).event
      const processed = addResponsesWebSocketMetadata(
        fixStreamIds(data, event, idTracker),
        getCopilotResponseHeaders(),
      )
      await emitTurnFrame(ws, turn, preparedPayload, processed, event)
      if (turn.terminal.state !== "open") break
    }
  })
}

async function handleNonStreamingResponsesResult(
  ws: ResponsesWebSocketState,
  options: {
    payload: ResponsesPayload
    response: ResponsesResult
    turn: ResponsesWebSocketTurn
  },
): Promise<void> {
  const { payload, response, turn } = options
  await emitTurnFrame(
    ws,
    turn,
    payload,
    JSON.stringify({ type: "response.completed", response }),
    "response.completed",
  )
}

async function dispatchTranslatedWebSocketEndpoint(options: {
  initiator: "agent" | "user"
  nativeMessagesOptions: NativeMessagesRequestOptions
  preparedPayload: ResponsesPayload
  requestedModel: string | undefined
  routeTarget: string
  turn: ResponsesWebSocketTurn
  ws: ResponsesWebSocketState
}): Promise<boolean> {
  const {
    initiator,
    nativeMessagesOptions,
    preparedPayload,
    requestedModel,
    routeTarget,
    turn,
    ws,
  } = options
  if (routeTarget === "/v1/messages") {
    reportResponsesWebSocketEndpointFallback(
      preparedPayload.model,
      "AnthropicMessages",
    )
    await streamAnthropicMessagesOverWs({
      nativeOptions: {
        ...nativeMessagesOptions,
        initiatorOverride: initiator,
        requestedModel,
      },
      payload: preparedPayload,
      turn,
      ws,
    })
    return true
  }

  if (routeTarget !== "/chat/completions") return false
  convertWebSearchTool(preparedPayload)
  // Rewrite custom apply_patch to a function tool only for the CC fallback.
  // Native /responses must keep the freeform tool intact.
  useFunctionApplyPatch(preparedPayload)
  reportResponsesWebSocketEndpointFallback(
    preparedPayload.model,
    "ChatCompletions",
  )
  await streamChatCompletionsOverWs({
    initiator,
    payload: preparedPayload,
    turn,
    ws,
  })
  return true
}

async function waitForWebSocketTurn<T>(
  promise: Promise<T>,
  turn: ResponsesWebSocketTurn,
): Promise<T> {
  throwIfWebSocketTurnAborted(turn)
  const signal = turn.abortController.signal
  let abortListener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      const reason: unknown = signal.reason
      if (reason instanceof Error) {
        reject(reason)
        return
      }
      const error = new Error("Responses WebSocket request aborted")
      error.name = "AbortError"
      reject(error)
    }
    signal.addEventListener("abort", abortListener, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener)
  }
}

async function failWebSocketTurn(
  ws: ResponsesWebSocketState,
  turn: ResponsesWebSocketTurn,
  failure:
    | { kind: "source_ended" }
    | { kind: "thrown"; error: unknown; inspection?: HttpErrorInspection },
): Promise<boolean> {
  if (
    ws.data.closed
    || turn.abortController.signal.aborted
    || turn.terminal.state !== "open"
  ) {
    return false
  }
  const state = turn.failureState
  if (state.model === "unknown" && turn.model) state.model = turn.model
  const writeFailure = async () => {
    await emitResponsesFailureAsStream(
      {
        get aborted() {
          return turn.abortController.signal.aborted
        },
        get closed() {
          return ws.data.closed
        },
        writeSSE: (data) => {
          if (!ws.data.closed && !turn.abortController.signal.aborted) {
            ws.send(
              addResponsesWebSocketMetadata(
                data.data,
                getCopilotResponseHeaders(),
              ),
            )
          }
          return Promise.resolve()
        },
      },
      {
        responseId: state.responseId,
        model: state.model,
        sequenceNumber: state.sequenceNumber,
        ...(failure.kind === "thrown" && failure.inspection ?
          { inspection: failure.inspection }
        : {}),
      },
    )
  }
  turn.failureWriters.set(failure, writeFailure)
  try {
    return await turn.terminal.fail(failure)
  } finally {
    turn.failureWriters.delete(failure)
  }
}

// Terminal frame classification has intentionally explicit branches so close
// races cannot overwrite a client-visible completion.

// eslint-disable-next-line max-params
async function emitTurnFrame(
  ws: ResponsesWebSocketState,
  turn: ResponsesWebSocketTurn,
  payload: ResponsesPayload,
  frame: string,
  eventName?: string,
): Promise<boolean> {
  if (
    ws.data.closed
    || turn.abortController.signal.aborted
    || turn.terminal.state !== "open"
  ) {
    return false
  }
  let parsed: {
    response?: { id?: unknown }
    type?: unknown
  }
  try {
    parsed = JSON.parse(frame) as typeof parsed
  } catch {
    ws.send(frame)
    return true
  }

  const terminalType = classifyEmittedWebSocketTerminal(parsed, eventName)
  const processed = addResponsesWebSocketMetadata(
    frame,
    getCopilotResponseHeaders(),
  )
  ws.send(processed)
  turn.outputStarted = true
  updateResponsesFailureState(turn.failureState, {
    data: processed,
    event: typeof terminalType === "string" ? terminalType : eventName,
  })

  if (terminalType === "response.completed") {
    const responseStatus = readEmittedResponseStatus(parsed)
    if (responseStatus !== "failed" && responseStatus !== "incomplete") {
      recordResponseSnapshotFromFrame(
        ws.data.responseSnapshots,
        payload,
        processed,
      )
    } else {
      return await turn.terminal.succeed({
        kind: "received_failure",
        status: 502,
        terminalStatus: "ERROR",
      })
    }
    return await turn.terminal.succeed({
      kind: "completed",
      status: 200,
      terminalStatus: "COMPLETE",
    })
  }
  if (terminalType === "response.incomplete") {
    return await turn.terminal.succeed({
      kind: "incomplete",
      status: 200,
      terminalStatus: "COMPLETE",
    })
  }
  if (terminalType === "response.failed" || terminalType === "error") {
    return await turn.terminal.succeed({
      kind: "received_failure",
      status: 502,
      terminalStatus: "ERROR",
    })
  }
  return true
}

function readEmittedResponseStatus(parsed: {
  response?: { id?: unknown }
}): unknown {
  const response = parsed.response as Record<string, unknown> | undefined
  return response?.status
}

function getRedirectReasoningEffort(
  effort: NonNullable<ResponsesPayload["reasoning"]>["effort"] | undefined,
): ReasoningEffort | undefined {
  return parseReasoningEffort(effort)
}

async function applyResponsesWebSocketRouting(
  payload: ResponsesPayload,
): Promise<ReasoningEffort | undefined> {
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    payload.model,
  )
  payload.model = normalizeModelName(baseModel)
  const effectiveEffort = normalizeResponsesReasoning(payload, suffixEffort)
  const redirect = await resolveResponsesWebSocketRedirect(
    payload.model,
    effectiveEffort,
  )

  // eslint-disable-next-line require-atomic-updates
  payload.model = normalizeModelName(redirect.model)
  const redirectedEffort = normalizeReasoningEffortForModel(
    payload.model,
    redirect.effort,
  )
  reportClampedWebSocketEffort({
    model: payload.model,
    requestedEffort: redirect.effort,
    effectiveEffort: redirectedEffort,
    redirected: true,
  })
  applyRedirectedResponsesEffort(payload, payload.model, redirectedEffort)
  return redirectedEffort ?? getRedirectReasoningEffort(effectiveEffort)
}

async function normalizeRequestedWebSocketModel(
  payload: ResponsesPayload,
): Promise<string> {
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    payload.model,
  )
  const normalizedModel = normalizeModelName(baseModel)
  const effectiveEffort = normalizeResponsesReasoning(
    structuredClone(payload),
    suffixEffort,
  )
  const redirect = await applyModelRedirect({
    model: normalizedModel,
    effort: getRedirectReasoningEffort(effectiveEffort),
  })
  return normalizeModelName(redirect.model)
}

async function resolveResponsesWebSocketRedirect(
  model: string,
  effectiveEffort:
    | NonNullable<ResponsesPayload["reasoning"]>["effort"]
    | undefined,
): Promise<Awaited<ReturnType<typeof applyModelRedirect>>> {
  const redirectRawEffort = getRedirectReasoningEffort(effectiveEffort)
  const requestedEffort = normalizeReasoningEffortForModel(
    model,
    redirectRawEffort,
  )
  reportClampedWebSocketEffort({
    model,
    requestedEffort: redirectRawEffort,
    effectiveEffort: requestedEffort,
  })

  const redirect = await applyModelRedirect({ model, effort: requestedEffort })
  if (redirect.redirected) {
    reportNonDefaultBehavior({
      kind: "model_redirect",
      message: `Responses WebSocket model redirect chain: ${formatModelRedirectResult(redirect)}`,
      data: {
        sourceModel: model,
        sourceEffort: requestedEffort,
        targetModel: redirect.model,
        targetEffort: redirect.effort,
        ruleId: redirect.ruleId,
        ruleIds: redirect.ruleIds?.join(","),
        transport: "websocket",
      },
    })
  }
  return redirect
}

function reportClampedWebSocketEffort(options: {
  model: string
  requestedEffort?: ReasoningEffort
  effectiveEffort?: ReasoningEffort
  redirected?: boolean
}): void {
  if (
    !options.requestedEffort
    || options.effectiveEffort === options.requestedEffort
  ) {
    return
  }
  const prefix = options.redirected ? "redirected" : "requested"
  reportNonDefaultBehavior({
    kind: "reasoning_effort_clamped",
    message: `Responses WebSocket ${prefix} effort ${options.requestedEffort} for ${options.model} was clamped to ${options.effectiveEffort}`,
    data: {
      model: options.model,
      requestedEffort: options.requestedEffort,
      effectiveEffort: options.effectiveEffort,
      transport: "websocket",
    },
  })
}

function reportResponsesWebSocketEndpointFallback(
  model: string,
  targetEndpoint: "AnthropicMessages" | "ChatCompletions",
): void {
  reportNonDefaultBehavior({
    kind: "endpoint_fallback",
    message: `Responses WebSocket model ${model} does not support /responses; falling back to ${targetEndpoint}`,
    data: {
      model,
      sourceEndpoint: "Responses WebSocket",
      targetEndpoint,
      transport: "websocket",
    },
  })
}

function applyRedirectedResponsesEffort(
  payload: ResponsesPayload,
  model: string,
  effort: ReasoningEffort | undefined,
): void {
  if (!effort) {
    if (usesImplicitReasoningDefault(model) && payload.reasoning) {
      reportNonDefaultBehavior({
        kind: "reasoning_effort_implicit_default",
        message: `Responses WebSocket ${model} is configured for implicit reasoning defaults; removing explicit reasoning config`,
        data: { model, transport: "websocket" },
      })
      delete payload.reasoning
    }
    return
  }
  if (usesImplicitReasoningDefault(model)) {
    reportNonDefaultBehavior({
      kind: "reasoning_effort_implicit_default",
      message: `Responses WebSocket ${model} is configured for implicit reasoning defaults; removing explicit reasoning.effort=${effort}`,
      data: {
        model,
        requestedEffort: effort,
        transport: "websocket",
      },
    })
    delete payload.reasoning
    return
  }
  payload.reasoning =
    payload.reasoning ? { ...payload.reasoning, effort } : { effort }
}

export {
  extractResponsesPayload,
  rehydrateContinuationPayload,
} from "./websocket-protocol"

export function isSyntheticWarmupRequest(payload: ResponsesPayload): boolean {
  return (payload as Record<string, unknown>).generate === false
}

export function rehydrateWarmupPayload(
  warmupPayload: ResponsesPayload,
  payload: ResponsesPayload,
): ResponsesPayload {
  return rehydrateContinuationPayloadFromSnapshot(warmupPayload, payload)
}

async function handleSyntheticWarmupRequest(
  ws: ResponsesWebSocketState,
  payload: ResponsesPayload,
  turn: ResponsesWebSocketTurn,
): Promise<void> {
  const responseId = `warmup_${randomUUID().replaceAll("-", "")}`
  storeResponseSnapshot(ws.data.responseSnapshots, responseId, payload)

  const createdAt = Math.floor(Date.now() / 1000)
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    model: payload.model,
    output: [],
    output_text: "",
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: payload.instructions ?? null,
    metadata: payload.metadata ?? null,
    parallel_tool_calls: payload.parallel_tool_calls ?? false,
    temperature: payload.temperature ?? null,
    tool_choice: payload.tool_choice ?? "auto",
    tools: payload.tools ?? [],
    top_p: payload.top_p ?? null,
  }

  await emitTurnFrame(
    ws,
    turn,
    payload,
    JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: {
        ...baseResponse,
        status: "in_progress",
      },
    }),
    "response.created",
  )

  const completedFrame = JSON.stringify({
    type: "response.completed",
    sequence_number: 1,
    response: {
      ...baseResponse,
      status: "completed",
    },
  })
  await emitTurnFrame(ws, turn, payload, completedFrame, "response.completed")
}

async function streamAnthropicMessagesOverWs(options: {
  nativeOptions: NativeMessagesRequestOptions
  payload: ResponsesPayload
  turn: ResponsesWebSocketTurn
  ws: ResponsesWebSocketState
}): Promise<void> {
  const { nativeOptions, payload, turn, ws } = options
  const result = await waitForWebSocketTurn(
    executeResponsesMessagesBridge({
      attachmentsNormalized: true,
      compaction: isResponsesCompactionRequest(payload),
      nativeOptions,
      payload,
      preserveValidatedControls: true,
      signal: turn.abortController.signal,
    }),
    turn,
  )
  throwIfWebSocketTurnAborted(turn)
  const wsStream = {
    writeSSE: async (data: { event?: string; data: string }) => {
      if (data.data === "[DONE]") return
      await emitTurnFrame(ws, turn, payload, data.data, data.event)
    },
  }
  await emitResponsesResultAsWebSocketFrames(wsStream, result)
}

async function emitResponsesResultAsWebSocketFrames(
  stream: {
    writeSSE: (data: { event?: string; data: string }) => Promise<void>
  },
  result: ResponsesResult,
): Promise<void> {
  const created = { ...result, status: "in_progress" as const }
  await stream.writeSSE({
    event: "response.created",
    data: JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: created,
    }),
  })
  await stream.writeSSE({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      sequence_number: 1,
      response: result,
    }),
  })
}

async function streamChatCompletionsOverWs(options: {
  initiator: "agent" | "user"
  payload: ResponsesPayload
  turn: ResponsesWebSocketTurn
  ws: ResponsesWebSocketState
}): Promise<void> {
  const { initiator, payload, turn, ws } = options
  const compaction = isResponsesCompactionRequest(payload)
  const fitted = compaction ? fitResponsesCompactionPayload(payload) : null
  const fallbackPayload = fitted?.payload ?? payload
  if (fitted?.reduced) {
    consola.warn("Reduced oversized WebSocket fallback compaction payload", {
      originalBytes: fitted.originalBytes,
      finalBytes: fitted.finalBytes,
      omittedBinaryBlocks: fitted.omittedBinaryBlocks,
      truncatedToolOutputBytes: fitted.truncatedToolOutputBytes,
    })
  }
  const ccPayload = responsesToChatCompletions(fallbackPayload, {
    preserveCustomToolContext: compaction,
  })
  const needsWebSearch =
    ccPayload.tools?.some((tool) => tool.function.name === "web_search")
    ?? false
  if (needsWebSearch) {
    await streamChatWebSearchOverWs({
      ws,
      payload,
      ccPayload,
      compaction,
      initiator,
      turn,
    })
    return
  }
  ccPayload.stream = true
  ccPayload.stream_options = { include_usage: true }

  const response = await waitForWebSocketTurn(
    createChatCompletions(ccPayload, {
      compaction,
      initiator,
      signal: turn.abortController.signal,
    }),
    turn,
  )
  throwIfWebSocketTurnAborted(turn)
  const ccStream = response as AsyncIterable<{ data?: string; event?: string }>

  // Reuse the CC→Responses streaming translator with a WebSocket-backed writer
  const wsStream = {
    writeSSE: async (data: { event?: string; data: string }) => {
      if (data.data === "[DONE]") return
      await emitTurnFrame(ws, turn, payload, data.data, data.event)
    },
  }

  await streamChatCompletionsAsResponses(wsStream, ccStream, payload.model)
}

async function streamChatWebSearchOverWs(options: {
  ws: ResponsesWebSocketState
  payload: ResponsesPayload
  ccPayload: ReturnType<typeof responsesToChatCompletions>
  compaction: boolean
  initiator: "agent" | "user"
  turn: ResponsesWebSocketTurn
}): Promise<void> {
  const { ws, payload, ccPayload, compaction, initiator, turn } = options
  ccPayload.stream = false
  ccPayload.stream_options = null
  const initial = (await waitForWebSocketTurn(
    createChatCompletions(ccPayload, {
      compaction,
      initiator,
      signal: turn.abortController.signal,
    }),
    turn,
  )) as ChatCompletionResponse
  const response = await resolveWebSearchCalls(initial, ccPayload, {
    abortSignal: turn.abortController.signal,
    createCompletion: async (nextPayload) =>
      (await createChatCompletions(nextPayload, {
        compaction,
        initiator,
        signal: turn.abortController.signal,
      })) as ChatCompletionResponse,
  })
  const wsStream = {
    writeSSE: async (data: { event?: string; data: string }) => {
      if (data.data === "[DONE]") return
      await emitTurnFrame(ws, turn, payload, data.data, data.event)
    },
  }
  await streamChatCompletionsAsResponses(
    wsStream,
    chatResponseAsStream(response),
    payload.model,
  )
}

function chatResponseAsStream(
  response: ChatCompletionResponse,
): AsyncIterable<{ data: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      // Keep this a real async iterable so it matches live SSE streams.
      await Promise.resolve()
      for (const choice of response.choices) {
        yield {
          data: JSON.stringify({
            id: response.id,
            object: "chat.completion.chunk",
            created: response.created,
            model: response.model,
            choices: [
              {
                index: choice.index,
                delta: {
                  role: "assistant",
                  content: choice.message.content,
                  reasoning_text: choice.message.reasoning_text,
                  reasoning_opaque: choice.message.reasoning_opaque,
                  tool_calls: choice.message.tool_calls?.map(
                    (toolCall, index) => ({
                      ...toolCall,
                      index,
                    }),
                  ),
                },
                finish_reason: choice.finish_reason,
                logprobs: choice.logprobs,
              },
            ],
            usage: response.usage,
          }),
        }
      }
      yield { data: "[DONE]" }
    },
  }
}

export function recordResponseSnapshotFromFrame(
  responseSnapshots: Map<string, ResponsesPayload>,
  payload: ResponsesPayload,
  frame: string,
): void {
  let parsed: ResponseCompletedFrame
  try {
    parsed = JSON.parse(frame) as ResponseCompletedFrame
  } catch {
    return
  }

  if (parsed.type !== "response.completed") return
  const responseId = parsed.response?.id
  if (typeof responseId !== "string" || !responseId) return

  storeResponseSnapshot(
    responseSnapshots,
    responseId,
    createCompletedResponseSnapshot(payload, parsed),
  )
}

function createCompletedResponseSnapshot(
  payload: ResponsesPayload,
  frame: ResponseCompletedFrame,
): ResponsesPayload {
  const output = frame.response?.output
  const snapshotPayload = structuredClone(payload)
  const completedInput =
    Array.isArray(output) ?
      mergeContinuationInput(snapshotPayload.input, structuredClone(output))
    : snapshotPayload.input

  return {
    ...snapshotPayload,
    input: completedInput,
    previous_response_id: undefined,
    generate: undefined,
  }
}

export function sendWebSocketError(
  ws: Pick<ResponsesWebSocketState, "data" | "send">,
  options: WebSocketErrorFrameOptions,
): void {
  ws.send(
    JSON.stringify({
      type: "error",
      status: options.status,
      error: {
        code: options.code,
        message: options.message,
        ...(options.param ? { param: options.param } : {}),
        type: options.type ?? "websocket_error",
        request_id: options.requestId ?? ws.data.requestId,
        ...(options.upstreamBody === undefined ?
          {}
        : { upstream_body: options.upstreamBody }),
        ...(options.upstreamContentType ?
          { upstream_content_type: options.upstreamContentType }
        : {}),
      },
    }),
  )
}

function normalizeWebSocketError(
  error: unknown,
  inspection?: HttpErrorInspection,
): WebSocketErrorFrameOptions {
  if (isHTTPError(error) && error instanceof WebSocketRequestError) {
    return {
      code: error.errorCode,
      message: error.message,
      status: error.response.status,
      type: error.errorType,
    }
  }
  if (inspection?.localError) {
    const local = inspection.localError
    const code = mapLocalWebSocketErrorCode(local, inspection.status)
    return {
      code,
      message: local.message,
      ...(local.param ? { param: local.param } : {}),
      status: inspection.status,
      type: local.type,
    }
  }
  if (inspection?.kind === "upstream") {
    return {
      code: mapHttpStatusToWebSocketErrorCode(inspection.status),
      message: "Upstream request failed",
      status: inspection.status,
      type: "websocket_error",
      upstreamBody: inspection.bodyText ?? Array.from(inspection.bodyBytes),
      ...(inspection.contentType ?
        { upstreamContentType: inspection.contentType }
      : {}),
    }
  }
  if (inspection) {
    return {
      code: mapHttpStatusToWebSocketErrorCode(inspection.status),
      message: "Upstream request failed",
      status: inspection.status,
      type: "websocket_error",
    }
  }

  return {
    code: "internal_error",
    message: "Internal server error",
    status: 500,
    type: "websocket_error",
  }
}

function mapLocalWebSocketErrorCode(
  local: NonNullable<HttpErrorInspection["localError"]>,
  status: number,
): string {
  if (
    local.type === "session_affinity_error"
    || local.type === "account_unavailable"
  ) {
    return mapHttpStatusToWebSocketErrorCode(status)
  }
  if (
    local.code === "compaction_payload_too_large"
    || local.code === "responses_payload_too_large"
  ) {
    return "request_too_large"
  }
  return local.code ?? mapHttpStatusToWebSocketErrorCode(status)
}

function mapHttpStatusToWebSocketErrorCode(status: number): string {
  switch (status) {
    case 400: {
      return "bad_request"
    }
    case 404: {
      return "not_found"
    }
    case 413: {
      return "request_too_large"
    }
    case 429: {
      return "rate_limited"
    }
    case 503: {
      return "service_unavailable"
    }
    default: {
      return status >= 500 ? "internal_error" : "bad_request"
    }
  }
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
