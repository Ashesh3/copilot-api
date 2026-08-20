import type { BunOptions } from "@sentry/bun"
import type { Client, SpanAttributes } from "@sentry/core"
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { createHash } from "node:crypto"

import { getModelSettings } from "~/lib/model-settings"
import {
  isGoogleModelActionRequest,
  sanitizeRequestDiagnosticReference,
  sanitizeSensitiveDiagnosticQuery,
} from "~/lib/request-diagnostics"
import { getRequestId } from "~/lib/request-session"
import { getRoutingAffinity } from "~/lib/routing-affinity"

import packageJson from "../../package.json" with { type: "json" }

/**
 * Ordinary Sentry telemetry never records AI request/response bodies. Raw
 * capture is restricted to the administrator-only LLM Debug facility.
 */
export function shouldRecordAiContent(): boolean {
  return false
}

const SENSITIVE_HEADER_PATTERNS = [
  "authorization",
  "api-key",
  "cookie",
  "x-api-key",
]
export const SENTRY_CONVERSATION_ID_HEADERS = [
  "x-sentry-conversation-id",
  "x-conversation-id",
  "x-thread-id",
  "x-session-id",
  "x-claude-code-session-id",
] as const
const ROUTING_AFFINITY_HEADER_NAMES = new Set([
  ...SENTRY_CONVERSATION_ID_HEADERS,
  "session-id",
  "thread-id",
  "x-client-session-id",
])
const FILTERED_VALUE = "[Filtered]"
const STATSIG_PROXY_HOST = "ab.chatgpt.com"
const STATSIG_CLIENT_KEY_RE = /(^|[?&])k=[^&#\s"'<>]*/g
const GOOGLE_PRIVATE_MODEL_ACTION_REFERENCE =
  /\/(?:v1beta\/models|v1\/models|models)\/([^/?#\s"'<>]+)/gi

type HeaderTuple = [string, unknown]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isSensitiveHeader(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    ROUTING_AFFINITY_HEADER_NAMES.has(lower)
    || SENSITIVE_HEADER_PATTERNS.some((pattern) => lower.includes(pattern))
  )
}

function isRoutingAffinityHeader(key: string): boolean {
  return ROUTING_AFFINITY_HEADER_NAMES.has(key.toLowerCase())
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

const STATSIG_HOST_REFERENCE_RE = new RegExp(
  String.raw`(^|[^a-z0-9.-])${escapeRegExp(STATSIG_PROXY_HOST)}(?::\d+)?(?=$|[/?#\s"'<>])`,
  "i",
)

function containsStatsigHost(value: string): boolean {
  return STATSIG_HOST_REFERENCE_RE.test(value)
}

function hasDirectStatsigHostString(value: unknown): boolean {
  if (!isRecord(value)) return false

  return Object.values(value).some(
    (entry) => typeof entry === "string" && containsStatsigHost(entry),
  )
}

function objectCreatesLocalStatsigContext(
  value: Record<string, unknown>,
): boolean {
  return (
    Object.values(value).some(
      (entry) => typeof entry === "string" && containsStatsigHost(entry),
    ) || hasDirectStatsigHostString(value.server)
  )
}

function scrubStatsigClientKeyString(
  value: string,
  inheritedStatsigContext: boolean,
): string {
  const isStatsigContext = inheritedStatsigContext || containsStatsigHost(value)
  if (!isStatsigContext) return value

  return value.replaceAll(
    STATSIG_CLIENT_KEY_RE,
    (_match, prefix: string) => `${prefix}k=${FILTERED_VALUE}`,
  )
}

export function scrubStatsigClientKeyData(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  inheritedStatsigContext = false,
): void {
  if (!isRecord(value)) return
  if (seen.has(value)) return

  seen.add(value)

  if (Array.isArray(value)) {
    const arrayValue = value as Array<unknown>
    for (let index = 0; index < arrayValue.length; index += 1) {
      const entry = arrayValue[index]
      if (typeof entry === "string") {
        arrayValue[index] = scrubStatsigClientKeyString(
          entry,
          inheritedStatsigContext,
        )
        continue
      }

      scrubStatsigClientKeyData(entry, seen, inheritedStatsigContext)
    }
    return
  }

  const localStatsigContext =
    inheritedStatsigContext || objectCreatesLocalStatsigContext(value)

  for (const [key, nestedValue] of Object.entries(value)) {
    if (isRoutingAffinityHeader(key)) {
      value[key] = FILTERED_VALUE
      continue
    }
    if (typeof nestedValue === "string") {
      value[key] = scrubStatsigClientKeyString(nestedValue, localStatsigContext)
      continue
    }

    scrubStatsigClientKeyData(nestedValue, seen, localStatsigContext)
  }
}

function scrubRequestHeaders(event: Sentry.Event): void {
  const request = event.request as { headers?: unknown } | undefined
  if (!request) return

  const { headers } = request
  if (!headers) return

  if (Array.isArray(headers)) {
    const scrubbedHeaders: Array<unknown> = []
    for (const entry of headers) {
      if (!isHeaderTuple(entry)) {
        scrubbedHeaders.push(entry)
        continue
      }

      scrubbedHeaders.push(
        isSensitiveHeader(entry[0]) ? [entry[0], FILTERED_VALUE] : entry,
      )
    }
    request.headers = scrubbedHeaders
    return
  }

  if (typeof headers !== "object") return

  const scrubbed: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    scrubbed[key] = isSensitiveHeader(key) ? FILTERED_VALUE : String(value)
  }
  request.headers = scrubbed
}

interface GoogleRouteScrubContext {
  method: string
  privateRouteValues: ReadonlySet<string>
  seen: WeakSet<object>
}

function sanitizeGoogleRouteString(
  key: string,
  value: string,
  context: GoogleRouteScrubContext,
): string {
  if (context.privateRouteValues.has(value)) return FILTERED_VALUE
  const sanitized = sanitizeRequestDiagnosticReference(context.method, value)
  return key === "url.query" || key === "query" ?
      sanitizeSensitiveDiagnosticQuery(sanitized)
    : sanitized
}

function scrubGoogleRouteData(
  value: unknown,
  context: GoogleRouteScrubContext,
): void {
  if (!isRecord(value) || context.seen.has(value)) return
  context.seen.add(value)

  if (Array.isArray(value)) {
    const arrayValue = value as Array<unknown>
    for (let index = 0; index < arrayValue.length; index += 1) {
      const entry: unknown = arrayValue[index]
      if (typeof entry === "string") {
        arrayValue[index] = sanitizeGoogleRouteString("", entry, context)
      } else {
        scrubGoogleRouteData(entry, context)
      }
    }
    return
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (typeof nestedValue === "string") {
      value[key] = sanitizeGoogleRouteString(key, nestedValue, context)
    } else {
      scrubGoogleRouteData(nestedValue, context)
    }
  }
}

function addGoogleRouteValueParts(
  values: Set<string>,
  match: RegExpMatchArray,
): void {
  values.add(match[1])
  const separator = match[1].lastIndexOf(":")
  if (separator === -1) return
  values.add(match[1].slice(0, separator))
  values.add(match[1].slice(separator + 1))
}

function findGoogleRouteValues(
  value: unknown,
  method: string,
  seen: WeakSet<object> = new WeakSet<object>(),
): Set<string> {
  const values = new Set<string>()
  if (!isRecord(value) || seen.has(value)) return values
  seen.add(value)

  for (const entry of Object.values(value)) {
    if (typeof entry === "string") {
      const matches = entry.matchAll(GOOGLE_PRIVATE_MODEL_ACTION_REFERENCE)
      for (const match of matches) {
        if (sanitizeRequestDiagnosticReference(method, match[0]) === match[0])
          continue
        addGoogleRouteValueParts(values, match)
      }
      continue
    }
    for (const nested of findGoogleRouteValues(entry, method, seen)) {
      values.add(nested)
    }
  }
  return values
}

function findGoogleRequestMethod(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): string | undefined {
  if (!isRecord(value) || seen.has(value)) return undefined
  seen.add(value)

  if (Array.isArray(value)) {
    for (const entry of value) {
      const method = findGoogleRequestMethod(entry, seen)
      if (method) return method
    }
    return undefined
  }

  const directMethod = [
    value.method,
    value["http.method"],
    value["http.request.method"],
  ].find((entry): entry is string => typeof entry === "string")
  if (
    directMethod
    && Object.values(value).some(
      (entry) =>
        typeof entry === "string"
        && sanitizeRequestDiagnosticReference(directMethod, entry) !== entry,
    )
  ) {
    return directMethod
  }

  for (const entry of Object.values(value)) {
    if (typeof entry === "string") {
      const separator = entry.indexOf(" ")
      if (separator > 0) {
        const method = entry.slice(0, separator)
        const reference = entry.slice(separator + 1)
        if (
          /^[A-Z]+$/i.test(method)
          && sanitizeRequestDiagnosticReference(method, reference) !== reference
        ) {
          return method
        }
      }
      continue
    }
    const method = findGoogleRequestMethod(entry, seen)
    if (method) return method
  }
  return undefined
}

function isHeaderTuple(entry: unknown): entry is HeaderTuple {
  return Array.isArray(entry) && typeof entry[0] === "string"
}

function scrubSensitiveData<T>(event: T): T {
  if (isRecord(event)) {
    scrubRequestHeaders(event as Sentry.Event)
    scrubStatsigClientKeyData(event)
    const googleRequestMethod = findGoogleRequestMethod(event)
    if (googleRequestMethod) {
      scrubGoogleRouteData(event, {
        method: googleRequestMethod,
        privateRouteValues: findGoogleRouteValues(event, googleRequestMethod),
        seen: new WeakSet<object>(),
      })
    }
  }

  return event
}

interface SentryRequestDiagnostics {
  method: string
  path: string
  url: string
}

export function applySentryRequestDiagnosticsToScope(
  scope: Sentry.Scope,
  request: SentryRequestDiagnostics,
): void {
  if (!isGoogleModelActionRequest(request.method, request.path)) return

  const path = sanitizeRequestDiagnosticReference(
    request.method,
    request.path,
  ).split(/[?#]/, 1)[0]
  const url = sanitizeRequestDiagnosticReference(request.method, request.url)
  const currentRequest =
    scope.getScopeData().sdkProcessingMetadata.normalizedRequest

  scope.setTransactionName(`${request.method} ${path}`)
  scope.setSDKProcessingMetadata({
    normalizedRequest: {
      ...currentRequest,
      method: request.method,
      url,
    },
  })
}

export function applySentryRequestDiagnostics(
  request: SentryRequestDiagnostics,
): void {
  const isolationScope = Sentry.getIsolationScope()
  applySentryRequestDiagnosticsToScope(isolationScope, request)

  const currentScope = Sentry.getCurrentScope()
  if (currentScope !== isolationScope) {
    applySentryRequestDiagnosticsToScope(currentScope, request)
  }
}

function sentryAiSpanDefaultsIntegration() {
  return {
    name: "CopilotApiAiSpanDefaults",
    setup(client: Client) {
      client.on("spanStart", (span) => {
        const { data = {}, description, op } = Sentry.spanToJSON(span)
        const operationName = getGenAiOperationName(op, description, data)

        if (operationName && data["gen_ai.operation.name"] === undefined) {
          span.setAttribute("gen_ai.operation.name", operationName)
        }
        if (operationName && data["gen_ai.agent.name"] === undefined) {
          span.setAttribute("gen_ai.agent.name", SENTRY_AGENT_NAME)
        }

        const conversationId =
          Sentry.getCurrentScope().getScopeData().conversationId
          ?? Sentry.getIsolationScope().getScopeData().conversationId
        if (!conversationId) return

        const hasAiOperationId = data["ai.operationId"] !== undefined
        if (
          !op?.startsWith("gen_ai.")
          && !hasAiOperationId
          && !description?.startsWith("ai.")
        ) {
          return
        }

        span.setAttribute("gen_ai.conversation.id", conversationId)
      })
    },
  }
}

const SENTRY_AGENT_NAME = "copilot-proxy"

function getGenAiOperationName(
  op: string | undefined,
  description: string | undefined,
  attributes: SpanAttributes,
): string | undefined {
  if (op?.startsWith("gen_ai.")) return op.slice("gen_ai.".length)
  if (attributes["ai.operationId"] !== undefined) {
    return description?.startsWith("ai.") ? description.slice(3) : undefined
  }
  return undefined
}

export function createSentryInvokeAgentSpanOptions(
  model: string,
  conversationId?: string,
): { attributes: SpanAttributes; name: string; op: string } {
  return {
    op: "gen_ai.invoke_agent",
    name: `invoke_agent ${SENTRY_AGENT_NAME}`,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": SENTRY_AGENT_NAME,
      "gen_ai.request.model": getSentryModelName(model),
      ...(conversationId && {
        "gen_ai.conversation.id": conversationId,
      }),
    },
  }
}

export function createSentryChatSpanOptions(options: {
  inputMessages?: unknown
  model: string
  streaming?: boolean
}): { attributes: SpanAttributes; name: string; op: string } {
  const model = getSentryModelName(options.model)
  return {
    op: "gen_ai.chat",
    name: `chat ${model}`,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": SENTRY_AGENT_NAME,
      "gen_ai.request.model": model,
      "gen_ai.response.model": model,
      ...(options.streaming && {
        "gen_ai.response.streaming": true,
      }),
    },
  }
}

export function createSentryToolSpanOptions(options: {
  isError?: boolean
  toolArguments?: unknown
  toolName: string
  toolResult?: unknown
  toolType?: string
}): { attributes: SpanAttributes; name: string; op: string } {
  return {
    op: "gen_ai.execute_tool",
    name: `execute_tool ${options.toolName}`,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": options.toolName,
      "gen_ai.tool.type": options.toolType ?? "function",
      ...(options.isError && { "gen_ai.tool.error": "true" }),
    },
  }
}

export function setSentryOutputMessages(
  _span: Sentry.Span,
  _content: unknown,
): void {
  // Intentionally empty: ordinary Sentry spans retain only structural data.
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return

  Sentry.init(createSentryInitOptions(dsn))

  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason)
  })

  // Pipe consola logs to Sentry
  consola.addReporter(Sentry.createConsolaReporter())

  consola.info("Sentry initialized")
}

