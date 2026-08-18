import { randomUUID } from "node:crypto"

import {
  readDescriptorSnapshotValue,
  readNativeDomExceptionField,
  snapshotDescriptorChain,
  type DescriptorChainSnapshot,
} from "./descriptor-chain"

export const LLM_DEBUG_HISTORY_WINDOW_MS = 10 * 60 * 1000

type HeaderRecord = Record<string, string>

export interface LlmDebugLogError {
  /** Transport error code (e.g. Bun's `ECONNRESET`), when the runtime sets one. */
  code?: number | string
  errno?: number
  message: string
  name: string
  /** Runtime diagnostic path, when the thrown error exposes one. */
  path?: string
  stack?: string
}

export interface LlmDebugLogRequest {
  body: string | null
  bodyBytes: number
  headers: HeaderRecord
  method: string
  path: string
  url: string
}

export interface LlmDebugLogResponse {
  body: string | null
  bodyBytes: number
  bodyReadError?: LlmDebugLogError
  headers: HeaderRecord
  status: number
  statusText: string
}

export interface LlmDebugLogEntry {
  durationMs?: number
  endedAt?: string
  error?: LlmDebugLogError
  id: string
  model?: string
  request: LlmDebugLogRequest
  requestId?: string
  response?: LlmDebugLogResponse
  startedAt: string
  startedAtMs: number
  status: "pending" | "complete" | "error" | "aborted"
  stream?: boolean
}

export interface LlmDebugLogSummary {
  durationMs?: number
  endedAt?: string
  errorMessage?: string
  id: string
  method: string
  model?: string
  path: string
  requestBodyBytes: number
  requestId?: string
  requestPreview: string
  responseBodyBytes?: number
  responseContentType?: string
  responsePreview?: string
  responseStatus?: number
  responseStatusText?: string
  startedAt: string
  status: LlmDebugLogEntry["status"]
  stream?: boolean
}

export interface LlmDebugLogListResponse {
  count: number
  entries: Array<LlmDebugLogSummary>
  generatedAt: string
}

interface AbortLlmDebugLogOptions {
  endedAtMs?: number
  error: unknown
  response?: Omit<LlmDebugLogResponse, "bodyBytes">
}

interface StartLlmDebugLogInput {
  method: string
  path: string
  requestBody: string | null
  requestHeaders: HeaderRecord
  requestId?: string
  startedAtMs?: number
  url: string
}

const LOG_QUEUE_COMPACT_THRESHOLD = 1024

let logs: Array<LlmDebugLogEntry | undefined> = []
let logIndex = new Map<string, LlmDebugLogEntry>()
let firstLogIndex = 0
let pruneTimer: ReturnType<typeof setTimeout> | undefined
let pruneTimerDeadlineMs: number | undefined

function byteLength(value: string | null): number {
  if (value === null) return 0
  return new TextEncoder().encode(value).byteLength
}

function compactWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isUnknownArray(value: unknown): value is Array<unknown> {
  return Array.isArray(value)
}

function stringFromContentPart(part: unknown): string {
  if (!isRecord(part)) return ""
  if (typeof part.text === "string") return part.text
  if (part.type === "image_url" || part.type === "input_image") return "[image]"
  if (typeof part.image_url === "string") return "[image]"
  if (isRecord(part.image_url)) return "[image]"
  return ""
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value
  if (isUnknownArray(value)) {
    const text = value
      .map((part) => stringFromContentPart(part))
      .filter(Boolean)
      .join(" ")
    if (text) return text
  }
  if (value === null || value === undefined) return ""
  return JSON.stringify(value)
}

function previewFromMessages(messages: unknown): string | undefined {
  if (!isUnknownArray(messages)) return undefined

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isRecord(message) && "content" in message) {
      return stringifyContent(message.content)
    }
  }

  return undefined
}

