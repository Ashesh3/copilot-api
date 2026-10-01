import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

import { extractRequestCredential } from "~/lib/credential-resolver"
import { isHTTPError } from "~/lib/error"
import {
  getModelFallbackConfig,
  getModelFallbackConfigRevision,
  getCapturedModelFallbackConfigRevision,
  getLoadedModelFallbackConfig,
  type ModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { getModelFallbackConversationIdentity } from "~/lib/model-fallback-conversation"
import { getModelFallbackIdentity } from "~/lib/model-fallback-identity"
import {
  inspectModelFallbackResponse,
  ModelFallbackResponseError,
  type ModelFallbackReason,
} from "~/lib/model-fallback-response"
import { observeModelFallbackStream } from "~/lib/model-fallback-stream"
import {
  captureForeignThinking,
  filterForeignThinking,
  hasRetainedAssistantContent,
  mergeForeignThinking,
  type ForeignThinkingState,
} from "~/lib/model-fallback-thinking"
import {
  getLoadedModelRedirects,
  getModelRedirectRevision,
  type ModelRedirectRequest,
  type ModelRedirectResult,
  type ModelRedirectRule,
} from "~/lib/model-redirect"
import { resolveModelRedirectRules } from "~/lib/model-redirect-resolver"
import { getModelRoutingSafety } from "~/lib/model-routing-safety"
import {
  normalizeReasoningEffortForModel,
  type ReasoningEffort,
} from "~/lib/model-suffix"
import { setCopilotResponseHeader } from "~/lib/request-session"
import {
  createConversationModelsRepository,
  type ConversationModelBinding,
  type StoredConversationModel,
} from "~/lib/storage/conversation-models-repository"
import { getLoadedSettingRevision } from "~/lib/storage/domain-settings"
import { getStorageRuntime } from "~/lib/storage/runtime"

export interface ModelFallbackRequestOptions {
  headers?: Headers
  payload?: unknown
  signal?: AbortSignal
  conversationKey?: string
  credentialScope?: string
  canRetry?: () => boolean
}

interface FallbackAttempt {
  config: ModelFallbackConfig
  configRevision: number
  redirectRevision: number
  redirects: Array<ModelRedirectRule>
  routingRequest?: ModelRedirectRequest
  targetRedirect?: ModelRedirectResult
  route: StoredConversationModel["route"]
  identitySignature: string
  binding: ConversationModelBinding
  conversationModels: ReturnType<typeof createConversationModelsRepository>
  storedRoutes: ReadonlyMap<string, StoredConversationModel>
  requestSequence: number
  key?: string
  sourceModel?: string
  targetModel?: string
  retry: boolean
  resumed: boolean
  firstResponse?: Response
  accepted: boolean
  foreignThinking: ForeignThinkingState
  incomingThinking: ForeignThinkingState
  visitedModels: Set<string>
}

const attemptStorage = new AsyncLocalStorage<FallbackAttempt>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createModelFallbackCredentialScope(
  source: Headers | Request,
): string {
  const request =
    source instanceof Request ? source : (
      new Request("http://localhost/", { headers: source })
    )
  return createHash("sha256")
    .update(JSON.stringify(extractRequestCredential(request)))
    .digest("hex")
}

function recordNotice(attempt: FallbackAttempt): void {
  if (
    (!attempt.retry && !attempt.resumed)
    || !attempt.sourceModel
    || !attempt.targetModel
  )
    return
  if (attempt.config.nativeClientNotice) {
    setCopilotResponseHeader("openai-model", attempt.targetModel)
  }
  if (!attempt.config.notifyClient) return
  setCopilotResponseHeader("x-copilot-api-fallback-from", attempt.sourceModel)
  setCopilotResponseHeader("x-copilot-api-fallback-to", attempt.targetModel)
  setCopilotResponseHeader(
    "x-copilot-api-fallback-reason",
    attempt.route.at(-1)?.reason ?? "http_422",
  )
  setCopilotResponseHeader(
    "x-copilot-api-fallback-cached",
    String(attempt.resumed),
  )
}

export function getModelFallbackNotice():
  | {
      sourceModel: string
      targetModel: string
      cached: boolean
      nativeClientNotice: boolean
    }
  | undefined {
  const attempt = attemptStorage.getStore()
  return noticeForAttempt(attempt)
}

export interface ModelFallbackDebugInfo {
  reason: ModelFallbackReason
  sourceModel: string
  fromModel: string
  configuredTargetModel: string
  targetModel: string
  cached: boolean
  hop: number
}

/** Captured before dispatch, including pending and failed fallback attempts. */
export function getModelFallbackDebugInfo():
  | ModelFallbackDebugInfo
  | undefined {
  const attempt = attemptStorage.getStore()
  const hop = attempt?.route.at(-1)
  if (
    !attempt
    || (!attempt.retry && !attempt.resumed)
    || !attempt.sourceModel
    || !attempt.targetModel
    || !hop
  )
    return undefined
  return {
    reason: hop.reason ?? "http_422",
    sourceModel: attempt.sourceModel,
    fromModel: hop.source,
    configuredTargetModel: hop.target,
    targetModel: attempt.targetModel,
    cached: attempt.resumed,
    hop: attempt.route.length,
  }
}

export function captureModelFallbackNotice(): () => ReturnType<
  typeof getModelFallbackNotice
> {
  const attempt = attemptStorage.getStore()
  return () => noticeForAttempt(attempt)
}

function noticeForAttempt(
  attempt: FallbackAttempt | undefined,
): ReturnType<typeof getModelFallbackNotice> {
  if (
    !attempt?.accepted
    || (!attempt.retry && !attempt.resumed)
    || !attempt.sourceModel
    || !attempt.targetModel
  )
    return undefined
  return {
    sourceModel: attempt.sourceModel,
    targetModel: attempt.targetModel,
    cached: attempt.resumed,
    nativeClientNotice: attempt.config.nativeClientNotice,
  }
}

export function applyModelFallbackTransition(payload: unknown): void {
  const attempt = attemptStorage.getStore()
  if (attempt) captureForeignThinking(payload, attempt.incomingThinking)
  if (attempt?.retry) {
    captureForeignThinking(payload, attempt.foreignThinking)
    stripModelTransitionThinking(payload)
  } else if (attempt?.resumed)
    filterForeignThinking(payload, attempt.foreignThinking)
}

/** Called only with actual inference HTTP responses, never local errors. */
export async function recordModelFallbackResponse(
  response: Response,
  options: { endpoint?: string; signal?: AbortSignal | null } = {},
): Promise<Response> {
  const attempt = attemptStorage.getStore()
  if (!attempt || attempt.accepted) return response
  const currentModel = activeModel(attempt)
  if (currentModel)
    attempt.visitedModels.add(getModelFallbackIdentity(currentModel))
  attempt.firstResponse = response
  const outcome =
    response.ok && (attempt.targetModel || nextFallbackModel(attempt)) ?
      await inspectModelFallbackResponse(
        response,
        options.endpoint,
        options.signal,
      )
    : undefined
  // An overlapping operation must not retry after another response commits.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The awaited body read can overlap another operation in this attempt.
  if (attempt.accepted || attempt.firstResponse !== response) return response
  if (outcome?.reason && nextFallbackModel(attempt)) {
    throw new ModelFallbackResponseError(response, outcome.reason)
  }
  return await acceptModelFallbackResponse(
    attempt,
    response,
    outcome?.successful !== false,
  )
}

async function acceptModelFallbackResponse(
  attempt: FallbackAttempt,
  response: Response,
  successful: boolean,
): Promise<Response> {
  attempt.accepted = response.ok
  if (!response.ok || !attempt.targetModel) return response
  recordNotice(attempt)
  if (!successful) return response
  if (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
  )
    return observeModelFallbackStream(response, () =>
      rememberAcceptedFallback(attempt),
    )
  await rememberAcceptedFallback(attempt)
  return response
}

async function rememberAcceptedFallback(
  attempt: FallbackAttempt,
): Promise<void> {
  if (
    !attempt.targetModel
    || !attempt.sourceModel
    || !attempt.key
    || !attempt.retry
    || !attemptConfigurationIsCurrent(attempt)
  )
    return
  await attempt.conversationModels.remember({
    conversationKey: attempt.key,
    sourceModel: attempt.sourceModel,
    targetModel: attempt.targetModel,
    route: attempt.route,
    identitySignature: attempt.identitySignature,
    requestSequence: attempt.requestSequence,
    foreignThinking: attempt.foreignThinking,
    binding: attempt.binding,
  })
}

function attemptConfigurationIsCurrent(attempt: FallbackAttempt): boolean {
  return (
    attempt.configRevision === getModelFallbackConfigRevision()
    && attempt.redirectRevision === getModelRedirectRevision(true)
  )
}

/** Keep a retry-eligible upstream failure above the SSE response boundary. */
export function shouldAwaitModelFallbackBeforePreflush(): boolean {
  const attempt = attemptStorage.getStore()
  return Boolean(attempt && !attempt.accepted && nextFallbackModel(attempt))
}

export function isModelFallbackActive(): boolean {
  const attempt = attemptStorage.getStore()
  return Boolean(attempt?.targetModel && (attempt.retry || attempt.resumed))
}

/** The effective redirect metadata is consumed by protocol-specific preparation. */
export function getModelFallbackRedirect(): ModelRedirectResult | undefined {
  const attempt = attemptStorage.getStore()
  return attempt?.retry || attempt?.resumed ? attempt.targetRedirect : undefined
}

export function getModelFallbackEffort(
  fallback?: ReasoningEffort,
): ReasoningEffort | undefined {
  return getModelFallbackRedirect()?.effort ?? fallback
}

function payloadRoutingRequest(payload: {
  model: string
}): ModelRedirectRequest {
  const record = payload as Record<string, unknown>
  const reasoning = isRecord(record.reasoning) ? record.reasoning : {}
  const output = isRecord(record.output_config) ? record.output_config : {}
  const text = isRecord(record.text) ? record.text : {}
  const rawEffort = reasoning.effort ?? record.reasoning_effort ?? output.effort
  const effort =
    (
      typeof rawEffort === "string"
      && ["high", "low", "max", "medium", "minimal", "none", "xhigh"].includes(
        rawEffort,
      )
    ) ?
      (rawEffort as ReasoningEffort)
    : undefined
  const verbosity =
    (
      text.verbosity === "low"
      || text.verbosity === "medium"
      || text.verbosity === "high"
    ) ?
      text.verbosity
    : undefined
  return {
    model: payload.model,
    effort,
    verbosity,
    modelOnly: typeof rawEffort === "number",
  }
}

function stripMessageThinking(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant") return false
  let removed = false
  for (const key of [
    "reasoning_text",
    "reasoning_opaque",
    "encrypted_content",
    "reasoning_content",
  ]) {
    if (Object.hasOwn(message, key)) {
      Reflect.deleteProperty(message, key)
      removed = true
    }
  }
  if (Array.isArray(message.content)) {
    const previousLength = message.content.length
    const retained = message.content.filter(
      (block) =>
        !isRecord(block)
        || !["reasoning", "redacted_thinking", "thinking"].includes(
          String(block.type),
        ),
    )
    message.content = retained
    removed ||= previousLength !== retained.length
  }
  return removed
}

export function stripModelTransitionThinking(payload: unknown): void {
  if (!isRecord(payload)) return
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.filter(
      (message) =>
        !isRecord(message)
        || !stripMessageThinking(message)
        || hasRetainedAssistantContent(message),
    )
  }
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.filter(
      (item) => !isRecord(item) || item.type !== "reasoning",
    )
    payload.input = (payload.input as Array<unknown>).filter(
      (item) =>
        !isRecord(item)
        || !stripMessageThinking(item)
        || hasRetainedAssistantContent(item),
    )
  }
  if (Array.isArray(payload.contents)) {
    for (const content of payload.contents) {
      if (
        !isRecord(content)
        || content.role !== "model"
        || !Array.isArray(content.parts)
      )
        continue
      content.parts = content.parts.filter(
        (part) => !isRecord(part) || part.thought !== true,
      )
      for (const part of content.parts as Array<unknown>) {
        if (!isRecord(part)) continue
        Reflect.deleteProperty(part, "thoughtSignature")
        Reflect.deleteProperty(part, "thought_signature")
      }
    }
  }
}

