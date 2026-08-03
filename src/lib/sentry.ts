import type { BunOptions } from "@sentry/bun"
import type { Client, SpanAttributes } from "@sentry/core"
import type { Context } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"
import { createHash } from "node:crypto"

import { getModelSettings } from "~/lib/model-settings"
import { getClientSessionId, getRequestId } from "~/lib/request-session"

import packageJson from "../../package.json" with { type: "json" }

/**
 * Check whether AI request/response content (prompts and completions)
 * should be recorded in Sentry spans.
 *
 * Controlled by `SENTRY_AI_RECORD_INPUTS` env var (default: "true").
 * Set to "false" to prevent `gen_ai.input.messages` and
 * `gen_ai.output.messages` from being sent to Sentry.
 */
export function shouldRecordAiContent(): boolean {
  const value = process.env.SENTRY_AI_RECORD_INPUTS
  if (value === undefined || value === "") return true
  return value.toLowerCase() !== "false"
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

function isHeaderTuple(entry: unknown): entry is HeaderTuple {
  return Array.isArray(entry) && typeof entry[0] === "string"
}

function scrubSensitiveData<T>(event: T): T {
  if (isRecord(event)) {
    scrubRequestHeaders(event as Sentry.Event)
    scrubStatsigClientKeyData(event)
  }

  return event
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
      ...(shouldRecordAiContent()
        && options.inputMessages !== undefined && {
          "gen_ai.input.messages": getSentryInputMessages(
            options.inputMessages,
          ),
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
      ...(shouldRecordAiContent() && {
        ...(options.toolArguments !== undefined && {
          "gen_ai.tool.call.arguments": stringifySentryContent(
            options.toolArguments,
          ),
        }),
        ...(options.toolResult !== undefined && {
          "gen_ai.tool.call.result": stringifySentryContent(
            options.toolResult,
          ).slice(0, 10000),
        }),
      }),
      ...(options.isError && { "gen_ai.tool.error": "true" }),
    },
  }
}

function getSentryInputMessages(messages: unknown): string {
  return typeof messages === "string" ? messages : JSON.stringify(messages)
}

function stringifySentryContent(content: unknown): string {
  if (typeof content === "string") return content
  return JSON.stringify(content ?? "")
}

export function createSentryOutputMessages(content: unknown): string {
  return JSON.stringify([
    {
      role: "assistant",
      parts: [
        {
          type: "text",
          content: stringifySentryContent(content),
        },
      ],
    },
  ])
}

export function setSentryOutputMessages(
  span: Sentry.Span,
  content: unknown,
): void {
  if (!shouldRecordAiContent()) return
  span.setAttribute(
    "gen_ai.output.messages",
    createSentryOutputMessages(content),
  )
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
  const recordAiContent = shouldRecordAiContent()
  const tracesSampleRate = Number.parseFloat(
    process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1.0",
  )

  return {
    dsn,
    release: `copilot-api@${packageJson.version}`,
    environment: process.env.NODE_ENV ?? "development",
    sendDefaultPii: recordAiContent,
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
  const conversationId =
    getSentryConversationIdFromPayload(payload)
    ?? getSentryConversationIdFromHeaders(c.req.raw.headers)
    ?? getClientSessionId()
    ?? getRequestId()

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