function previewFromInput(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (!isUnknownArray(input)) return undefined

  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index]
    if (isRecord(item) && ("content" in item || "output" in item)) {
      return stringifyContent(item.content ?? item.output)
    }
  }

  return undefined
}

function previewFromJsonBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!isRecord(parsed)) return undefined

    return (
      previewFromMessages(parsed.messages)
      ?? previewFromInput(parsed.input)
      ?? (typeof parsed.prompt === "string" ? parsed.prompt : undefined)
    )
  } catch {
    return undefined
  }
}

function inferModel(body: string | null): string | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    return isRecord(parsed) && typeof parsed.model === "string" ?
        parsed.model
      : undefined
  } catch {
    return undefined
  }
}

function inferStream(body: string | null): boolean | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    return isRecord(parsed) && typeof parsed.stream === "boolean" ?
        parsed.stream
      : undefined
  } catch {
    return undefined
  }
}

function buildRequestPreview(body: string | null): string {
  if (!body) return ""
  const jsonPreview = previewFromJsonBody(body)
  return compactWhitespace(jsonPreview ?? body)
}

function buildResponsePreview(body: string | null): string | undefined {
  if (!body) return undefined
  return compactWhitespace(body)
}

function clearPruneTimer(): void {
  if (pruneTimer !== undefined) clearTimeout(pruneTimer)
  pruneTimer = undefined
  pruneTimerDeadlineMs = undefined
}

function schedulePrune(): void {
  const oldest = logs[firstLogIndex]
  if (!oldest) {
    clearPruneTimer()
    return
  }

  const deadlineMs = oldest.startedAtMs + LLM_DEBUG_HISTORY_WINDOW_MS
  if (pruneTimerDeadlineMs === deadlineMs) return

  clearPruneTimer()
  pruneTimerDeadlineMs = deadlineMs
  const delayMs = Math.max(0, deadlineMs - Date.now())
  pruneTimer = setTimeout(() => {
    pruneTimer = undefined
    pruneTimerDeadlineMs = undefined
    prune()
  }, delayMs)
  pruneTimer.unref()
}

function prune(nowMs = Date.now()): void {
  const cutoff = nowMs - LLM_DEBUG_HISTORY_WINDOW_MS
  while (firstLogIndex < logs.length) {
    const entry = logs[firstLogIndex]
    if (!entry || entry.startedAtMs > cutoff) break
    logIndex.delete(entry.id)
    logs[firstLogIndex] = undefined
    firstLogIndex += 1
  }

  if (firstLogIndex === logs.length) {
    logs = []
    logIndex = new Map()
    firstLogIndex = 0
  } else if (
    firstLogIndex >= LOG_QUEUE_COMPACT_THRESHOLD
    && firstLogIndex * 2 >= logs.length
  ) {
    logs = logs.slice(firstLogIndex)
    logIndex = new Map(logIndex)
    firstLogIndex = 0
  }
  schedulePrune()
}

function insertLog(entry: LlmDebugLogEntry): void {
  const last = logs.at(-1)
  if (!last || last.startedAtMs <= entry.startedAtMs) {
    logs.push(entry)
  } else {
    let low = firstLogIndex
    let high = logs.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const middleEntry = logs[middle]
      if (middleEntry && middleEntry.startedAtMs <= entry.startedAtMs) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    logs.splice(low, 0, entry)
  }
  logIndex.set(entry.id, entry)
}

function getActiveLogs(): Array<LlmDebugLogEntry> {
  const active: Array<LlmDebugLogEntry> = []
  for (let index = firstLogIndex; index < logs.length; index++) {
    const entry = logs[index]
    if (entry) active.push(entry)
  }
  return active
}

function cloneEntry(entry: LlmDebugLogEntry): LlmDebugLogEntry {
  return structuredClone(entry)
}

const DEBUG_ERROR_DESCRIPTOR_KEYS = new Set([
  "cause",
  "code",
  "errno",
  "message",
  "name",
  "path",
  "stack",
])
const DEBUG_ERROR_DESCRIPTOR_DEPTH = 5