/** Invoke after normal routing, before endpoint/account-specific preparation. */
export function applyModelFallbackToPayload<T extends { model: string }>(
  payload: T,
  routing?: Omit<ModelRedirectRequest, "model">,
): T {
  const attempt = attemptStorage.getStore()
  if (!attempt?.config.enabled) return payload
  captureForeignThinking(payload, attempt.incomingThinking)
  if (attempt.retry && attempt.targetModel) {
    payload.model = attempt.targetModel
    captureForeignThinking(payload, attempt.foreignThinking)
    stripModelTransitionThinking(payload)
    return payload
  }
  if (attempt.resumed && attempt.targetModel) {
    payload.model = attempt.targetModel
    filterForeignThinking(payload, attempt.foreignThinking)
    return payload
  }
  if (attempt.retry) return payload
  captureForeignThinking(payload, attempt.foreignThinking)
  attempt.sourceModel = payload.model
  attempt.routingRequest = {
    ...payloadRoutingRequest(payload),
    ...routing,
    model: payload.model,
  }
  const rule = attempt.config.rules.find(
    (entry) => entry.enabled && entry.sourceModel === payload.model,
  )
  attempt.targetModel = undefined
  if (!rule) return payload
  const stored = attempt.storedRoutes.get(attempt.sourceModel)
  if (!stored) return payload
  const currentRedirect = resolveStoredFallback(attempt, stored)
  // An effort change may select a different redirect. Re-evaluate the source
  // normally so the transition strips thinking from the previous target.
  if (!currentRedirect) return payload
  attempt.resumed = true
  attempt.targetModel = stored.targetModel
  attempt.targetRedirect = currentRedirect
  attempt.route = stored.route
  attempt.identitySignature = stored.identitySignature
  attempt.routingRequest = {
    model: currentRedirect.model,
    effort: normalizeReasoningEffortForModel(
      currentRedirect.model,
      currentRedirect.effort,
    ),
    verbosity: currentRedirect.verbosity,
    modelOnly: attempt.routingRequest.modelOnly,
  }
  attempt.visitedModels.add(getModelFallbackIdentity(attempt.sourceModel))
  attempt.foreignThinking = stored.foreignThinking
  payload.model = stored.targetModel
  filterForeignThinking(payload, attempt.foreignThinking)
  return payload
}

