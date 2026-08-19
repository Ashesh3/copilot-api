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
  readNativeErrorMessage,
  snapshotDescriptorChain,
} from "~/lib/descriptor-chain"
import {
  isProxyObject,
  snapshotPlainDataRecord,
} from "~/lib/plain-data-snapshot"
import { collectSafeCopilotResponseHeaders } from "~/services/copilot/copilot-contract"

const ABORT_ERROR_DESCRIPTOR_KEYS = new Set(["name"])
const HTTP_ERROR_DESCRIPTOR_KEYS = new Set(["message", "response"])
const RESPONSE_PROTOTYPE_DESCRIPTORS = Object.getOwnPropertyDescriptors(
  Response.prototype,
)
const RESPONSE_CLONE = RESPONSE_PROTOTYPE_DESCRIPTORS.clone.value as (
  this: Response,
) => Response
const RESPONSE_HEADERS = RESPONSE_PROTOTYPE_DESCRIPTORS.headers.get as (
  this: Response,
) => Headers
const RESPONSE_STATUS = RESPONSE_PROTOTYPE_DESCRIPTORS.status.get as (
  this: Response,
) => number
const RESPONSE_TEXT = RESPONSE_PROTOTYPE_DESCRIPTORS.text.value as (
  this: Response,
) => Promise<string>
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

interface LocalHttpErrorSnapshot {
  readonly clientBody?: Readonly<Record<string, unknown>>
  readonly localError?: SafeLocalClientError
}

const LOCAL_HTTP_ERROR_SNAPSHOTS = new WeakMap<
  HTTPError,
  LocalHttpErrorSnapshot
>()

export class LocalHTTPError extends HTTPError {
  readonly clientBody: Record<string, unknown>

  constructor(
    message: string,
    response: Response,
    clientBody: Record<string, unknown>,
  ) {
    super(message, response)
    this.clientBody = clientBody
    const clientBodySnapshot = snapshotPlainDataRecord(clientBody)
    LOCAL_HTTP_ERROR_SNAPSHOTS.set(this, {
      clientBody: clientBodySnapshot,
      localError: safeLocalClientError(clientBodySnapshot),
    })
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
  readonly clientError?: SafeUpstreamClientError
  readonly localError?: SafeLocalClientError
  readonly localClientBody?: Readonly<Record<string, unknown>>
  readonly responseHeaders: Readonly<Record<string, string>>
  readonly safeMessage: string
  readonly status: number
}

export interface SafeLocalClientError {
  readonly code?: string
  readonly message: string
  readonly param?: string
  readonly type: string
}

export function isHTTPError(error: unknown): error is HTTPError {
  if (isProxyObject(error)) return false
  try {
    return error instanceof HTTPError
  } catch {
    return false
  }
}

interface SafeHttpErrorSnapshot extends SafeHttpErrorInspection {
  readonly responseBody?: Response
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

function safeHttpErrorMessage(message: unknown): string {
  return typeof message === "string" && SAFE_HTTP_ERROR_MESSAGES.has(message) ?
      message
    : "Upstream request failed"
}

function snapshotLocalClientBody(error: HTTPError): LocalHttpErrorSnapshot {
  return LOCAL_HTTP_ERROR_SNAPSHOTS.get(error) ?? {}
}

function safeLocalClientError(
  clientBody: Readonly<Record<string, unknown>> | undefined,
): SafeLocalClientError | undefined {
  const bodyError = clientBody?.error
  if (
    typeof bodyError !== "object"
    || bodyError === null
    || Array.isArray(bodyError)
  ) {
    return undefined
  }
  const record = bodyError as Readonly<Record<string, unknown>>
  if (
    typeof record.type !== "string"
    || typeof record.message !== "string"
    || !isSafeLocalErrorMetadata(record)
  ) {
    return undefined
  }
  return Object.freeze({
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    message: record.message,
    ...(typeof record.param === "string" ? { param: record.param } : {}),
    type: record.type,
  } satisfies SafeLocalClientError)
}

const SAFE_LOCAL_ERROR_TYPES = new Set([
  "account_unavailable",
  "error",
  "invalid_request_error",
  "not_found_error",
  "session_affinity_error",
  "server_error",
])
const SAFE_LOCAL_ERROR_CODES = new Set([
  "account_reinitialization_failed",
  "bad_request",
  "compaction_payload_too_large",
  "endpoint_translation_unsupported",
  "invalid_json",
  "invalid_request",
  "invalid_type",
  "invalid_value",
  "request_too_large",
  "responses_payload_too_large",
  "server_error",
  "session_account_rejected",
  "unsupported_value",
])

function isSafeLocalErrorMetadata(
  record: Readonly<Record<string, unknown>>,
): boolean {
  if (!SAFE_LOCAL_ERROR_TYPES.has(record.type as string)) return false
  if (typeof record.code === "string") {
    return SAFE_LOCAL_ERROR_CODES.has(record.code)
  }
  return record.type === "not_found_error"
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const body = value as Record<string, unknown>
  return typeof body.error === "object" && body.error !== null
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
  const snapshot = snapshotPlainDataRecord(body)
  if (status !== 400 || !snapshot || !isUpstreamErrorBody(snapshot)) {
    return undefined
  }
  const code = snapshot.error.code
  const message = unwrapUpstreamErrorMessage(snapshot.error.message)
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
    body = await Reflect.apply(RESPONSE_TEXT, response, [])
  } catch {
    return "(unable to read response body)"
  }