/**
 * Read a runtime-attached diagnostic field, falling back to the cause. Wrapped
 * errors (`new Error(msg, { cause: bunError })`) carry these on the cause only.
 */
function readErrorField(
  snapshot: DescriptorChainSnapshot,
  key: string,
): unknown {
  const own = readDescriptorSnapshotValue(snapshot, key)
  if (own !== undefined) return own

  const cause = readDescriptorSnapshotValue(snapshot, "cause")
  const causeSnapshot = snapshotDescriptorChain(cause, {
    keys: DEBUG_ERROR_DESCRIPTOR_KEYS,
    maxDepth: DEBUG_ERROR_DESCRIPTOR_DEPTH,
  })
  if (key === "code") {
    return (
      readNativeDomExceptionField(causeSnapshot, "code")
      ?? readDescriptorSnapshotValue(causeSnapshot, key)
    )
  }
  return readDescriptorSnapshotValue(causeSnapshot, key)
}

function readDebugErrorString(
  snapshot: DescriptorChainSnapshot,
  key: string,
): string | undefined {
  const nativeValue =
    key === "message" || key === "name" ?
      readNativeDomExceptionField(snapshot, key)
    : undefined
  const value = nativeValue ?? readDescriptorSnapshotValue(snapshot, key)
  return typeof value === "string" ? value : undefined
}

function readDebugErrorName(snapshot: DescriptorChainSnapshot): string {
  return readDebugErrorString(snapshot, "name") ?? snapshot.errorKind ?? "Error"
}

function readDebugErrorMessage(snapshot: DescriptorChainSnapshot): string {
  return readDebugErrorString(snapshot, "message") ?? "Unknown thrown value"
}

function normalizeDescriptorError(
  snapshot: DescriptorChainSnapshot,
): LlmDebugLogError {
  const nativeCode = readNativeDomExceptionField(snapshot, "code")
  const codeValue = nativeCode ?? readErrorField(snapshot, "code")
  const code =
    typeof codeValue === "string" || typeof codeValue === "number" ?
      codeValue
    : undefined
  const errnoValue = readErrorField(snapshot, "errno")
  const path = readErrorPath(readErrorField(snapshot, "path"))
  const stack = readDebugErrorString(snapshot, "stack")

  return {
    message: readDebugErrorMessage(snapshot),
    name: readDebugErrorName(snapshot),
    ...(stack ? { stack } : {}),
    ...(code === undefined ? {} : { code }),
    ...(typeof errnoValue === "number" ? { errno: errnoValue } : {}),
    ...(path === undefined ? {} : { path }),
  }
}

function readErrorPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function normalizeError(error: unknown): LlmDebugLogError {
  const snapshot = snapshotDescriptorChain(error, {
    keys: DEBUG_ERROR_DESCRIPTOR_KEYS,
    maxDepth: DEBUG_ERROR_DESCRIPTOR_DEPTH,
  })
  if (snapshot && typeof error === "object" && error !== null) {
    return normalizeDescriptorError(snapshot)
  }

  return {
    message:
      (
        typeof error === "string"
        || typeof error === "number"
        || typeof error === "boolean"
        || typeof error === "bigint"
      ) ?
        String(error)
      : "Unknown thrown value",
    name: "Error",
  }
}

/** Normalize an arbitrary throwable into the stored debug-log error shape. */
export function toLlmDebugLogError(error: unknown): LlmDebugLogError {
  return normalizeError(error)
}