function resolveStoredFallback(
  attempt: FallbackAttempt,
  stored: StoredConversationModel,
): ModelRedirectResult | undefined {
  let request = attempt.routingRequest
  let result: ModelRedirectResult | undefined
  if (!request) return undefined
  if (stored.identitySignature !== routeIdentitySignature(stored.route))
    return undefined
  for (const hop of stored.route) {
    if (request.model !== hop.source) return undefined
    const rule = attempt.config.rules.find(
      (candidate) => candidate.enabled && candidate.sourceModel === hop.source,
    )
    if (rule?.targetModel !== hop.target) return undefined
    const redirect = resolveModelRedirectRules(attempt.redirects, {
      ...request,
      model: hop.target,
    })
    if (redirect.loop || redirect.model !== hop.resolved) return undefined
    result = redirect
    request = {
      model: redirect.model,
      effort: normalizeReasoningEffortForModel(redirect.model, redirect.effort),
      verbosity: redirect.verbosity,
      modelOnly: request.modelOnly,
    }
  }
  return result
}

function routeIdentitySignature(
  route: StoredConversationModel["route"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        route.map((hop) => [
          getModelFallbackIdentity(hop.source),
          getModelFallbackIdentity(hop.resolved),
        ]),
      ),
    )
    .digest("hex")
}

