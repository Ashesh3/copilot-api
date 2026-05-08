import { randomUUID } from "node:crypto"

export const LLM_DEBUG_LOG_RETENTION_MS = 10 * 60 * 1000

type HeaderRecord = Record<string, string>

export interface LlmDebugLogError {
  message: string
  name: string
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
  status: "pending" | "complete" | "error"
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
  retentionMs: number
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

const logs: Array<LlmDebugLogEntry> = []

function byteLength(value: string | null): number {
  if (value === null) return 0
  return new TextEncoder().encode(value).byteLength
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3)}...`
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
  return truncate(compactWhitespace(jsonPreview ?? body), 320)
}

function buildResponsePreview(body: string | null): string | undefined {
  if (!body) return undefined
  return truncate(compactWhitespace(body), 320)
}

function prune(nowMs = Date.now()): void {
  const cutoff = nowMs - LLM_DEBUG_LOG_RETENTION_MS
  while (logs.length > 0 && logs[0]?.startedAtMs < cutoff) {
    logs.shift()
  }
}

function cloneEntry(entry: LlmDebugLogEntry): LlmDebugLogEntry {
  return structuredClone(entry)
}

function normalizeError(error: unknown): LlmDebugLogError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name || "Error",
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }

  return {
    message: String(error),
    name: "Error",
  }
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
  return logs.find((entry) => entry.id === id)
}

export function startLlmDebugLog(input: StartLlmDebugLogInput): string {
  const startedAtMs = input.startedAtMs ?? Date.now()
  prune(startedAtMs)

  const id = randomUUID()
  logs.push({
    id,
    model: inferModel(input.requestBody),
    request: {
      body: input.requestBody,
      bodyBytes: byteLength(input.requestBody),
      headers: { ...input.requestHeaders },
      method: input.method,
      path: input.path,
      url: input.url,
    },
    requestId: input.requestId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    status: "pending",
    stream: inferStream(input.requestBody),
  })

  return id
}

export function finishLlmDebugLog(
  id: string,
  response: Omit<LlmDebugLogResponse, "bodyBytes">,
  endedAtMs = Date.now(),
): void {
  prune(endedAtMs)
  const entry = getEntry(id)
  if (!entry) return

  entry.endedAt = new Date(endedAtMs).toISOString()
  entry.durationMs = endedAtMs - entry.startedAtMs
  entry.response = {
    ...response,
    headers: { ...response.headers },
    bodyBytes: byteLength(response.body),
  }
  entry.status = response.bodyReadError ? "error" : "complete"
}

export function failLlmDebugLog(
  id: string,
  error: unknown,
  endedAtMs = Date.now(),
): void {
  prune(endedAtMs)
  const entry = getEntry(id)
  if (!entry) return

  entry.endedAt = new Date(endedAtMs).toISOString()
  entry.durationMs = endedAtMs - entry.startedAtMs
  entry.error = normalizeError(error)
  entry.status = "error"
}

export function listLlmDebugLogs(): LlmDebugLogListResponse {
  prune()
  return {
    count: logs.length,
    entries: logs.map((entry) => toSummary(entry)).reverse(),
    generatedAt: new Date().toISOString(),
    retentionMs: LLM_DEBUG_LOG_RETENTION_MS,
  }
}

export function getLlmDebugLog(id: string): LlmDebugLogEntry | undefined {
  prune()
  const entry = getEntry(id)
  return entry ? cloneEntry(entry) : undefined
}

export function clearLlmDebugLogs(): void {
  logs.length = 0
}
