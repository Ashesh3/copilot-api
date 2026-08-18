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
  if (Array.isArray(value)) return `[${value.length} items omitted]`
  if (value instanceof Error) return { name: value.name }
  if (typeof value !== "object" || value === null) return value

  const sanitized: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = sanitizeHandlerLogValue(nestedValue)
  }
  return sanitized
}

function sanitizeHandlerLogMessage(value: string): string {
  if (value.includes(":") || value.includes(",")) {
    const prefix = value.split(/[:,]/, 1)[0]?.trim()
    if (prefix) return prefix
  }
  if (/[0-9_/@.[\]-]/.test(value)) {
    return value.split(" ").slice(0, 3).join(" ") || "Log"
  }
  return value
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
