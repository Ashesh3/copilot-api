/* eslint-disable max-lines */
import consola from "consola"
import { randomUUID } from "node:crypto"

import type { SafeHttpErrorInspection } from "~/lib/error"
import type { RoutingAffinity } from "~/lib/routing-affinity"
import type { NativeMessagesRequestOptions } from "~/routes/messages/native-handler"

import { runWithCopilotRequestAttribution } from "~/lib/copilot-request-context"
import { resolveRequestCredential } from "~/lib/credential-resolver"
import { isHTTPError } from "~/lib/error"
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
import {
  resolveResponsesRoutingAffinity,
  resolveRoutingAffinityFromHeaders,
} from "~/lib/routing-affinity"
import { state } from "~/lib/state"
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
  SAFE_RESPONSES_STREAM_ERROR_MESSAGE,
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
      payload: parsedPayload,
      requestedModel,
    } = parsed.value
    parsedPayload.stream = true
    const turn = createResponsesWebSocketTurn(ws.data, message)
    turn.requestedModel = requestedModel
    turn.model = requestedModel
    ensureResponsesWebSocketLifecycle(turn, {
      model: requestedModel ?? "unknown",
      requestedModel,
    })

    try {
      const { affinity, payload } = prepareResponseCreate(
        ws.data,
        parsedPayload,
      )
      await runWithCopilotRequestAttribution(attribution, async () => {
        await runWithWebSocketRequestContext(affinity, turn, async () => {
          await handleResponseCreate(ws, {
            initiator,
            payload,
            requestedModel,
            turn,
          })
        })
      })
      if (!turn.finalized) {
        throw new WebSocketRequestError(
          "Responses stream ended without a terminal frame",
          502,
          "server_error",
          "server_error",
        )
      }
    } catch (error) {
      const terminal = classifyWebSocketTerminal(error, turn)
      const errorInspection = terminal.errorInspection
      const normalized = normalizeWebSocketError(error, errorInspection)
      finalizeResponsesWebSocketTurn(ws.data, turn, {
        error,
        ...terminal,
      })
      if (terminal.terminalStatus === "ABORTED") {
        consola.debug(`[responses-ws] ${turn.turnId} aborted`)
        return
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
      ensureResponsesWebSocketLifecycle(turn)
      finalizeResponsesWebSocketTurn(ws.data, turn, {
        error: abortError,
        status: 499,
        terminalStatus: "ABORTED",
      })
    }
    ws.data.responseSnapshots.clear()
    consola.debug("[responses-ws] WebSocket closed")
  },
}

