import * as Sentry from "@sentry/bun"
import consola from "consola"
import { randomUUID } from "node:crypto"

import {
  clearQuotaHeaders,
  getRequestId,
  setQuotaHeader,
} from "~/lib/request-session"
import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"
import { getCopilotToken } from "~/services/github/get-copilot-token"

// --- Constants ---

export const API_VERSION = "2026-01-09"
// Intentionally reuse the VS Code chat integration bucket unless a separate
// Copilot rate-limit bucket is explicitly needed for this proxy.
export const INTEGRATION_ID = "vscode-chat"
export const MAX_RETRIES = 1
export const BASE_DELAY_SECONDS = 5
export const BACKOFF_FACTOR = 2
export const INITIAL_RETRY_BACKOFF_EXTRA_SECONDS = 1
export const MAX_DELAY_SECONDS = 180
export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

// --- Base URL ---

export function copilotBaseUrl(): string {
  return state.accountType === "individual" ?
      "https://api.githubcopilot.com"
    : `https://api.${state.accountType}.githubcopilot.com`
}

// --- Headers ---

export interface CopilotHeaderOptions {
  vision?: boolean
  initiator?: "agent" | "user"
  copilotToken?: string
}

export function copilotHeaders(
  options?: CopilotHeaderOptions,
): Record<string, string> {
  const token = options?.copilotToken ?? state.copilotToken
  if (!token) {
    throw new Error("Copilot token is not set. Cannot build request headers.")
  }

  const initiator = options?.initiator ?? "user"

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "copilot-api",
    "Copilot-Integration-Id": INTEGRATION_ID,
    "editor-version": `vscode/${state.vsCodeVersion ?? "1.104.3"}`,
    "Openai-Intent": "conversation-agent",
    "X-GitHub-Api-Version": API_VERSION,
    "X-Initiator": initiator,
    "X-Request-Id": getRequestId() ?? randomUUID(),
    "X-Interaction-Id": state.sessionId,
    "X-Client-Session-Id": state.sessionId,
    "X-Agent-Task-Id": state.sessionId,
    "X-Interaction-Type":
      initiator === "user" ? "conversation-user" : "conversation-agent",
  }

  if (options?.vision) {
    headers["Copilot-Vision-Request"] = "true"
  }

  return headers
}

// --- Quota Headers ---

export interface QuotaParams {
  [key: string]: string
}

export function parseQuotaHeaders(
  response: Response,
): Record<string, QuotaParams> | undefined {
  const quotaPrefix = "x-quota-snapshot-"
  const result: Record<string, QuotaParams> = {}
  let found = false

  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.startsWith(quotaPrefix)) {
      found = true
      const quotaType = lowerKey.slice(quotaPrefix.length)
      const params: QuotaParams = {}
      for (const part of value.split(/[;&]/)) {
        const trimmed = part.trim()
        const eqIndex = trimmed.indexOf("=")
        if (eqIndex !== -1) {
          params[trimmed.slice(0, eqIndex).trim()] = trimmed
            .slice(eqIndex + 1)
            .trim()
        }
      }
      result[quotaType] = params
    }
  }

  return found ? result : undefined
}

function captureQuotaHeaders(response: Response): void {
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase().startsWith("x-quota-snapshot-")) {
      setQuotaHeader(key, value)
    }
  }
}

// --- Deterministic 400 Detection ---

/**
 * Check if a 400 response body indicates a deterministic (non-transient) error.
 * These should not be retried as they will fail the same way every time.
 */
export function isDeterministic400(body: string): boolean {
  const patterns = [
    "Invalid signature",
    "Invalid `signature`",
    "model_not_supported",
    "model is not supported",
    "messages must be non-empty",
    "invalid_request_body",
    "invalid_type",
    "invalid_value",
    "unexpected_field",
    "unknown_field",
    "not_supported",
    "unrecognized_field",
  ]
  if (patterns.some((pattern) => body.includes(pattern))) return true

  // Copilot's generic "Bad Request\n" response indicates a payload structure issue
  // (e.g. null max_tokens) that won't resolve on retry
  if (body.trim() === "Bad Request") return true

  return false
}

async function isDeterministic400Response(
  response: Response,
): Promise<boolean> {
  const body = await response.clone().text()
  if (!isDeterministic400(body)) return false
  consola.warn(`Deterministic HTTP 400, skipping retry: ${body.slice(0, 200)}`)
  return true
}

