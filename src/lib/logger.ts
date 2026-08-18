import consola, { type ConsolaInstance } from "consola"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"

import { PATHS } from "./paths"
import { state } from "./state"

const LOG_DIR = path.join(PATHS.APP_DIR, "logs")
const FLUSH_INTERVAL_MS = 1000
const BUFFER_FLUSH_BATCH_SIZE = 100

const logStreams = new Map<string, fs.WriteStream>()
const logBuffers = new Map<string, Array<string>>()
const OMITTED_HANDLER_LOG_OBJECT = "[OBJECT OMITTED]"
const SAFE_HANDLER_LOG_ERROR_NAMES = new Set([
  "AbortError",
  "Error",
  "TypeError",
])
const SAFE_HANDLER_LOG_ENUMS = new Set([
  "aborted",
  "cancelled",
  "chat",
  "completed",
  "complete",
  "connection",
  "error",
  "exhausted",
  "failed",
  "incomplete",
  "messages",
  "network",
  "pending",
  "rejected",
  "response_received",
  "responses",
  "retrying",
  "streaming",
  "/chat/completions",
  "/responses",
  "/v1/messages",
])
const SAFE_HANDLER_LOG_STRING_FIELDS = new Set([
  "destination",
  "errorClass",
  "event",
  "inputKind",
  "outcome",
  "path",
  "provider",
  "reason",
  "source",
  "status",
  "target",
  "terminalStatus",
  "transport",
  "type",
])
const SAFE_HANDLER_LOG_MESSAGES = new Set([
  "Anthropic Beta header present:",
  "ChatCompletions fallback streaming",
  "Compact ChatCompletions result received",
  "Compact request for model:",
  "Compact Responses result received",
  "Copilot raw stream event:",
  "Detected Subagent marker",
  "Forwarding native Responses result",
  "Forwarding native Responses stream",
  "Google AI request payload:",
  "Is compact request:",
  "Native messages stream failed",
  "Non-streaming response from Copilot:",
  "Non-streaming Responses result:",
  "Prepared Anthropic bridge request",
  "Prepared request",
  "Prepared Chat fallback request",
  "Prepared translated Chat request",
  "Prepared translated Responses request",
  "Received Anthropic request",
  "Received Chat fallback response",
  "Received native Messages response",
  "Received non-streaming Chat response",
  "Received non-streaming Responses result",
  "Received Responses request",
  "Reduced oversized Responses fallback compaction payload",
  "Responses raw stream event:",
  "Routing custom model",
  "Responses stream ended without completion; sending error event",
  "Streaming native /v1/messages response",
  "Streaming response from Copilot",
  "Streaming response from Copilot (Responses API)",
  "Translated Anthropic response",
  "Translated custom provider Anthropic response",
  "Translated OpenAI payload:",
  "Translated Responses payload:",
  "Using function tool apply_patch for responses",
])

const ensureLogDirectory = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

export const sanitizeHandlerLogArguments = (args: Array<unknown>) =>
  args.map((arg, index) =>
    index === 0 && typeof arg === "string" ?
      sanitizeHandlerLogMessage(arg)
    : sanitizeHandlerLogValue(arg),
  )

const formatArgs = (args: Array<unknown>) =>
  sanitizeHandlerLogArguments(args)
    .map((arg) =>
      typeof arg === "string" ? arg : (
        util.inspect(arg, { depth: 4, colors: false })
      ),
    )
    .join(" ")

function sanitizeHandlerLogValue(value: unknown): unknown {
  if (typeof value === "string") return "[REDACTED]"
  if (typeof value !== "object" || value === null)
    return sanitizeHandlerLogPrimitive(value)
  if (isHandlerLogProxy(value)) return OMITTED_HANDLER_LOG_OBJECT
  const descriptors = getSafeOwnPropertyDescriptors(value)
  if (!descriptors) return OMITTED_HANDLER_LOG_OBJECT
  if (Array.isArray(value)) return sanitizeHandlerLogArray(descriptors)
  if (value instanceof Error) return sanitizeHandlerLogError(descriptors)
  if (!isPlainHandlerLogRecord(value)) return OMITTED_HANDLER_LOG_OBJECT

  const sanitized: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) {
      sanitized[key] = OMITTED_HANDLER_LOG_OBJECT
      continue
    }
    sanitized[key] = sanitizeHandlerLogField(key, descriptor.value)
  }
  return sanitized
}

function sanitizeHandlerLogPrimitive(value: unknown): unknown {
  return (
      typeof value === "number" || typeof value === "boolean" || value === null
    ) ?
      value
    : "[REDACTED]"
}

function readHandlerLogDescriptorValue(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): unknown {
  if (!Object.hasOwn(descriptors, key)) return undefined
  const descriptor = descriptors[key]
  return "value" in descriptor ? descriptor.value : undefined
}

