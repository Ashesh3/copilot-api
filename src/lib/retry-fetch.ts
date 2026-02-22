import consola from "consola"

import { sleep } from "./utils"

// Fast retry: 100ms, 200ms, 300ms, then stop (max ~600ms total wait)
const RETRY_DELAYS_MS = [100, 200, 300]

/**
 * Check if an error is retryable (transient network error)
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()
  const causeMessage =
    error.cause instanceof Error ? error.cause.message.toLowerCase() : ""

  // Common transient error patterns
  const retryablePatterns = [
    "fetch failed",
    "other side closed",
    "connection reset",
    "econnreset",
    "socket hang up",
    "socket connection was closed unexpectedly",
    "etimedout",
    "econnrefused",
    "network error",
    "aborted",
    "timeout",
  ]

  return retryablePatterns.some(
    (pattern) => message.includes(pattern) || causeMessage.includes(pattern),
  )
}

/**
 * Check if an HTTP response status is retryable
 */
function isRetryableStatus(status: number): boolean {
  // 4xx client errors (except 400, 401, 403, 404) and 5xx server errors
  // Retry: 408 Timeout, 429 Rate Limit, and all 5xx
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * Fetch with automatic fast retry on transient failures
 * Retries with delays: 100ms, 200ms, 300ms (max ~600ms total wait)
 */
export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const maxAttempts = RETRY_DELAYS_MS.length + 1 // 4 total attempts

  let lastError: Error | undefined
  let lastResponse: Response | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Force a new connection by adding connection-close while preserving
      // caller-provided header casing (tests assert exact header key names).
      const headers = toHeaderRecord(init?.headers)
      headers.Connection = "close"

      const response = await fetch(input, {
        ...init,
        headers,
        // Disable keep-alive to force fresh connections on each attempt
        keepalive: false,
      })

      // Check for retryable HTTP status codes
      if (isRetryableStatus(response.status) && attempt < maxAttempts - 1) {
        lastResponse = response
        const delayMs = RETRY_DELAYS_MS[attempt]
        consola.warn(
          `HTTP ${response.status} (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delayMs}ms`,
        )
        await sleep(delayMs)
        continue
      }

      return response
    } catch (error) {
      lastError = error as Error

      if (!isRetryableError(error) || attempt === maxAttempts - 1) {
        throw error
      }

      const delayMs = RETRY_DELAYS_MS[attempt]
      consola.warn(
        `Fetch failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delayMs}ms:`,
        lastError.message,
      )
      await sleep(delayMs)
    }
  }

  // If we exhausted retries due to HTTP status, return the last response
  if (lastResponse) {
    return lastResponse
  }

  throw lastError ?? new Error("Request failed without a captured error")
}

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
    for (const entry of headersInit) {
      if (
        Array.isArray(entry)
        && entry.length === 2
        && typeof entry[0] === "string"
        && typeof entry[1] === "string"
      ) {
        const [key, value] = entry
        headers[key] = value
      }
    }
    return headers
  }

  for (const [key, value] of Object.entries(
    headersInit as Record<string, unknown>,
  )) {
    if (typeof value === "string") {
      headers[key] = value
    }
  }
  return headers
}