// --- Retryable Error Detection ---

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()
  const causeMessage =
    error.cause instanceof Error ? error.cause.message.toLowerCase() : ""

  if (
    error.name === "AbortError"
    || message.includes("aborted")
    || causeMessage.includes("aborted")
  ) {
    return false
  }

  const retryablePatterns = [
    "fetch failed",
    "connection reset",
    "econnreset",
    "socket hang up",
    "etimedout",
    "econnrefused",
    "network error",
    "aborted",
    "timeout",
    "terminated",
    "goaway",
    "other side closed",
  ]

  return retryablePatterns.some(
    (pattern) => message.includes(pattern) || causeMessage.includes(pattern),
  )
}

// --- Header Normalization ---

function toHeaderRecord(
  headersInit: RequestInit["headers"],
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!headersInit) return headers

  if (headersInit instanceof Headers) {
    for (const [key, value] of headersInit.entries()) {
      headers[key] = value
    }
    return headers
  }

  if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      headers[key] = value
    }
    return headers
  }

  for (const [key, value] of Object.entries(headersInit)) {
    if (typeof value === "string") {
      headers[key] = value
    }
  }
  return headers
}

function setAuthorizationHeader(
  headers: Record<string, string>,
  token: string,
): Record<string, string> {
  const value = `Bearer ${token}`
  const nextHeaders = { ...headers, Authorization: value }

  if ("authorization" in nextHeaders) {
    nextHeaders.authorization = value
  }

  return nextHeaders
}

// --- Retry Delay Calculation ---

function parseRetryAfterSeconds(
  retryAfterHeader: string | null,
): number | null {
  if (!retryAfterHeader) return null

  const parsedNumber = Number(retryAfterHeader)
  if (!Number.isNaN(parsedNumber)) {
    return Math.max(0, parsedNumber)
  }

  const parsedDate = Date.parse(retryAfterHeader)
  if (Number.isNaN(parsedDate)) {
    return null
  }

  const seconds = Math.ceil((parsedDate - Date.now()) / 1000)
  return Math.max(0, seconds)
}

function calculateHttpRetryDelay(
  retryAfterHeader: string | null,
  retryBackoffExtraSeconds: number,
): number {
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader)
  const baseDelay = retryAfterSeconds ?? BASE_DELAY_SECONDS
  return Math.min(baseDelay + retryBackoffExtraSeconds, MAX_DELAY_SECONDS)
}

function calculateNetworkRetryDelay(attempt: number): number {
  const exponentialDelay = BASE_DELAY_SECONDS * BACKOFF_FACTOR ** attempt
  return Math.min(exponentialDelay, MAX_DELAY_SECONDS)
}

function applyRetryJitter(delaySeconds: number): number {
  const jitterMultiplier = 0.8 + Math.random() * 0.4
  return Math.min(delaySeconds * jitterMultiplier, MAX_DELAY_SECONDS)
}

// --- Fetch with Retry ---

export async function copilotFetch(
  path: string,
  init?: RequestInit,
  fetchOptions?: { baseUrl?: string },
): Promise<Response> {
  const url = `${fetchOptions?.baseUrl ?? copilotBaseUrl()}${path}`
  const maxAttempts = MAX_RETRIES + 1
  let retryBackoffExtraSeconds = INITIAL_RETRY_BACKOFF_EXTRA_SECONDS

  let lastError: Error | undefined
  let lastResponse: Response | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const headers = toHeaderRecord(init?.headers)
      clearQuotaHeaders()

      const response = await fetch(url, {
        ...init,
        headers,
      })

      // Log quota headers
      const quota = parseQuotaHeaders(response)
      if (quota) {
        consola.debug("Copilot quota snapshot:", quota)
      }
      captureQuotaHeaders(response)

      if (
        response.status === 401
        && !state.isMultiToken
        && state.githubToken
        && attempt < maxAttempts - 1
      ) {
        consola.warn(`HTTP 401 on ${path}, refreshing Copilot token`)
        const tokenData = await getCopilotToken()
        state.copilotToken = tokenData.token
        init = {
          ...init,
          headers: setAuthorizationHeader(headers, tokenData.token),
        }
        continue
      }

      if (response.status === 400) {
        await isDeterministic400Response(response)
        return response
      }

      // Check for retryable HTTP status codes
      if (
        RETRYABLE_STATUSES.has(response.status)
        && attempt < maxAttempts - 1
      ) {
        lastResponse = response
        const rawDelaySeconds = calculateHttpRetryDelay(
          response.headers.get("retry-after"),
          retryBackoffExtraSeconds,
        )
        retryBackoffExtraSeconds *= BACKOFF_FACTOR
        const delaySeconds = applyRetryJitter(rawDelaySeconds)
        consola.warn(
          `HTTP ${response.status} on ${path} (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delaySeconds.toFixed(1)}s`,
        )
        Sentry.addBreadcrumb({
          category: "copilot",
          message: `HTTP ${response.status} on ${path} (attempt ${attempt + 1}/${maxAttempts})`,
          level: "warning",
          data: {
            status: response.status,
            delay: delaySeconds,
            rawDelay: rawDelaySeconds,
          },
        })
        await sleep(delaySeconds * 1000)
        continue
      }

      return response
    } catch (error) {
      lastError = error as Error

      if (!isRetryableError(error) || attempt === maxAttempts - 1) {
        throw error
      }

      const delaySeconds = calculateNetworkRetryDelay(attempt)
      consola.warn(
        `Fetch failed on ${path} (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delaySeconds}s:`,
        lastError.message,
      )
      Sentry.addBreadcrumb({
        category: "copilot",
        message: `Fetch error on ${path} (attempt ${attempt + 1}/${maxAttempts})`,
        level: "warning",
        data: { error: lastError.message, delay: delaySeconds },
      })
      await sleep(delaySeconds * 1000)
    }
  }

  if (lastResponse) {
    return lastResponse
  }

  throw lastError ?? new Error("Request failed without a captured error")
}