function prepareResponseCreate(
  data: ResponsesWebSocketData,
  rawPayload: ResponsesPayload,
): { affinity: RoutingAffinity | undefined; payload: ResponsesPayload } {
  const resolution = resolveResponsesContinuation(
    data.responseSnapshots,
    rawPayload,
  )
  if (!resolution.ok) {
    throw new WebSocketRequestError(
      resolution.message,
      resolution.status,
      "invalid_request_error",
      resolution.code,
    )
  }
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

async function handleResponseCreate(
  ws: ResponsesWebSocketState,
  options: {
    initiator?: "agent" | "user"
    payload: ResponsesPayload
    requestedModel: string | undefined
    turn: ResponsesWebSocketTurn
  },
): Promise<void> {
  const {
    initiator: initiatorOverride,
    payload,
    requestedModel,
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

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const route = await waitForWebSocketTurn(
    prepareResponsesRouteForTransport({
      payload,
      selectedModel,
      signal: turn.abortController.signal,
    }),
    turn,
  )
  const preparedPayload = route.preparedPayload

  if (isSyntheticWarmupRequest(preparedPayload)) {
    handleSyntheticWarmupRequest(ws, preparedPayload, turn)
    return
  }

  const { vision, initiator: inferredInitiator } =
    getResponsesRequestOptions(preparedPayload)
  const initiator = initiatorOverride ?? inferredInitiator

  if (
    await dispatchTranslatedWebSocketEndpoint({
      initiator,
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
    ws.send(JSON.stringify({ type: "response.completed", response }))
    finalizeResponsesWebSocketTurn(ws.data, turn, {
      status: 200,
      terminalStatus: "COMPLETE",
    })
    return
  }

  const idTracker = createStreamIdTracker()
  for await (const chunk of response) {
    const data = (chunk as { data?: string }).data
    if (!data) continue

    const event = (chunk as { event?: string }).event
    const processed = fixStreamIds(data, event, idTracker)
    recordResponseSnapshotFromFrame(
      ws.data.responseSnapshots,
      preparedPayload,
      processed,
    )
    ws.send(processed)
    finalizeFromResponsesFrame(ws.data, turn, processed)
    if (turn.lifecycle?.isFinalized()) break
  }
}

async function dispatchTranslatedWebSocketEndpoint(options: {
  initiator: "agent" | "user"
  preparedPayload: ResponsesPayload
  requestedModel: string | undefined
  routeTarget: string
  turn: ResponsesWebSocketTurn
  ws: ResponsesWebSocketState
}): Promise<boolean> {
  const { initiator, preparedPayload, requestedModel, routeTarget, turn, ws } =
    options
  if (routeTarget === "/v1/messages") {
    reportResponsesWebSocketEndpointFallback(
      preparedPayload.model,
      "AnthropicMessages",
    )
    await streamAnthropicMessagesOverWs({
      nativeOptions: {
        ...ws.data.nativeMessagesOptions,
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

// Terminal frame classification has intentionally explicit branches so close
// races cannot overwrite a client-visible completion.

function finalizeFromResponsesFrame(
  data: ResponsesWebSocketData,
  turn: ResponsesWebSocketTurn,
  frame: string,
): void {
  let parsed: {
    message?: unknown
    response?: { error?: { message?: unknown } | null; status?: unknown }
    type?: unknown
  }
  try {
    parsed = JSON.parse(frame) as typeof parsed
  } catch {
    return
  }

  if (parsed.type === "response.completed") {
    const responseStatus = parsed.response?.status
    if (responseStatus === "failed" || responseStatus === "incomplete") {
      finalizeResponsesWebSocketTurn(data, turn, {
        error: SAFE_RESPONSES_STREAM_ERROR_MESSAGE,
        status: 502,
        terminalStatus: "ERROR",
      })
      return
    }
    finalizeResponsesWebSocketTurn(data, turn, {
      status: 200,
      terminalStatus: "COMPLETE",
    })
    return
  }

  if (parsed.type === "response.incomplete") {
    finalizeResponsesWebSocketTurn(data, turn, {
      error: "Responses stream ended incomplete",
      status: 502,
      terminalStatus: "ERROR",
    })
    return
  }

  if (parsed.type === "response.failed" || parsed.type === "error") {
    finalizeResponsesWebSocketTurn(data, turn, {
      error: SAFE_RESPONSES_STREAM_ERROR_MESSAGE,
      status: 502,
      terminalStatus: "ERROR",
    })
  }
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

function handleSyntheticWarmupRequest(
  ws: ResponsesWebSocketState,
  payload: ResponsesPayload,
  turn: ResponsesWebSocketTurn,
): void {
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

  ws.send(
    JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: {
        ...baseResponse,
        status: "in_progress",
      },
    }),
  )

  const completedFrame = JSON.stringify({
    type: "response.completed",
    sequence_number: 1,
    response: {
      ...baseResponse,
      status: "completed",
    },
  })
  ws.send(completedFrame)
  finalizeFromResponsesFrame(ws.data, turn, completedFrame)
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
    // eslint-disable-next-line @typescript-eslint/require-await
    writeSSE: async (data: { event?: string; data: string }) => {
      recordResponseSnapshotFromFrame(
        ws.data.responseSnapshots,
        payload,
        data.data,
      )
      ws.send(data.data)
      finalizeFromResponsesFrame(ws.data, turn, data.data)
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
    // eslint-disable-next-line @typescript-eslint/require-await
    writeSSE: async (data: { event?: string; data: string }) => {
      recordResponseSnapshotFromFrame(
        ws.data.responseSnapshots,
        payload,
        data.data,
      )
      ws.send(data.data)
      finalizeFromResponsesFrame(ws.data, turn, data.data)
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
    // eslint-disable-next-line @typescript-eslint/require-await
    writeSSE: async (data: { event?: string; data: string }) => {
      recordResponseSnapshotFromFrame(
        ws.data.responseSnapshots,
        payload,
        data.data,
      )
      ws.send(data.data)
      finalizeFromResponsesFrame(ws.data, turn, data.data)
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
      },
    }),
  )
}

function normalizeWebSocketError(
  error: unknown,
  inspection?: SafeHttpErrorInspection,
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
  local: NonNullable<SafeHttpErrorInspection["localError"]>,
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
