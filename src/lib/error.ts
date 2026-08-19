import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import * as Sentry from "@sentry/bun"
import consola from "consola"

import type {
  EndpointRouteFailure,
  TranslationCheck,
} from "~/lib/endpoint-routing"

import {
  readDescriptorSnapshotValue,
  readNativeDomExceptionField,
  snapshotDescriptorChain,
} from "~/lib/descriptor-chain"

const ABORT_ERROR_DESCRIPTOR_KEYS = new Set(["name"])
export const HTTP_TOO_MANY_REQUESTS_STATUS = 429

/**
 * Check if an error is an AbortError (client disconnected during streaming).
 * These are expected and should not be logged or reported to Sentry.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const snapshot = snapshotDescriptorChain(error, {
    keys: ABORT_ERROR_DESCRIPTOR_KEYS,
    maxDepth: 5,
  })
  if (!snapshot) return false
  const name =
    readNativeDomExceptionField(snapshot, "name")
    ?? readDescriptorSnapshotValue(snapshot, "name")
    ?? snapshot.errorKind
  return name === "AbortError"
}

export class HTTPError extends Error {
  response: Response
  requestPayload?: unknown

  constructor(message: string, response: Response, requestPayload?: unknown) {
    super(message)
    this.response = response
    this.requestPayload = redactSensitiveValue(requestPayload)
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

export function createInvalidJsonBodyError(): LocalHTTPError {
  const clientBody = {
    error: {
      code: "invalid_json",
      message: "The request body must contain valid JSON.",
      param: "body",
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

export function createEndpointTranslationError(
  failure: EndpointRouteFailure,
): LocalHTTPError {
  const concept = failure.blockers[0] ?? "request_shape"
  const clientBody = {
    error: {
      code: failure.code,
      message:
        "The selected Copilot model cannot accept this request without losing required protocol data.",
      param: concept,
      type: "invalid_request_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}

export function assertEndpointTranslationSupported(
  failure: EndpointRouteFailure,
  check: TranslationCheck,
): void {
  if (check.supported) return
  throw createEndpointTranslationError({
    blockers: check.blockers,
    code: failure.code,
    source: failure.source,
  })
}

interface UpstreamErrorBody {
  error: {
    code?: unknown
    message?: unknown
  }
}

export interface SafeUpstreamClientError {
  code: string
  fingerprint: string
  message: string
}

export interface SafeHttpErrorInspection {
  clientError?: SafeUpstreamClientError
  safeMessage: string
}

const SENSITIVE_FIELD_PATTERN =
  /password|secret|api[_-]?key|authorization|cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret|code[_-]?verifier|(?:conversation|session|thread)[_-]?id|prompt[_-]?cache[_-]?key|safety[_-]?identifier|user[_-]?id/i
const SENSITIVE_ERROR_MESSAGE_PATTERN =
  /authorization|bearer\s|api[_ -]?key|password|secret|token|cookie/i
const SAFE_HTTP_ERROR_MESSAGES = new Set([
  "Empty response body from upstream",
  "Failed to create chat completions",
  "Failed to create embeddings",
  "Failed to create responses",
  "Failed to get Copilot usage",
  "Failed to get Copilot token",
  "Failed to get device code",
  "Failed to get GitHub user",
  "Failed to get models",
  "Invalid JSON response from upstream",
  "Request rejected",
])

function safeHttpErrorMessage(error: HTTPError): string {
  return SAFE_HTTP_ERROR_MESSAGES.has(error.message) ?
      error.message
    : "Upstream request failed"
}

function redactSensitiveValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_FIELD_PATTERN.test(key)) return "[REDACTED]"
  if (
    typeof value === "string"
    && (key === "client_metadata" || key === "metadata")
  ) {
    try {
      return JSON.stringify(redactSensitiveValue(JSON.parse(value) as unknown))
    } catch {
      return "[REDACTED]"
    }
  }
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

function isUpstreamErrorBody(value: unknown): value is UpstreamErrorBody {
  return (
    typeof value === "object"
    && value !== null
    && "error" in value
    && typeof value.error === "object"
    && value.error !== null
  )
}

function unwrapUpstreamErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== "object" || parsed === null) return value
    const record = parsed as Record<string, unknown>
    if (typeof record.error === "string") return record.error
    if (typeof record.message === "string") return record.message
  } catch {
    return value
  }
  return value
}

function classifyValidationMessage(
  message: string,
): Pick<SafeUpstreamClientError, "fingerprint" | "message"> | undefined {
  const toolChoiceMessage =
    "Invalid request content: A tool_choice was set on the request but no tools were specified."
  if (message === toolChoiceMessage) {
    return { fingerprint: "tool_choice_without_tools", message }
  }
  const sampling =
    /^Unsupported parameter: '(temperature|top_p)' is not supported with this model\.$/.exec(
      message,
    )
  if (sampling) {
    return {
      fingerprint: `unsupported_${sampling[1]}`,
      message: `Unsupported parameter: '${sampling[1]}' is not supported with this model.`,
    }
  }
  const imageMessage =
    "validating vision content in responses input: validating responses image content: image media type not supported"
  if (message === imageMessage) {
    return { fingerprint: "unsupported_image_media_type", message }
  }
  return undefined
}

function safeUpstreamClientError(
  status: number,
  body: unknown,
): SafeUpstreamClientError | undefined {
  if (status !== 400 || !isUpstreamErrorBody(body)) {
    return undefined
  }
  const code = body.error.code
  const message = unwrapUpstreamErrorMessage(body.error.message)
  const validation = message ? classifyValidationMessage(message) : undefined
  if (
    code !== "invalid_request_body"
    || !message
    || !validation
    || SENSITIVE_ERROR_MESSAGE_PATTERN.test(message)
  ) {
    return undefined
  }
  return {
    code,
    ...validation,
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  let body: string
  try {
    body = await response.text()
  } catch {
    return "(unable to read response body)"
  }

  try {
    return JSON.parse(body) as unknown
  } catch {
    return body
  }
}

function logHttpError(options: {
  error: HTTPError
  clientError?: SafeUpstreamClientError
}): void {
  const { clientError, error } = options
  const message = safeHttpErrorMessage(error)
  consola.error(`[${error.response.status}] ${message}`)
  if (clientError) consola.error("Validation class:", clientError.fingerprint)
}

function captureHttpError(options: {
  c: Context
  clientError?: SafeUpstreamClientError
  error: HTTPError
}): void {
  const { c, clientError, error } = options
  Sentry.captureException(new Error(safeHttpErrorMessage(error)), {
    ...(clientError ?
      {
        fingerprint: [
          "http-error",
          c.req.path,
          String(error.response.status),
          clientError.code,
          clientError.fingerprint,
        ],
      }
    : {}),
    tags: {
      path: c.req.path,
      method: c.req.method,
      status: String(error.response.status),
    },
    extra: {
      status: error.response.status,
      validationClass: clientError?.fingerprint,
    },
  })
}

export function reportSafeHttpError(
  c: Context,
  error: HTTPError,
  inspection: SafeHttpErrorInspection,
): void {
  logHttpError({ error, clientError: inspection.clientError })
  captureHttpError({ c, error, clientError: inspection.clientError })
}

export async function inspectSafeHttpError(
  error: HTTPError,
): Promise<SafeHttpErrorInspection> {
  const parsedBody = redactSensitiveValue(
    await readResponseBody(error.response),
  )
  const clientError = safeUpstreamClientError(error.response.status, parsedBody)
  let safeMessage = safeHttpErrorMessage(error)
  if (error.response.status === 402) safeMessage = "Copilot quota exhausted"
  if (error.response.status === 466) {
    safeMessage = "Copilot client version mismatch"
  }
  return { clientError, safeMessage }
}

function httpErrorResponse(
  c: Context,
  error: HTTPError,
  inspection: SafeHttpErrorInspection,
) {
  if (error instanceof LocalHTTPError) {
    return c.json(
      error.clientBody,
      error.response.status as ContentfulStatusCode,
    )
  }
  if (inspection.clientError) {
    return c.json(
      {
        error: {
          code: inspection.clientError.code,
          message: inspection.clientError.message,
          type: "invalid_request_error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    { error: { message: inspection.safeMessage, type: "error" } },
    error.response.status as ContentfulStatusCode,
  )
}

async function forwardHttpError(c: Context, error: HTTPError) {
  if (error.response.status === 499) {
    consola.debug("Client disconnected (upstream 499)")
    return c.body(null, 499 as ContentfulStatusCode)
  }

  const inspection = await inspectSafeHttpError(error)
  reportSafeHttpError(c, error, inspection)
  return httpErrorResponse(c, error, inspection)
}

export async function forwardError(c: Context, error: unknown) {
  // Client disconnected — nothing to send back, don't log as error
  if (isAbortError(error)) {
    consola.debug("Client disconnected (AbortError)")
    // 499 = client closed request (nginx convention), not in Hono's StatusCode union
    return c.body(null, 499 as ContentfulStatusCode)
  }

  if (error instanceof HTTPError) return await forwardHttpError(c, error)

  consola.error("Unexpected internal error")

  Sentry.captureException(new Error("Unexpected internal error"), {
    tags: {
      path: c.req.path,
      method: c.req.method,
    },
  })

  return c.json(
    {
      error: {
        code: "internal_error",
        message: "Internal server error",
        type: "server_error",
      },
    },
    500,
  )
}