export type CopilotApiSentryInitOptions = BunOptions

export function createSentryInitOptions(
  dsn: string,
): CopilotApiSentryInitOptions {
  const tracesSampleRate = Number.parseFloat(
    process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1.0",
  )

  return {
    dsn,
    release: `copilot-api@${packageJson.version}`,
    environment: process.env.NODE_ENV ?? "development",
    sendDefaultPii: false,
    streamGenAiSpans: true,
    tracesSampleRate:
      Number.isFinite(tracesSampleRate) ? tracesSampleRate : 1.0,
    enableLogs: true,
    integrations: [
      sentryAiSpanDefaultsIntegration(),
      Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
    ],
    beforeSend(event) {
      return scrubSensitiveData(event)
    },
    beforeSendTransaction(event) {
      return scrubSensitiveData(event)
    },
    beforeSendSpan(span) {
      return scrubSensitiveData(span)
    },
    beforeSendLog(log) {
      return scrubSensitiveData(log)
    },
  }
}

const CONVERSATION_ID_PAYLOAD_KEYS = [
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
  "session_id",
  "sessionId",
  "prompt_cache_key",
]

const CONVERSATION_ID_METADATA_KEYS = [
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
  "session_id",
  "sessionId",
]

function normalizeConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getFirstStringValue(
  source: Record<string, unknown>,
  keys: Array<string>,
): string | undefined {
  for (const key of keys) {
    const value = normalizeConversationId(source[key])
    if (value) return value
  }

  return undefined
}

