import consola from "consola"

import { sleep } from "./utils"

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 1000

interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
}

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
  // 408 Request Timeout, 429 Too Many Requests, 5xx Server Errors
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * Fetch with automatic retry on transient failures
 */
export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const { maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS } =
    options

  let lastError: Error | undefined
  let lastResponse: Response | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Force a new connection by adding cache-busting and connection headers
      const headers = new Headers(init?.headers)

      // Ensure we're not reusing potentially stale connections
      headers.set("Connection", "close")

      const response = await fetch(input, {
        ...init,
        headers,
        // Disable keep-alive to force fresh connections on each attempt
        keepalive: false,
      })

      // Check for retryable HTTP status codes
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        lastResponse = response
        const delayMs = baseDelayMs * 2 ** attempt
        consola.warn(
          `HTTP ${response.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms`,
        )
        await sleep(delayMs)
        continue
      }

      return response
    } catch (error) {
      lastError = error as Error

      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error
      }

      const delayMs = baseDelayMs * 2 ** attempt
      consola.warn(
        `Fetch failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms:`,
        lastError.message,
      )
      await sleep(delayMs)
    }
  }

  // If we exhausted retries due to HTTP status, return the last response
  if (lastResponse) {
    return lastResponse
  }

  throw lastError
}
