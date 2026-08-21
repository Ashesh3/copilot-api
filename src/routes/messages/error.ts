import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import * as Sentry from "@sentry/bun"
import consola from "consola"

import { ANTHROPIC_HTTP_ERROR_STATUS_TYPES } from "~/lib/compatibility-contract-values"
import {
  HTTP_TOO_MANY_REQUESTS_STATUS,
  type HttpErrorInspection,
  inspectHttpError,
  isAbortError,
  isHTTPError,
  reportHttpError,
  snapshotHttpErrorMetadata,
} from "~/lib/error"
import { getRequestId } from "~/lib/request-session"

import type { AnthropicErrorEvent } from "./anthropic-types"

type AnthropicErrorBody = AnthropicErrorEvent & { request_id?: string }

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlyArray<string>,
): boolean {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index])
  )
}

// Exact hostile-safe structural validation is intentionally branch-heavy.
// eslint-disable-next-line complexity
function snapshotAnthropicErrorBody(
  value: Readonly<Record<string, unknown>> | undefined,
): AnthropicErrorBody | undefined {
  if (!value || value.type !== "error") return undefined
  const expectedRootKeys =
    value.request_id === undefined ?
      ["error", "type"]
    : ["error", "request_id", "type"]
  if (!exactKeys(value, expectedRootKeys)) return undefined
  if (value.request_id !== undefined && typeof value.request_id !== "string") {
    return undefined
  }
  if (
    typeof value.error !== "object"
    || value.error === null
    || Array.isArray(value.error)
  ) {
    return undefined
  }
  const nested = value.error as Readonly<Record<string, unknown>>
  const expectedErrorKeys = ["message", "type"]
  if (nested.code !== undefined) expectedErrorKeys.push("code")
  if (nested.param !== undefined) expectedErrorKeys.push("param")
  if (
    !exactKeys(nested, expectedErrorKeys)
    || typeof nested.type !== "string"
    || typeof nested.message !== "string"
    || (nested.code !== undefined && typeof nested.code !== "string")
    || (nested.param !== undefined && typeof nested.param !== "string")
  ) {
    return undefined
  }
  return {
    type: "error",
    ...(typeof value.request_id === "string" ?
      { request_id: value.request_id }
    : {}),
    error: {
      type: nested.type,
      message: nested.message,
      ...(typeof nested.code === "string" ? { code: nested.code } : {}),
      ...(typeof nested.param === "string" ? { param: nested.param } : {}),
    },
  }
}

function anthropicErrorType(status: number): string {
  return (
    ANTHROPIC_HTTP_ERROR_STATUS_TYPES.find((entry) => entry.status === status)
      ?.type ?? "api_error"
  )
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

export function createAnthropicStreamError(
  error: unknown,
): AnthropicErrorEvent {
  if (!isHTTPError(error)) {
    return {
      type: "error",
      error: {
        type: "api_error",
        message: "The Copilot Messages request failed.",
      },
    }
  }
  return createAnthropicStreamErrorFromInspection(
    snapshotHttpErrorMetadata(error),
  )
}

function createAnthropicStreamErrorFromInspection(
  inspection: HttpErrorInspection,
): AnthropicErrorEvent {
  const localBody = snapshotAnthropicErrorBody(inspection.localClientBody)
  if (localBody) return localBody

  if (inspection.localError) {
    return {
      type: "error",
      error: {
        type: inspection.localError.type,
        message: anthropicErrorMessage(inspection.status),
        ...(inspection.localError.code ?
          { code: inspection.localError.code }
        : {}),
        ...(inspection.localError.param ?
          { param: inspection.localError.param }
        : {}),
      },
    }
  }

  return {
    type: "error",
    error: {
      type: anthropicErrorType(inspection.status),
      message: anthropicErrorMessage(inspection.status),
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

  if (isHTTPError(error)) {
    const metadata = snapshotHttpErrorMetadata(error)
    if (metadata.status === 499) {
      consola.debug("Client disconnected (upstream 499)")
      return c.body(null, 499 as ContentfulStatusCode)
    }

    const inspection = await inspectHttpError(error)
    reportHttpError(c, inspection)
    if (inspection.kind === "upstream") {
      return c.body(
        inspection.bodyBytes.slice(),
        inspection.status as ContentfulStatusCode,
        {
          ...inspection.responseHeaders,
          ...(inspection.contentType ?
            { "content-type": inspection.contentType }
          : {}),
        },
      )
    }
    for (const [name, value] of Object.entries(inspection.responseHeaders)) {
      c.header(name, value)
    }
    const localBody = snapshotAnthropicErrorBody(inspection.localClientBody)
    const body =
      localBody
      ?? withRequestId(
        createAnthropicStreamErrorFromInspection(inspection),
        requestId(c),
      )
    return c.json(body, inspection.status as ContentfulStatusCode)
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