async function prepareFallbackAttempt(
  options: ModelFallbackRequestOptions,
  config: ModelFallbackConfig,
): Promise<FallbackAttempt> {
  const configRevision = getCapturedModelFallbackConfigRevision()
  const identity = getModelFallbackConversationIdentity(options)
  const credential =
    options.credentialScope
    ?? createModelFallbackCredentialScope(options.headers ?? new Headers())
  const incomingThinking = captureForeignThinking(options.payload)
  const redirects = getLoadedModelRedirects()
  const redirectRevision = getModelRedirectRevision()
  const binding: ConversationModelBinding = {
    configRevision: getLoadedSettingRevision("model_fallbacks"),
    redirectRevision: getLoadedSettingRevision("model_redirects"),
    signature: createHash("sha256")
      .update(JSON.stringify([config, redirects]))
      .digest("hex"),
  }
  const key =
    identity ?
      createHash("sha256")
        .update(JSON.stringify([credential, identity]))
        .digest("hex")
    : undefined
  const conversationModels = createConversationModelsRepository(
    getStorageRuntime().storage,
  )
  const stored = key ? await conversationModels.begin(key, binding) : undefined
  return {
    config,
    configRevision,
    redirectRevision,
    redirects,
    route: [],
    identitySignature: routeIdentitySignature([]),
    binding,
    conversationModels,
    storedRoutes: stored?.routes ?? new Map(),
    requestSequence: stored?.requestSequence ?? 0,
    key,
    retry: false,
    resumed: false,
    accepted: false,
    foreignThinking: mergeForeignThinking(incomingThinking, incomingThinking),
    incomingThinking,
    visitedModels: new Set<string>(),
  }
}