// --- Message Types ---

interface ContentPart {
  type: string
}

// --- Helper Functions ---

export function hasVisionContent(
  messages: ReadonlyArray<{
    content?: string | ReadonlyArray<ContentPart> | null
  }>,
): boolean {
  const imageTypes = new Set(["image_url", "image", "input_image"])

  for (const message of messages) {
    if (Array.isArray(message.content)) {
      const parts = message.content as ReadonlyArray<ContentPart>
      for (const part of parts) {
        if (imageTypes.has(part.type)) {
          return true
        }
      }
    }
  }

  return false
}

export function detectInitiator(
  messages: ReadonlyArray<{ role: string }>,
  override?: "agent" | "user",
): "agent" | "user" {
  if (override) return override

  if (messages.length === 0) return "user"

  const lastMessage = messages.at(-1)
  if (
    lastMessage
    && (lastMessage.role === "assistant" || lastMessage.role === "tool")
  ) {
    return "agent"
  }

  return "user"
}

export function addPromptCaching(
  messages: Array<{
    role: string
    content?: string | Array<unknown> | null
    tool_calls?: Array<unknown>
    reasoning_text?: string | null
    reasoning_opaque?: string | null
    encrypted_content?: string | null
  }>,
  tools?: Array<object>,
): void {
  // Add cache control to last system message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "system") {
      ;(messages[i] as Record<string, unknown>).copilot_cache_control = {
        type: "ephemeral",
      }
      break
    }
  }

  // CAPI caching is most effective when the checkpoint is on the last non-user turn.
  // Avoid pure reasoning-only assistant turns to prevent Anthropic validation issues.
  const lastNonUserIndex = messages.findLastIndex(
    (message) => message.role !== "user" && !isReasoningOnlyMessage(message),
  )
  if (lastNonUserIndex !== -1) {
    ;(
      messages[lastNonUserIndex] as Record<string, unknown>
    ).copilot_cache_control = {
      type: "ephemeral",
    }
  }

  // Add cache control to last tool definition
  if (tools && tools.length > 0) {
    const lastTool = tools.at(-1)
    if (lastTool) {
      ;(lastTool as Record<string, unknown>).copilot_cache_control = {
        type: "ephemeral",
      }
    }
  }
}

function isReasoningOnlyMessage(message: {
  role: string
  content?: string | Array<unknown> | null
  tool_calls?: Array<unknown>
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  encrypted_content?: string | null
}): boolean {
  if (message.role !== "assistant") return false

  const hasReasoning = Boolean(
    message.reasoning_text
      || message.reasoning_opaque
      || message.encrypted_content,
  )
  if (!hasReasoning) return false

  const hasContent =
    typeof message.content === "string" ?
      message.content.trim().length > 0
    : Array.isArray(message.content) && message.content.length > 0

  const hasToolCalls =
    Array.isArray(message.tool_calls) && message.tool_calls.length > 0

  return !hasContent && !hasToolCalls
}