function getConversationIdFromUserId(userId: unknown): string | undefined {
  if (typeof userId !== "string" || userId.length === 0) return undefined

  try {
    const parsed = JSON.parse(userId) as unknown
    if (isRecord(parsed)) {
      const sessionId = normalizeConversationId(parsed.session_id)
      if (sessionId) return sessionId
    }
  } catch {
    // Fall through to the legacy Claude Code string format.
  }

  const sessionMatch = userId.match(/_session_(.+)$/)
  return normalizeConversationId(sessionMatch?.[1])
}

function getConversationIdFromMetadata(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined

  return (
    getFirstStringValue(metadata, CONVERSATION_ID_METADATA_KEYS)
    ?? getConversationIdFromUserId(metadata.user_id)
  )
}

export function getSentryConversationIdFromPayload(
  payload: unknown,
): string | undefined {
  if (!isRecord(payload)) return undefined

  return (
    getFirstStringValue(payload, CONVERSATION_ID_PAYLOAD_KEYS)
    ?? getConversationIdFromMetadata(payload.metadata)
  )
}

export function getSentryConversationIdFromHeaders(
  headers: Headers,
): string | undefined {
  for (const header of SENTRY_CONVERSATION_ID_HEADERS) {
    const value = normalizeConversationId(headers.get(header))
    if (value) return value
  }

  return undefined
}

