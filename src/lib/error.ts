import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import * as Sentry from "@sentry/bun"
import consola from "consola"

/**
 * Check if an error is an AbortError (client disconnected during streaming).
 * These are expected and should not be logged or reported to Sentry.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (error instanceof Error && error.name === "AbortError") return true
  return false
}

export class HTTPError extends Error {
  response: Response
  requestPayload?: unknown

  constructor(message: string, response: Response, requestPayload?: unknown) {
    super(message)
    this.response = response
    this.requestPayload = requestPayload
  }
}

export class LocalHTTPError extends HTTPError {
  readonly clientBody: Record<string, unknown>

  constructor(
    message: string,
    response: Response,
    clientBody: Record<string, unknown>,
  ) {
    super(message, response)
    this.clientBody = clientBody
  }
}

interface ContentFilterError {
  error: {
    code: string
    innererror?: {
      code: string
      content_filter_result?: unknown
    }
  }
}

function isContentFilterError(obj: unknown): obj is ContentFilterError {
  return (
    typeof obj === "object"
    && obj !== null
    && "error" in obj
    && typeof (obj as ContentFilterError).error === "object"
    && (obj as ContentFilterError).error.code === "content_filter"
  )
}

const SENSITIVE_HEADER_PATTERNS = [
  "authorization",
  "api-key",
  "cookie",
  "x-api-key",
  "set-cookie",
]
const SENSITIVE_FIELD_PATTERN =
  /password|secret|api[_-]?key|authorization|cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret|code[_-]?verifier/i

function redactSensitiveValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_FIELD_PATTERN.test(key)) return "[REDACTED]"
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item))
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        redactSensitiveValue(nestedValue, nestedKey),
      ]),
    )
  }
  return value
}

function extractResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of response.headers.entries()) {
    const lower = key.toLowerCase()
    if (!SENSITIVE_HEADER_PATTERNS.some((p) => lower.includes(p))) {
      headers[key] = value
    }
  }
  return headers
}

export async function forwardError(c: Context, error: unknown) {
  // Client disconnected — nothing to send back, don't log as error
  if (isAbortError(error)) {
    consola.debug("Client disconnected (AbortError)")
    // 499 = client closed request (nginx convention), not in Hono's StatusCode union
    return c.body(null, 499 as ContentfulStatusCode)
  }

  if (error instanceof HTTPError) {
    if (error.response.status === 499) {
      consola.debug("Client disconnected (upstream 499)")
      return c.body(null, 499 as ContentfulStatusCode)
    }

    let responseBody: string
    try {
      responseBody = await error.response.text()
    } catch {
      responseBody = "(unable to read response body)"
    }

    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(responseBody)
    } catch {
      parsedBody = responseBody
    }

    const responseHeaders = extractResponseHeaders(error.response)

    consola.error(
      `[${error.response.status} ${error.response.statusText}] ${error.message}`,
    )
    parsedBody = redactSensitiveValue(parsedBody)
    const requestPayload = redactSensitiveValue(error.requestPayload)
    consola.error("Response body:", parsedBody)
    consola.error("Response headers:", responseHeaders)
    if (requestPayload) {
      consola.error("Request payload:", requestPayload)
    }

    // Check for content filter error and log full details
    if (isContentFilterError(parsedBody)) {
      consola.box("CONTENT FILTER TRIGGERED")
      consola.error("Full error response:")
      console.log(JSON.stringify(parsedBody, null, 2))

      if (requestPayload) {
        consola.error("Request payload that triggered the filter:")
        console.log(JSON.stringify(requestPayload, null, 2))
      }
    }

    Sentry.captureException(error, {
      tags: {
        path: c.req.path,
        method: c.req.method,
        status: String(error.response.status),
      },
      extra: {
        status: error.response.status,
        statusText: error.response.statusText,
        responseUrl: error.response.url || undefined,
        responseBody: parsedBody,
        responseHeaders,
        requestPayload,
      },
    })

    let clientMessage = error.message
    if (error.response.status === 402) {
      clientMessage = "Copilot quota exhausted"
    } else if (error.response.status === 466) {
      clientMessage = "Copilot client version mismatch"
    }

    if (error instanceof LocalHTTPError) {
      return c.json(
        error.clientBody,
        error.response.status as ContentfulStatusCode,
      )
    }

    return c.json(
      {
        error: {
          message: clientMessage,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  consola.error("Error occurred:", error)

  Sentry.captureException(error, {
    tags: {
      path: c.req.path,
      method: c.req.method,
    },
    extra: {
      errorMessage: (error as Error).message,
      errorStack: (error as Error).stack,
    },
  })

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
