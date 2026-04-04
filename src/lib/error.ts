import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import * as Sentry from "@sentry/bun"
import consola from "consola"

export class HTTPError extends Error {
  response: Response
  requestPayload?: unknown

  constructor(message: string, response: Response, requestPayload?: unknown) {
    super(message)
    this.response = response
    this.requestPayload = requestPayload
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
  if (error instanceof HTTPError) {
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
    consola.error("Response body:", parsedBody)
    consola.error("Response headers:", responseHeaders)
    if (error.requestPayload) {
      consola.error("Request payload:", error.requestPayload)
    }

    // Check for content filter error and log full details
    if (isContentFilterError(parsedBody)) {
      consola.box("CONTENT FILTER TRIGGERED")
      consola.error("Full error response:")
      console.log(JSON.stringify(parsedBody, null, 2))

      if (error.requestPayload) {
        consola.error("Request payload that triggered the filter:")
        console.log(JSON.stringify(error.requestPayload, null, 2))
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
        requestPayload: error.requestPayload,
      },
    })

    const clientMessage =
      error.response.status === 402 ? "Copilot quota exhausted"
      : error.response.status === 466 ? "Copilot client version mismatch"
      : error.message

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
