import consola from "consola"
import { randomUUID } from "node:crypto"

import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"

// --- Constants ---

export const API_VERSION = "2025-05-01"
export const INTEGRATION_ID = "copilot-developer-cli"
export const MAX_RETRIES = 5
export const BASE_DELAY_SECONDS = 5
export const BACKOFF_FACTOR = 2
export const MAX_DELAY_SECONDS = 180
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503])

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
}

export function copilotHeaders(
  options?: CopilotHeaderOptions,
): Record<string, string> {
  if (!state.copilotToken) {
    throw new Error("Copilot token is not set. Cannot build request headers.")
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    Authorization: `Bearer ${state.copilotToken}`,
    "Copilot-Integration-Id": INTEGRATION_ID,
    "Openai-Intent": "conversation-agent",
    "X-GitHub-Api-Version": API_VERSION,
    "X-Initiator": options?.initiator ?? "user",
    "X-Request-Id": randomUUID(),
    "X-Interaction-Id": state.sessionId,
    "X-Client-Session-Id": state.sessionId,
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

// --- Retryable Error Detection ---

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()
  const causeMessage =
    error.cause instanceof Error ? error.cause.message.toLowerCase() : ""

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

// --- Retry Delay Calculation ---

function calculateRetryDelay(
  attempt: number,
  retryAfterHeader: string | null,
): number {
  const exponentialDelay = BASE_DELAY_SECONDS * BACKOFF_FACTOR ** attempt

  if (retryAfterHeader) {
    const parsed = Number(retryAfterHeader)
    const delay = Number.isNaN(parsed) ? exponentialDelay : parsed
    return Math.min(delay, MAX_DELAY_SECONDS)
  }

  return Math.min(exponentialDelay, MAX_DELAY_SECONDS)
}

// --- Fetch with Retry ---

export async function copilotFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${copilotBaseUrl()}${path}`
  const maxAttempts = MAX_RETRIES + 1

  let lastError: Error | undefined
  let lastResponse: Response | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const headers = toHeaderRecord(init?.headers)
      headers["Connection"] = "close"

      const response = await fetch(url, {
        ...init,
        headers,
        keepalive: false,
      })

      // Log quota headers
      const quota = parseQuotaHeaders(response)
      if (quota) {
        consola.debug("Copilot quota snapshot:", quota)
      }

      // Check for retryable HTTP status codes
      if (
        RETRYABLE_STATUSES.has(response.status)
        && attempt < maxAttempts - 1
      ) {
        lastResponse = response
        const delaySeconds = calculateRetryDelay(
          attempt,
          response.headers.get("retry-after"),
        )
        consola.warn(
          `HTTP ${response.status} on ${path} (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delaySeconds}s`,
        )
        await sleep(delaySeconds * 1000)
        continue
      }

      return response
    } catch (error) {
      lastError = error as Error

      if (!isRetryableError(error) || attempt === maxAttempts - 1) {
        throw error
      }

      const delaySeconds = calculateRetryDelay(attempt, null)
      consola.warn(
        `Fetch failed on ${path} (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delaySeconds}s:`,
        lastError.message,
      )
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
  messages: Array<{ role: string }>,
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