export async function runWithModelFallback<T>(
  options: ModelFallbackRequestOptions,
  execute: () => Promise<T>,
): Promise<T> {
  if (attemptStorage.getStore()) return await execute()
  await getModelFallbackConfig()
  const config = getLoadedModelFallbackConfig()
  if (!config.enabled || !getModelRoutingSafety().safe) return await execute()
  let attempt = await prepareFallbackAttempt(options, config)
  while (true) {
    try {
      return await attemptStorage.run(attempt, execute)
    } catch (error) {
      const targetRedirect = nextFallbackRedirect(attempt)
      if (
        !targetRedirect
        || !canRetryFallback(attempt, error)
        || options.canRetry?.() === false
      )
        throw error
      options.signal?.throwIfAborted()
      const route = [
        ...attempt.route,
        fallbackRouteHop(attempt, targetRedirect, error),
      ]
      attempt = {
        ...attempt,
        targetModel: targetRedirect.model,
        targetRedirect,
        route,
        identitySignature: routeIdentitySignature(route),
        routingRequest: {
          model: targetRedirect.model,
          effort: normalizeReasoningEffortForModel(
            targetRedirect.model,
            targetRedirect.effort,
          ),
          verbosity: targetRedirect.verbosity,
          modelOnly: attempt.routingRequest?.modelOnly,
        },
        retry: true,
        resumed: false,
        firstResponse: undefined,
        accepted: false,
        foreignThinking: mergeForeignThinking(
          attempt.foreignThinking,
          attempt.incomingThinking,
        ),
      }
    }
  }
}

function activeModel(attempt: FallbackAttempt): string | undefined {
  return attempt.retry || attempt.resumed ?
      attempt.targetModel
    : attempt.sourceModel
}

function fallbackRouteHop(
  attempt: FallbackAttempt,
  redirect: ModelRedirectResult,
  error: unknown,
): StoredConversationModel["route"][number] {
  return {
    source: activeModel(attempt) ?? "",
    target: redirect.originalModel ?? redirect.model,
    resolved: redirect.model,
    ...(error instanceof ModelFallbackResponseError ?
      { reason: error.reason }
    : {}),
  }
}

function nextFallbackModel(attempt: FallbackAttempt): string | undefined {
  return nextFallbackRedirect(attempt)?.model
}

function nextFallbackRedirect(
  attempt: FallbackAttempt,
): ModelRedirectResult | undefined {
  const currentModel = activeModel(attempt)
  if (!currentModel) return undefined
  const rule = attempt.config.rules.find(
    (entry) => entry.enabled && entry.sourceModel === currentModel,
  )
  if (!rule) return undefined
  const redirect = resolveModelRedirectRules(attempt.redirects, {
    ...attempt.routingRequest,
    model: rule.targetModel,
  })
  if (
    redirect.loop
    || attempt.visitedModels.has(getModelFallbackIdentity(redirect.model))
    || getModelFallbackIdentity(redirect.model)
      === getModelFallbackIdentity(currentModel)
  )
    return undefined
  return redirect
}

function canRetryFallback(attempt: FallbackAttempt, error: unknown): boolean {
  return (
    !attempt.accepted
    && ((error instanceof ModelFallbackResponseError
      && error.response === attempt.firstResponse)
      || (attempt.firstResponse?.status === 422
        && isHTTPError(error)
        && error.response === attempt.firstResponse))
  )
}