  try {
    return JSON.parse(body) as unknown
  } catch {
    return body
  }
}

function readHttpErrorSnapshot(error: HTTPError): SafeHttpErrorSnapshot {
  const snapshot = snapshotDescriptorChain(error, {
    keys: HTTP_ERROR_DESCRIPTOR_KEYS,
    maxDepth: 6,
  })
  const message = readNativeErrorMessage(snapshot)
  const response = readDescriptorSnapshotValue(snapshot, "response")
  const localSnapshot = snapshotLocalClientBody(error)
  const localClientBody = localSnapshot.clientBody
  const localError = localSnapshot.localError

  if (
    typeof response !== "object"
    || response === null
    || isProxyObject(response)
  ) {
    return {
      localClientBody,
      localError,
      responseHeaders: Object.freeze({}),
      safeMessage: safeHttpErrorMessage(message),
      status: 500,
    }
  }

  let status = 500
  let responseHeaders: Readonly<Record<string, string>> = Object.freeze({})
  let responseBody: Response | undefined
  try {
    const nativeStatus = Reflect.apply(RESPONSE_STATUS, response, []) as unknown
    if (
      typeof nativeStatus === "number"
      && Number.isInteger(nativeStatus)
      && nativeStatus >= 200
      && nativeStatus <= 599
    ) {
      status = nativeStatus
    }
    const headers = Reflect.apply(RESPONSE_HEADERS, response, []) as unknown
    if (headers instanceof Headers && !isProxyObject(headers)) {
      responseHeaders = Object.freeze(
        collectSafeCopilotResponseHeaders(headers),
      )
    }
    responseBody = Reflect.apply(RESPONSE_CLONE, response, []) as Response
  } catch {
    return {
      localClientBody,
      localError,
      responseHeaders,
      safeMessage: safeHttpErrorMessage(message),
      status,
    }
  }

  return {
    localClientBody,
    localError,
    responseBody,
    responseHeaders,
    safeMessage: safeHttpErrorMessage(message),
    status,
  }
}

export function snapshotSafeHttpError(
  error: HTTPError,
): SafeHttpErrorInspection {
  const snapshot = readHttpErrorSnapshot(error)
  let safeMessage = snapshot.localError?.message ?? snapshot.safeMessage
  if (snapshot.status === 402) safeMessage = "Copilot quota exhausted"
  if (snapshot.status === 466) {
    safeMessage = "Copilot client version mismatch"
  }
  return Object.freeze({
    localClientBody: snapshot.localClientBody,
    localError: snapshot.localError,
    responseHeaders: snapshot.responseHeaders,
    safeMessage,
    status: snapshot.status,
  })
}

function logHttpError(inspection: SafeHttpErrorInspection): void {
  consola.error(`[${inspection.status}] ${inspection.safeMessage}`)
  if (inspection.clientError) {
    consola.error("Validation class:", inspection.clientError.fingerprint)
  }
}

function captureHttpError(options: {
  c: Context
  inspection: SafeHttpErrorInspection
}): void {
  const { c, inspection } = options
  Sentry.captureException(new Error(inspection.safeMessage), {
    ...(inspection.clientError ?
      {
        fingerprint: [
          "http-error",
          c.req.path,
          String(inspection.status),
          inspection.clientError.code,
          inspection.clientError.fingerprint,
        ],
      }
    : {}),
    tags: {
      path: c.req.path,
      method: c.req.method,
      status: String(inspection.status),
    },
    extra: {
      status: inspection.status,
      validationClass: inspection.clientError?.fingerprint,
    },
  })
}

export function reportSafeHttpError(
  c: Context,
  inspection: SafeHttpErrorInspection,
): void {
  logHttpError(inspection)
  captureHttpError({ c, inspection })
}

export async function inspectSafeHttpError(
  error: HTTPError,
): Promise<SafeHttpErrorInspection> {
  const snapshot = readHttpErrorSnapshot(error)
  const parsedBody =
    snapshot.responseBody ?
      redactSensitiveValue(await readResponseBody(snapshot.responseBody))
    : undefined
  const clientError = safeUpstreamClientError(snapshot.status, parsedBody)
  let safeMessage = snapshot.localError?.message ?? snapshot.safeMessage
  if (snapshot.status === 402) safeMessage = "Copilot quota exhausted"
  if (snapshot.status === 466) {
    safeMessage = "Copilot client version mismatch"
  }
  return Object.freeze({
    clientError,
    localClientBody: snapshot.localClientBody,
    localError: snapshot.localError,
    responseHeaders: snapshot.responseHeaders,
    safeMessage,
    status: snapshot.status,
  })
}

function httpErrorResponse(c: Context, inspection: SafeHttpErrorInspection) {
  for (const [name, value] of Object.entries(inspection.responseHeaders)) {
    c.header(name, value)
  }
  if (inspection.localClientBody) {
    return c.json(
      inspection.localClientBody,
      inspection.status as ContentfulStatusCode,
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
      inspection.status as ContentfulStatusCode,
    )
  }

  return c.json(
    { error: { message: inspection.safeMessage, type: "error" } },
    inspection.status as ContentfulStatusCode,
  )
}

async function forwardHttpError(c: Context, error: HTTPError) {
  const inspection = await inspectSafeHttpError(error)
  if (inspection.status === 499) {
    consola.debug("Client disconnected (upstream 499)")
    return c.body(null, 499 as ContentfulStatusCode)
  }

  reportSafeHttpError(c, inspection)
  return httpErrorResponse(c, inspection)
}

export async function forwardError(c: Context, error: unknown) {
  // Client disconnected — nothing to send back, don't log as error
  if (isAbortError(error)) {
    consola.debug("Client disconnected (AbortError)")
    // 499 = client closed request (nginx convention), not in Hono's StatusCode union
    return c.body(null, 499 as ContentfulStatusCode)
  }

  if (isHTTPError(error)) return await forwardHttpError(c, error)

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