function sanitizeHandlerLogArray(
  descriptors: Record<string, PropertyDescriptor>,
): string {
  const length = readHandlerLogDescriptorValue(descriptors, "length")
  return typeof length === "number" && Number.isSafeInteger(length) ?
      `[${length} items omitted]`
    : OMITTED_HANDLER_LOG_OBJECT
}

function sanitizeHandlerLogMessage(value: string): string {
  if (SAFE_HANDLER_LOG_MESSAGES.has(value)) return value

  for (const message of SAFE_HANDLER_LOG_MESSAGES) {
    if (value.startsWith(message)) return message.replace(/:$/, "")
  }

  return "Log"
}

function sanitizeHandlerLogField(key: string, value: unknown): unknown {
  if (typeof value !== "string") return sanitizeHandlerLogValue(value)
  if (
    SAFE_HANDLER_LOG_STRING_FIELDS.has(key)
    && SAFE_HANDLER_LOG_ENUMS.has(value)
  ) {
    return value
  }
  return "[REDACTED]"
}

function sanitizeHandlerLogError(
  descriptors: Record<string, PropertyDescriptor>,
): { name: string } {
  const ownName = readHandlerLogDescriptorValue(descriptors, "name")
  if (
    typeof ownName === "string"
    && SAFE_HANDLER_LOG_ERROR_NAMES.has(ownName)
  ) {
    return { name: ownName }
  }
  return { name: "Error" }
}

function isHandlerLogProxy(value: object): boolean {
  try {
    return util.types.isProxy(value)
  } catch {
    return true
  }
}

function getSafeOwnPropertyDescriptors(
  value: object,
): Record<string, PropertyDescriptor> | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value)
  } catch {
    return undefined
  }
}

function isPlainHandlerLogRecord(value: object): boolean {
  try {
    const prototype: unknown = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const sanitizeName = (name: string) => {
  const normalized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

  return normalized === "" ? "handler" : normalized
}

const getLogStream = (filePath: string): fs.WriteStream => {
  let stream = logStreams.get(filePath)
  if (!stream || stream.destroyed) {
    stream = fs.createWriteStream(filePath, { flags: "a" })
    logStreams.set(filePath, stream)

    stream.on("error", (error: unknown) => {
      console.warn("Log stream error", error)
      logStreams.delete(filePath)
    })
  }
  return stream
}

const flushBuffer = (filePath: string) => {
  const buffer = logBuffers.get(filePath)
  if (!buffer || buffer.length === 0) {
    return
  }

  const stream = getLogStream(filePath)
  const content = buffer.join("\n") + "\n"
  stream.write(content, (error) => {
    if (error) {
      console.warn("Failed to write handler log", error)
    }
  })

  logBuffers.set(filePath, [])
}

const flushAllBuffers = () => {
  for (const filePath of logBuffers.keys()) {
    flushBuffer(filePath)
  }
}

const appendLine = (filePath: string, line: string) => {
  let buffer = logBuffers.get(filePath)
  if (!buffer) {
    buffer = []
    logBuffers.set(filePath, buffer)
  }

  buffer.push(line)

  if (buffer.length >= BUFFER_FLUSH_BATCH_SIZE) {
    flushBuffer(filePath)
  }
}

setInterval(flushAllBuffers, FLUSH_INTERVAL_MS).unref()

const cleanup = () => {
  flushAllBuffers()
  for (const stream of logStreams.values()) {
    stream.end()
  }
  logStreams.clear()
  logBuffers.clear()
}

process.on("exit", cleanup)
process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})
process.on("SIGTERM", () => {
  cleanup()
  process.exit(0)
})

export const createHandlerLogger = (name: string): ConsolaInstance => {
  ensureLogDirectory()

  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)

  if (state.verbose) instance.level = 5
  instance.setReporters([])

  instance.addReporter(createHandlerLogReporter({ name, sanitizedName }))

  return instance
}

export function formatHandlerLogLine(options: {
  args: Array<unknown>
  date: Date
  name: string
  tag?: string
  type: string
}): string {
  const timestamp = options.date.toLocaleString("sv-SE", { hour12: false })
  const message = formatArgs(options.args)
  return `[${timestamp}] [${options.type}] [${options.tag || options.name}]${
    message ? ` ${message}` : ""
  }`
}

function createHandlerLogReporter(options: {
  name: string
  sanitizedName: string
}) {
  return {
    log(logObj: {
      args: Array<unknown>
      date: Date
      tag?: string
      type: string
    }) {
      ensureLogDirectory()
      const dateKey = logObj.date.toLocaleDateString("sv-SE")
      const filePath = path.join(
        LOG_DIR,
        `${options.sanitizedName}-${dateKey}.log`,
      )
      appendLine(
        filePath,
        formatHandlerLogLine({ ...logObj, name: options.name }),
      )
    },
  }
}
