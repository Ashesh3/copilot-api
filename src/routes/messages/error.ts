import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import * as Sentry from "@sentry/bun"
import consola from "consola"

import {
  HTTPError,
  HTTP_TOO_MANY_REQUESTS_STATUS,
  LocalHTTPError,
  inspectSafeHttpError,
  isAbortError,
  reportSafeHttpError,
} from "~/lib/error"
import { getRequestId } from "~/lib/request-session"

import type { AnthropicErrorEvent } from "./anthropic-types"

type AnthropicErrorBody = AnthropicErrorEvent & { request_id?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isAnthropicErrorBody(value: unknown): value is AnthropicErrorBody {
  if (!isRecord(value) || value.type !== "error" || !isRecord(value.error)) {
    return false
  }
  if (
    typeof value.error.type !== "string"
    || typeof value.error.message !== "string"
  ) {
    return false
  }
  if (
    "request_id" in value
    && value.request_id !== undefined
    && typeof value.request_id !== "string"
  ) {
    return false
  }
  return true
}

function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: {
      return "invalid_request_error"
    }
    case 401: {
      return "authentication_error"
    }
    case 403: {
      return "permission_error"
    }
    case 404: {
      return "not_found_error"
    }
    case 413: {
      return "request_too_large"
    }
    case HTTP_TOO_MANY_REQUESTS_STATUS: {
      return "rate_limit_error"
    }
    default: {
      return "api_error"
    }
  }
}

function anthropicErrorMessage(status: number): string {
  switch (status) {
    case 400: {
      return "The Copilot Messages request was rejected."
    }
    case 401: {
      return "Copilot authentication failed."
    }
    case 402: {
      return "Copilot quota exhausted."
    }
    case 403: {
      return "The Copilot Messages request is not permitted."
    }
    case 404: {
      return "The requested Copilot Messages resource was not found."
    }
    case 413: {
      return "The Copilot Messages request is too large."
    }
    case HTTP_TOO_MANY_REQUESTS_STATUS: {
      return "Copilot rate limit exceeded."
    }
    case 466: {
      return "Copilot client version mismatch."
    }
    default: {
      return "The Copilot Messages request failed."
    }
  }
}

function statusForError(error: unknown): number {
  return error instanceof HTTPError ? error.response.status : 500
}

function localAnthropicError(error: unknown): AnthropicErrorBody | undefined {
  if (
    error instanceof LocalHTTPError
    && isAnthropicErrorBody(error.clientBody)
  ) {
    return error.clientBody
  }
  return undefined
}

export function createAnthropicStreamError(
  error: unknown,
): AnthropicErrorEvent {
  const localBody = localAnthropicError(error)
  if (localBody) return localBody

  const status = statusForError(error)
  return {
    type: "error",
    error: {
      type: anthropicErrorType(status),
      message: anthropicErrorMessage(status),
    },
  }
}

function requestId(c: Context): string | undefined {
  return c.req.header("x-request-id") ?? getRequestId()
}

function withRequestId(
  body: AnthropicErrorEvent,
  id: string | undefined,
): AnthropicErrorBody {
  return id ? { ...body, request_id: id } : body
}

export async function forwardMessagesError(
  c: Context,
  error: unknown,
): Promise<Response> {
  if (isAbortError(error)) {
    consola.debug("Client disconnected (AbortError)")
    return c.body(null, 499 as ContentfulStatusCode)
  }

  if (error instanceof HTTPError) {
    if (error.response.status === 499) {
      consola.debug("Client disconnected (upstream 499)")
      return c.body(null, 499 as ContentfulStatusCode)
    }

    const inspection = await inspectSafeHttpError(error)
    reportSafeHttpError(c, error, inspection)
    const localBody = localAnthropicError(error)
    const body =
      localBody
      ?? withRequestId(createAnthropicStreamError(error), requestId(c))
    return c.json(body, error.response.status as ContentfulStatusCode)
  }

  consola.error("Unexpected internal error")
  Sentry.captureException(new Error("Unexpected internal error"), {
    tags: { path: c.req.path, method: c.req.method },
  })
  return c.json(
    withRequestId(createAnthropicStreamError(error), requestId(c)),
    500,
  )
}