export function pseudonymizeSentryConversationId(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

export function setSentryConversationIdFromRequest(
  c: Context,
  payload?: unknown,
): string | undefined {
  const routingAffinityKey = getRoutingAffinity()?.key
  const payloadConversationId = getSentryConversationIdFromPayload(payload)
  const headerConversationId = getSentryConversationIdFromHeaders(
    c.req.raw.headers,
  )
  const conversationId =
    routingAffinityKey && (payloadConversationId || headerConversationId) ?
      undefined
    : (payloadConversationId ?? headerConversationId ?? getRequestId())

  if (!conversationId) return undefined

  const pseudonymousConversationId =
    pseudonymizeSentryConversationId(conversationId)
  Sentry.setConversationId(pseudonymousConversationId)
  return pseudonymousConversationId
}

/**
 * Map copilot-api model names to canonical model IDs recognized by
 * Sentry's cost calculation (via models.dev / OpenRouter).
 */
const SENTRY_MODEL_MAP: Record<string, string> = {
  // Claude models (copilot uses dots, models.dev uses hyphens)
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4.6-1m": "claude-opus-4-6",
  "claude-opus-4.6-fast": "claude-opus-4-6",
  "claude-opus-4.5": "claude-opus-4-5",
  "claude-opus-4": "claude-opus-4-0",
  "claude-opus-4.1": "claude-opus-4-1",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-sonnet-4": "claude-sonnet-4-0",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-3.5": "claude-3-5-haiku-20241022",
  // GPT models
  "gpt-4.1": "gpt-4.1-2025-04-14",
  "gpt-4.1-mini": "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano": "gpt-4.1-nano-2025-04-14",
  "gpt-4o": "gpt-4o-2024-08-06",
  "gpt-4o-mini": "gpt-4o-mini-2024-07-18",
  // o-series
  o3: "o3-2025-04-16",
  "o3-mini": "o3-mini-2025-01-31",
  "o4-mini": "o4-mini-2025-04-16",
}

const REASONING_SUFFIXES = new Set(["low", "medium", "high", "xhigh", "max"])

export function getSentryModelName(model: string): string {
  const configuredName = getModelSettings(model)?.sentryModelName
  if (configuredName) return configuredName

  const baseModel = getModelWithoutReasoningSuffix(model)
  const configuredBaseName = getModelSettings(baseModel)?.sentryModelName
  if (configuredBaseName) return configuredBaseName

  if (Object.hasOwn(SENTRY_MODEL_MAP, baseModel)) {
    return SENTRY_MODEL_MAP[baseModel]
  }

  return SENTRY_MODEL_MAP[model] ?? model
}

function getModelWithoutReasoningSuffix(model: string): string {
  const colonIndex = model.lastIndexOf(":")
  if (colonIndex === -1) return model

  const suffix = model.slice(colonIndex + 1)
  return REASONING_SUFFIXES.has(suffix) ? model.slice(0, colonIndex) : model
}

export function setupSentryShutdown(): void {
  process.on("SIGTERM", async () => {
    await Sentry.close(2000)
    process.exit(0)
  })
}
