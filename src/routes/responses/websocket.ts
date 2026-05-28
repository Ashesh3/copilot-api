import consola from "consola"
import { randomUUID } from "node:crypto"

import {
  applyModelRedirect,
  formatModelRedirectResult,
} from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  type ReasoningEffort,
  normalizeReasoningEffortForModel,
  parseModelSuffix,
  usesImplicitReasoningDefault,
} from "~/lib/model-suffix"
import { checkRateLimit } from "~/lib/rate-limit"
import { getConfiguredApiKeys } from "~/lib/request-auth"
import { reportNonDefaultBehavior } from "~/lib/request-logger"
import {
  clientSessionStorage,
  quotaHeadersStorage,
  requestIdStorage,
  routedAccountStorage,
} from "~/lib/request-session"
import { state } from "~/lib/state"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

import {
  convertWebSearchTool,
  normalizeResponsesReasoning,
  responsesToChatCompletions,
  streamChatCompletionsAsResponses,
  useFunctionApplyPatch,
} from "./handler"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import { expandCompactionItems, getResponsesRequestOptions } from "./utils"

const RESPONSES_ENDPOINT = "/responses"

const WS_PATHS = new Set(["/v1/responses", "/responses"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export interface ResponsesWebSocketData {
  type: "responses"
  requestId: string
  sessionId?: string
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

interface ContinuationResolutionResult {
  payload?: ResponsesPayload
  shouldStop: boolean
}

/**
 * Check if a request is a responses WebSocket upgrade and handle it.
 * Returns "upgraded" if the upgrade was handled, "auth_failed" if auth failed,
 * or "no_match" if the path didn't match.
 */
export function tryUpgradeResponsesWebSocket(
  req: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): "upgraded" | "auth_failed" | "no_match" {
  const url = new URL(req.url)
  if (!WS_PATHS.has(url.pathname)) {
    return "no_match"
  }

  if (!isAuthorizedResponsesWebSocketUpgrade(req)) {
    return "auth_failed"
  }

  const requestId =
    req.headers.get("x-request-id")
    ?? req.headers.get("x-client-request-id")
    ?? randomUUID()
  const sessionId =
    req.headers.get("x-claude-code-session-id")
    ?? req.headers.get("session-id")
    ?? undefined

  return (
      server.upgrade(req, {
        data: {
          type: "responses" as const,
          requestId,
          sessionId,
          responseSnapshots: new Map<string, ResponsesPayload>(),
        },
      })
    ) ?
      "upgraded"
    : "no_match"
}

function isAuthorizedResponsesWebSocketUpgrade(req: Request): boolean {
  const requestApiKey = extractApiKeyFromRequest(req)

  if (state.apiKeyAuth && requestApiKey !== state.apiKeyAuth) {
    return false
  }

  const configuredApiKeys = getConfiguredApiKeys()
  if (
    configuredApiKeys.length > 0
    && (!requestApiKey || !configuredApiKeys.includes(requestApiKey))
  ) {
    return false
  }

  return true
}

function extractApiKeyFromRequest(req: Request): string | null {
  const xApiKey = req.headers.get("x-api-key")?.trim()
  if (xApiKey) return xApiKey

  const googleApiKey = req.headers.get("x-goog-api-key")?.trim()
  if (googleApiKey) return googleApiKey

  const authorization = req.headers.get("authorization")
  if (!authorization) return null
  const [scheme, ...rest] = authorization.trim().split(/\s+/)
  if (scheme.toLowerCase() !== "bearer") return null
  return rest.join(" ").trim() || null
}

// Bun WebSocket handler for responses
export const responsesWebSocket = {
  open(_ws: { data: ResponsesWebSocketData }) {
    consola.debug("[responses-ws] WebSocket connected")
  },

  async message(
    ws: ResponsesWebSocketState,
    message: string | Buffer | Uint8Array,
  ) {
    if (typeof message !== "string") {
      sendWebSocketError(ws, {
        code: "bad_request",
        message: "Binary frames not supported",
        status: 400,
        type: "invalid_request_error",
      })
      return
    }

    let parsed: { type?: string; [key: string]: unknown }
    try {
      parsed = JSON.parse(message) as { type?: string; [key: string]: unknown }
    } catch {
      sendWebSocketError(ws, {
        code: "bad_request",
        message: "Invalid JSON",
        status: 400,
        type: "invalid_request_error",
      })
      return
    }

    if (parsed.type === "response.processed") {
      return
    }

    if (parsed.type !== "response.create") {
      sendWebSocketError(ws, {
        code: "bad_request",
        message: `Unsupported message type: ${String(parsed.type)}`,
        status: 400,
        type: "invalid_request_error",
      })
      return
    }

    try {
      await runWithWebSocketRequestContext(ws, async () => {
        await handleResponseCreate(ws, parsed)
      })
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Internal server error"
      consola.error("[responses-ws] Error:", errorMessage)
      try {
        sendWebSocketError(ws, normalizeWebSocketError(error, errorMessage))
      } catch {
        // Client already disconnected, nothing to do
      }
    }
  },

  close(ws: { data: ResponsesWebSocketData }) {
    ws.data.responseSnapshots.clear()
    consola.debug("[responses-ws] WebSocket closed")
  },
}

async function runWithWebSocketRequestContext(
  ws: ResponsesWebSocketState,
  callback: () => Promise<void>,
): Promise<void> {
  await requestIdStorage.run(ws.data.requestId, async () => {
    await clientSessionStorage.run(ws.data.sessionId, async () => {
      await quotaHeadersStorage.run({}, async () => {
        await routedAccountStorage.run({}, callback)
      })
    })
  })
}

async function handleResponseCreate(
  ws: ResponsesWebSocketState,
  message: Record<string, unknown>,
): Promise<void> {
  await checkRateLimit(state)

  const requestedModel = getRequestedModel(message)
  let payload = extractResponsesPayload(message)

  // Force streaming for WebSocket mode
  payload.stream = true
  const reasoningEffort = await applyResponsesWebSocketRouting(payload)

  logResponsesWebSocketRequest({
    requestedModel,
    model: payload.model,
    reasoningEffort,
  })

  const continuationResolution = resolveWebSocketContinuationPayload(
    ws,
    payload,
  )
  if (continuationResolution.shouldStop) {
    return
  }
  payload = continuationResolution.payload ?? payload
  payload.previous_response_id = undefined

  convertWebSearchTool(payload)
  expandCompactionItems(payload)

  if (isSyntheticWarmupRequest(payload)) {
    handleSyntheticWarmupRequest(ws, payload)
    return
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const supportsResponses =
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (!supportsResponses) {
    // Rewrite custom apply_patch to a function tool only for the CC
    // fallback. Native /responses must keep the freeform tool intact.
    useFunctionApplyPatch(payload)
    reportResponsesWebSocketEndpointFallback(payload.model)
    await streamChatCompletionsOverWs(ws, payload)
    return
  }

  // Native responses streaming
  const response = await createResponses(payload, { vision, initiator })

  if (!isAsyncIterable(response)) {
    // Shouldn't happen since we forced stream: true, but handle gracefully
    ws.send(JSON.stringify({ type: "response.completed", response }))
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
      payload,
      processed,
    )
    ws.send(processed)
  }
}

function resolveWebSocketContinuationPayload(
  ws: ResponsesWebSocketState,
  payload: ResponsesPayload,
): ContinuationResolutionResult {
  const previousResponseId = (payload as Record<string, unknown>)
    .previous_response_id

  if (
    previousResponseId !== undefined
    && previousResponseId !== null
    && typeof previousResponseId !== "string"
  ) {
    sendWebSocketError(ws, {
      code: "bad_request",
      message: "previous_response_id must be a string",
      status: 400,
      type: "invalid_request_error",
    })
    return { shouldStop: true }
  }

  if (previousResponseId === "") {
    sendWebSocketError(ws, {
      code: "bad_request",
      message: "previous_response_id must not be empty",
      status: 400,
      type: "invalid_request_error",
    })
    return { shouldStop: true }
  }

  if (typeof previousResponseId !== "string") {
    return { shouldStop: false }
  }

  const rehydratedPayload = rehydrateContinuationPayload(
    ws.data.responseSnapshots,
    payload,
  )
  if (rehydratedPayload) {
    return { payload: rehydratedPayload, shouldStop: false }
  }

  sendWebSocketError(ws, {
    code: "bad_request",
    message: `Unknown previous_response_id: ${previousResponseId}`,
    status: 400,
    type: "invalid_request_error",
  })
  return { shouldStop: true }
}

function getRequestedModel(
  message: Record<string, unknown>,
): string | undefined {
  const response = message.response
  if (isRecord(response) && typeof response.model === "string") {
    return response.model
  }
  return typeof message.model === "string" ? message.model : undefined
}

function logResponsesWebSocketRequest(options: {
  model: string
  reasoningEffort?: ReasoningEffort
  requestedModel?: string
}): void {
  const routing =
    options.requestedModel && options.requestedModel !== options.model ?
      `${options.requestedModel} -> ${options.model}`
    : options.model
  const effort =
    options.reasoningEffort ? ` effort=${options.reasoningEffort}` : ""
  consola.debug(`[responses-ws] response.create ${routing}${effort}`)
}

function getRedirectReasoningEffort(
  effort: NonNullable<ResponsesPayload["reasoning"]>["effort"] | undefined,
): ReasoningEffort | undefined {
  if (
    effort === "low"
    || effort === "medium"
    || effort === "high"
    || effort === "xhigh"
  ) {
    return effort
  }
  return undefined
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

function reportResponsesWebSocketEndpointFallback(model: string): void {
  reportNonDefaultBehavior({
    kind: "endpoint_fallback",
    message: `Responses WebSocket model ${model} does not support /responses; falling back to ChatCompletions`,
    data: {
      model,
      sourceEndpoint: "Responses WebSocket",
      targetEndpoint: "ChatCompletions",
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

export function extractResponsesPayload(
  message: Record<string, unknown>,
): ResponsesPayload {
  const { type: _type, response, ...topLevel } = message

  if (!isRecord(response)) {
    return topLevel as ResponsesPayload
  }

  // Some clients split fields between top-level and nested response payload.
  // Merge both so required continuation fields (e.g. previous_response_id)
  // are preserved regardless of where they're sent.
  return {
    ...topLevel,
    ...response,
  } as ResponsesPayload
}

export function isSyntheticWarmupRequest(payload: ResponsesPayload): boolean {
  return (payload as Record<string, unknown>).generate === false
}

export function rehydrateWarmupPayload(
  warmupPayload: ResponsesPayload,
  payload: ResponsesPayload,
): ResponsesPayload {
  return rehydrateContinuationPayloadFromSnapshot(warmupPayload, payload)
}

export function rehydrateContinuationPayloadFromSnapshot(
  snapshotPayload: ResponsesPayload,
  payload: ResponsesPayload,
): ResponsesPayload {
  const mergedInput = mergeContinuationInput(
    snapshotPayload.input,
    payload.input,
  )

  return {
    ...snapshotPayload,
    ...payload,
    ...(mergedInput !== undefined ? { input: mergedInput } : {}),
    previous_response_id: undefined,
    generate: undefined,
  }
}

export function rehydrateContinuationPayload(
  responseSnapshots: Map<string, ResponsesPayload>,
  payload: ResponsesPayload,
): ResponsesPayload | undefined {
  if (!payload.previous_response_id) {
    return undefined
  }

  const snapshotPayload = responseSnapshots.get(payload.previous_response_id)
  if (!snapshotPayload) {
    return undefined
  }

  return rehydrateContinuationPayloadFromSnapshot(snapshotPayload, payload)
}

function mergeContinuationInput(
  warmupInput: ResponsesPayload["input"],
  input: ResponsesPayload["input"],
): ResponsesPayload["input"] {
  if (Array.isArray(warmupInput) && Array.isArray(input)) {
    return [...warmupInput, ...input]
  }
  if (Array.isArray(warmupInput) && input === undefined) {
    return [...warmupInput]
  }
  if (Array.isArray(input)) {
    return [...input]
  }
  if (typeof input === "string") {
    return input.length > 0 ? input : warmupInput
  }
  return warmupInput
}

function handleSyntheticWarmupRequest(
  ws: ResponsesWebSocketState,
  payload: ResponsesPayload,
): void {
  const responseId = `warmup_${randomUUID().replaceAll("-", "")}`
  ws.data.responseSnapshots.set(responseId, payload)

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

  ws.send(
    JSON.stringify({
      type: "response.completed",
      sequence_number: 1,
      response: {
        ...baseResponse,
        status: "completed",
      },
    }),
  )
}

async function streamChatCompletionsOverWs(
  ws: ResponsesWebSocketState,
  payload: ResponsesPayload,
): Promise<void> {
  const ccPayload = responsesToChatCompletions(payload)
  ccPayload.stream = true
  ccPayload.stream_options = { include_usage: true }

  const response = await createChatCompletions(ccPayload)
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
    },
  }

  await streamChatCompletionsAsResponses(wsStream, ccStream, payload.model)
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

  responseSnapshots.set(
    responseId,
    createCompletedResponseSnapshot(payload, parsed),
  )
}

function createCompletedResponseSnapshot(
  payload: ResponsesPayload,
  frame: ResponseCompletedFrame,
): ResponsesPayload {
  const output = frame.response?.output
  const completedInput =
    Array.isArray(output) ?
      mergeContinuationInput(payload.input, output)
    : payload.input

  return {
    ...payload,
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
        type: options.type ?? "websocket_error",
        request_id: options.requestId ?? ws.data.requestId,
      },
    }),
  )
}

function normalizeWebSocketError(
  error: unknown,
  fallbackMessage: string,
): WebSocketErrorFrameOptions {
  if (isHTTPErrorLike(error)) {
    return {
      code: mapHttpStatusToWebSocketErrorCode(error.response.status),
      message: fallbackMessage,
      status: error.response.status,
      type: "websocket_error",
    }
  }

  return {
    code: "internal_error",
    message: fallbackMessage,
    status: 500,
    type: "websocket_error",
  }
}

function isHTTPErrorLike(error: unknown): error is { response: Response } {
  return isRecord(error) && error.response instanceof Response
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