function toSummary(entry: LlmDebugLogEntry): LlmDebugLogSummary {
  const responseContentType = findHeader(
    entry.response?.headers,
    "content-type",
  )
  return {
    durationMs: entry.durationMs,
    endedAt: entry.endedAt,
    errorMessage:
      entry.error?.message ?? entry.response?.bodyReadError?.message,
    id: entry.id,
    method: entry.request.method,
    model: entry.model,
    path: entry.request.path,
    requestBodyBytes: entry.request.bodyBytes,
    requestId: entry.requestId,
    requestPreview: buildRequestPreview(entry.request.body),
    responseBodyBytes: entry.response?.bodyBytes,
    responseContentType,
    responsePreview: buildResponsePreview(entry.response?.body ?? null),
    responseStatus: entry.response?.status,
    responseStatusText: entry.response?.statusText,
    startedAt: entry.startedAt,
    status: entry.status,
    stream: entry.stream,
  }
}

function findHeader(
  headers: HeaderRecord | undefined,
  expectedName: string,
): string | undefined {
  if (!headers) return undefined
  const expected = expectedName.toLowerCase()
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === expected,
  )
  return match?.[1]
}

function getEntry(id: string): LlmDebugLogEntry | undefined {
  return logIndex.get(id)
}

export function startLlmDebugLog(input: StartLlmDebugLogInput): string {
  const startedAtMs = input.startedAtMs ?? Date.now()
  prune(startedAtMs)

  const requestBody = input.requestBody

  const id = randomUUID()
  insertLog({
    id,
    model: inferModel(requestBody),
    request: {
      body: requestBody,
      bodyBytes: byteLength(requestBody),
      headers: { ...input.requestHeaders },
      method: input.method,
      path: input.path,
      url: input.url,
    },
    requestId: input.requestId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    status: "pending",
    stream: inferStream(requestBody),
  })
  schedulePrune()

  return id
}

export function finishLlmDebugLog(
  id: string,
  response: Omit<LlmDebugLogResponse, "bodyBytes">,
  endedAtMs = Date.now(),
): void {
  prune(endedAtMs)
  const entry = getEntry(id)
  if (!entry || entry.status !== "pending") return

  entry.endedAt = new Date(endedAtMs).toISOString()
  entry.durationMs = endedAtMs - entry.startedAtMs
  entry.response = {
    ...response,
    body: response.body,
    headers: { ...response.headers },
    bodyBytes: byteLength(response.body),
  }
  entry.status =
    response.bodyReadError || response.status < 200 || response.status >= 300 ?
      "error"
    : "complete"
}

export function failLlmDebugLog(
  id: string,
  error: unknown,
  endedAtMs = Date.now(),
): void {
  prune(endedAtMs)
  const entry = getEntry(id)
  if (!entry || entry.status !== "pending") return

  entry.endedAt = new Date(endedAtMs).toISOString()
  entry.durationMs = endedAtMs - entry.startedAtMs
  entry.error = normalizeError(error)
  entry.status = "error"
}

export function abortLlmDebugLog(
  id: string,
  options: AbortLlmDebugLogOptions,
): void {
  const endedAtMs = options.endedAtMs ?? Date.now()
  prune(endedAtMs)
  const entry = getEntry(id)
  if (!entry || entry.status !== "pending") return

  entry.endedAt = new Date(endedAtMs).toISOString()
  entry.durationMs = endedAtMs - entry.startedAtMs
  entry.error = normalizeError(options.error)
  if (options.response) {
    entry.response = {
      ...options.response,
      body: options.response.body,
      headers: { ...options.response.headers },
      bodyBytes: byteLength(options.response.body),
    }
  }
  entry.status = "aborted"
}

export function listLlmDebugLogs(): LlmDebugLogListResponse {
  prune()
  const activeLogs = getActiveLogs()
  return {
    count: activeLogs.length,
    entries: activeLogs.map((entry) => toSummary(entry)).reverse(),
    generatedAt: new Date().toISOString(),
  }
}

export function getLlmDebugLog(id: string): LlmDebugLogEntry | undefined {
  prune()
  const entry = getEntry(id)
  return entry ? cloneEntry(entry) : undefined
}

export function clearLlmDebugLogs(): void {
  logs = []
  logIndex = new Map()
  firstLogIndex = 0
  clearPruneTimer()
}
