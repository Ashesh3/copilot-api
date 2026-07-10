import type { Context, Next } from "hono"

import * as Sentry from "@sentry/bun"

import { getSentryModelName } from "./sentry"
import { state } from "./state"
import { recordUsage } from "./usage-tracker"

/**
 * Request context stored for logging on response
 */
export interface RequestContext {
  startTime: number
  requestedModel?: string
  model?: string
  inputLength?: number
  inputTokens?: number
  outputTokens?: number
  provider?: string
  replacements?: Array<string>
  reasoningEffort?: string
  accountId?: number
  nonDefaultBehaviors?: Array<RequestBehavior>
}

type RequestBehaviorData = Record<
  string,
  string | number | boolean | null | undefined
>

export interface RequestBehavior {
  kind: string
  message: string
  data?: RequestBehaviorData
  sentryLevel?: "info" | "warning"
}

export type LogicalRequestTerminalStatus =
  | "COMPLETE"
  | "ERROR"
  | "REJECTED"
  | "ABORTED"

export interface LogicalRequestTerminalOptions {
  accountId?: number
  error?: unknown
  status: number
  terminalStatus: LogicalRequestTerminalStatus
}

export interface LogicalRequestLifecycle {
  finalize(options: LogicalRequestTerminalOptions): boolean
  isFinalized(): boolean
  update(
    options: Partial<
      Pick<RequestContext, "model" | "reasoningEffort" | "requestedModel">
    >,
  ): void
}

const REQUEST_CONTEXT_KEY = "requestContext"

// ANSI color codes
export const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
}

/**
 * Get the current time formatted as HH:MM:SS
 */
function getTimeString(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

/**
 * Get status color based on HTTP status code
 */
function getStatusColor(status: number): string {
  if (status >= 500) return colors.red
  if (status >= 400) return colors.yellow
  if (status >= 300) return colors.cyan
  return colors.green
}

function getLogicalStatusColor(status: LogicalRequestTerminalStatus): string {
  switch (status) {
    case "COMPLETE": {
      return colors.green
    }
    case "REJECTED": {
      return colors.yellow
    }
    case "ABORTED": {
      return colors.cyan
    }
    case "ERROR": {
      return colors.red
    }
    default: {
      return colors.white
    }
  }
}

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (error === undefined) return undefined
  if (typeof error === "string") return error
  if (
    typeof error === "number"
    || typeof error === "bigint"
    || typeof error === "boolean"
  ) {
    return error.toString()
  }
  try {
    return JSON.stringify(error)
  } catch {
    return "Unknown error"
  }
}

/**
 * Log a request lifecycle that does not pass through Hono middleware, such as
 * a logical request carried by a long-lived WebSocket connection.
 */
export function startLogicalRequestLog(options: {
  inputLength: number
  method: string
  model: string
  path: string
  reasoningEffort?: string
  requestedModel?: string
  transport: string
  turnId: string
}): LogicalRequestLifecycle {
  const startedAt = Date.now()
  const requestContext: RequestContext = {
    inputLength: options.inputLength,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    requestedModel: options.requestedModel,
    startTime: startedAt,
  }
  let finalized = false

  const startedLines = [
    `${colors.dim}${"─".repeat(60)}${colors.reset}`,
    `${colors.blue}${colors.bold}STARTED${colors.reset} ${colors.bold}${options.method}${colors.reset} ${options.path} ${colors.dim}[${options.transport} · ${options.turnId}]${colors.reset}`,
    buildModelLine(requestContext),
  ]
  const modificationsLine = buildModificationsLine(requestContext)
  if (modificationsLine) startedLines.push(modificationsLine)
  startedLines.push(`  ${colors.dim}${getTimeString()}${colors.reset}`)
  console.info(startedLines.join("\n"))
  Sentry.logger.info(
    `STARTED ${options.method} ${options.path} | ${buildPlainModelLine(requestContext)} | ${options.transport} | ${options.turnId}`,
    {
      inputLength: options.inputLength,
      method: options.method,
      model: getSentryModelName(options.model),
      path: options.path,
      reasoningEffort: options.reasoningEffort,
      requestedModel:
        options.requestedModel ?
          getSentryModelName(options.requestedModel)
        : undefined,
      transport: options.transport,
      turnId: options.turnId,
    },
  )

  return {
    finalize(terminalOptions): boolean {
      if (finalized) return false
      finalized = true

      const duration = ((Date.now() - startedAt) / 1000).toFixed(1)
      const ctx = { ...requestContext, accountId: terminalOptions.accountId }
      const terminalColor = getLogicalStatusColor(
        terminalOptions.terminalStatus,
      )
      const lines = [
        `${colors.dim}${"─".repeat(60)}${colors.reset}`,
        `${terminalColor}${colors.bold}${terminalOptions.terminalStatus}${colors.reset} ${colors.bold}${options.method}${colors.reset} ${options.path} ${getStatusColor(terminalOptions.status)}${terminalOptions.status}${colors.reset} ${colors.cyan}${duration}s${colors.reset} ${colors.dim}[${options.transport} · ${options.turnId}]${colors.reset}`,
        buildModelLine(ctx),
      ]
      const terminalModificationsLine = buildModificationsLine(ctx)
      if (terminalModificationsLine) lines.push(terminalModificationsLine)
      const errorMessage = getErrorMessage(terminalOptions.error)
      if (errorMessage) {
        lines.push(`  ${colors.red}${errorMessage}${colors.reset}`)
      }
      lines.push(`  ${colors.dim}${getTimeString()}${colors.reset}`)
      console.info(lines.join("\n"))

      Sentry.logger.info(
        `${terminalOptions.terminalStatus} ${options.method} ${options.path} ${terminalOptions.status} ${duration}s | ${buildPlainModelLine(ctx)} | ${options.transport} | ${options.turnId}`,
        {
          accountId: terminalOptions.accountId,
          duration: Number(duration),
          error: errorMessage,
          inputLength: options.inputLength,
          method: options.method,
          model: ctx.model ? getSentryModelName(ctx.model) : undefined,
          path: options.path,
          reasoningEffort: ctx.reasoningEffort,
          requestedModel:
            ctx.requestedModel ?
              getSentryModelName(ctx.requestedModel)
            : undefined,
          status: terminalOptions.status,
          terminalStatus: terminalOptions.terminalStatus,
          transport: options.transport,
          turnId: options.turnId,
        },
      )
      return true
    },
    isFinalized(): boolean {
      return finalized
    },
    update(next): void {
      if (finalized) return
      Object.assign(requestContext, next)
    },
  }
}

/**
 * Sanitize request body by omitting large message/prompt arrays
 */
function sanitizeRequestBody(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    sanitized[key] =
      key === "messages" || key === "prompt" ?
        `[${Array.isArray(value) ? value.length : 1} items omitted]`
      : value
  }
  return sanitized
}

/**
 * Log raw HTTP request details (for debug mode)
 */
async function logRawRequest(c: Context): Promise<void> {
  const method = c.req.method
  const url = c.req.url
  const headers = Object.fromEntries(c.req.raw.headers.entries())

  const lines: Array<string> = []
  lines.push(
    `${colors.magenta}${colors.bold}[DEBUG] Incoming Request${colors.reset}`,
    `${colors.cyan}${method}${colors.reset} ${url}`,
    `${colors.dim}Headers:${colors.reset}`,
  )

  for (const [key, value] of Object.entries(headers)) {
    // Mask authorization headers
    const displayValue =
      (
        key.toLowerCase().includes("authorization")
        || key.toLowerCase().includes("api-key")
      ) ?
        `${value.slice(0, 20)}...`
      : value
    lines.push(`  ${colors.gray}${key}:${colors.reset} ${displayValue}`)
  }

  // Try to get body info without consuming it
  if (method !== "GET" && method !== "HEAD") {
    try {
      const clonedRequest = c.req.raw.clone()
      const body = await clonedRequest.text()
      if (body) {
        // Parse JSON to extract model, omit messages/prompt
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>
          const sanitized = sanitizeRequestBody(parsed)

          lines.push(
            `${colors.dim}Body (sanitized):${colors.reset}`,
            `  ${JSON.stringify(sanitized, null, 2).split("\n").join("\n  ")}`,
          )
        } catch {
          // Not JSON, show length
          lines.push(`${colors.dim}Body:${colors.reset} [${body.length} bytes]`)
        }
      }
    } catch {
      lines.push(`${colors.dim}Body:${colors.reset} [unable to read]`)
    }
  }

  lines.push(`${colors.dim}${"─".repeat(60)}${colors.reset}`)
  console.log(lines.join("\n"))
}

/**
 * Set request context for logging
 */
export function setRequestContext(
  c: Context,
  ctx: Partial<Omit<RequestContext, "startTime">>,
): void {
  const existing = c.get(REQUEST_CONTEXT_KEY) as RequestContext | undefined
  if (existing) {
    c.set(REQUEST_CONTEXT_KEY, { ...existing, ...ctx })
  }
}

export function recordNonDefaultBehavior(
  c: Context,
  behavior: RequestBehavior,
): void {
  const existing = c.get(REQUEST_CONTEXT_KEY) as RequestContext | undefined
  const nonDefaultBehaviors = [
    ...(existing?.nonDefaultBehaviors ?? []),
    behavior,
  ]

  c.set(REQUEST_CONTEXT_KEY, {
    ...(existing ?? { startTime: Date.now() }),
    nonDefaultBehaviors,
  } as RequestContext)

  reportNonDefaultBehavior(behavior)
}

export function reportNonDefaultBehavior(behavior: RequestBehavior): void {
  const sentryLevel = behavior.sentryLevel ?? "info"
  const consoleLine = `${colors.yellow}${colors.bold}[NON-DEFAULT]${colors.reset} ${colors.yellow}${behavior.kind}: ${behavior.message}${colors.reset}`
  if (sentryLevel === "warning") {
    console.warn(consoleLine)
  } else {
    console.info(consoleLine)
  }

  Sentry.addBreadcrumb({
    category: "copilot-api.non_default_behavior",
    level: sentryLevel,
    message: behavior.message,
    data: { kind: behavior.kind, ...behavior.data },
  })
  Sentry.getActiveSpan()?.setAttribute(
    `copilot_api.non_default.${behavior.kind}`,
    behavior.message,
  )
  const logContext = {
    kind: behavior.kind,
    sentryLevel,
    ...behavior.data,
  }
  const logMessage = `[NON-DEFAULT] ${behavior.kind}: ${behavior.message}`
  if (sentryLevel === "warning") {
    Sentry.logger.warn(logMessage, logContext)
    Sentry.withScope((scope) => {
      scope.setLevel("warning")
      scope.setTag("copilot_api.non_default_behavior", behavior.kind)
      scope.setContext("non_default_behavior", {
        message: behavior.message,
        ...behavior.data,
      })
      Sentry.captureMessage(logMessage)
    })
    return
  }

  Sentry.logger.info(logMessage, logContext)
  Sentry.withScope((scope) => {
    scope.setTag("copilot_api.non_default_behavior", behavior.kind)
    scope.setContext("non_default_behavior", {
      level: sentryLevel,
      message: behavior.message,
      ...behavior.data,
    })
  })
}

/**
 * Format the input size for display
 */
function formatInputSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`
}

/**
 * Build the model routing log line
 */
function buildModelLine(ctx: RequestContext): string {
  const parts: Array<string> = []

  // Model name(s)
  if (ctx.requestedModel && ctx.requestedModel !== ctx.model) {
    parts.push(
      `${colors.gray}${ctx.requestedModel}${colors.reset} ${colors.dim}→${colors.reset} ${colors.white}${ctx.model}${colors.reset}`,
    )
  } else {
    parts.push(`${colors.white}${ctx.model}${colors.reset}`)
  }

  // Account ID (multi-token mode)
  if (ctx.accountId !== undefined) {
    parts.push(`${colors.cyan}[Account #${ctx.accountId}]${colors.reset}`)
  }

  // API type from provider
  if (ctx.provider) {
    parts.push(
      `${colors.dim}via${colors.reset} ${colors.magenta}${ctx.provider}${colors.reset}`,
    )
  }

  // Input size
  if (ctx.inputLength !== undefined) {
    parts.push(
      `${colors.dim}·${colors.reset} ${colors.yellow}${formatInputSize(ctx.inputLength)}${colors.reset}`,
    )
  }

  return `  ${parts.join(" ")}`
}

/**
 * Build the modifications log line (effort, replacements, tokens)
 */
function buildModificationsLine(ctx: RequestContext): string | undefined {
  const modParts: Array<string> = []

  if (ctx.reasoningEffort) {
    modParts.push(`${colors.blue}effort=${ctx.reasoningEffort}${colors.reset}`)
  }

  if (ctx.replacements && ctx.replacements.length > 0) {
    modParts.push(
      `${colors.green}replace: ${ctx.replacements.join(", ")}${colors.reset}`,
    )
  }

  if (ctx.inputTokens !== undefined) {
    modParts.push(
      `${colors.yellow}${ctx.inputTokens.toLocaleString()} tokens${colors.reset}`,
    )
  }

  if (modParts.length === 0) return undefined
  return `  ${modParts.join(` ${colors.dim}·${colors.reset} `)}`
}

function buildNonDefaultBehaviorLines(ctx: RequestContext): Array<string> {
  return (ctx.nonDefaultBehaviors ?? []).map(
    (behavior) =>
      `  ${colors.yellow}${colors.bold}! ${behavior.kind}${colors.reset} ${colors.yellow}${behavior.message}${colors.reset}`,
  )
}

/**
 * Build a plain-text model line for Sentry (no ANSI codes)
 */
function buildPlainModelLine(ctx: RequestContext): string {
  const parts: Array<string> = []
  const model = ctx.model ? getSentryModelName(ctx.model) : "unknown"
  const requestedModel =
    ctx.requestedModel ? getSentryModelName(ctx.requestedModel) : undefined

  if (requestedModel && requestedModel !== model) {
    parts.push(`${requestedModel} → ${model}`)
  } else {
    parts.push(model)
  }

  if (ctx.accountId !== undefined) {
    parts.push(`[Account #${ctx.accountId}]`)
  }

  if (ctx.provider) {
    parts.push(`via ${ctx.provider}`)
  }

  if (ctx.inputLength !== undefined) {
    parts.push(`· ${formatInputSize(ctx.inputLength)}`)
  }

  return parts.join(" ")
}

/**
 * Build a plain-text modifications line for Sentry (no ANSI codes)
 */
function buildPlainModificationsLine(ctx: RequestContext): string | undefined {
  const modParts: Array<string> = []

  if (ctx.reasoningEffort) {
    modParts.push(`effort=${ctx.reasoningEffort}`)
  }

  if (ctx.replacements && ctx.replacements.length > 0) {
    modParts.push(`replace: ${ctx.replacements.join(", ")}`)
  }

  if (ctx.inputTokens !== undefined) {
    modParts.push(`${ctx.inputTokens.toLocaleString()} tokens`)
  }

  if (modParts.length === 0) return undefined
  return modParts.join(" · ")
}

function buildPlainNonDefaultBehaviors(
  ctx: RequestContext,
): string | undefined {
  const behaviors = ctx.nonDefaultBehaviors ?? []
  if (behaviors.length === 0) return undefined
  return behaviors
    .map((behavior) => `${behavior.kind}: ${behavior.message}`)
    .join(" ; ")
}

/**
 * Send enriched request log to Sentry (plain text, no ANSI codes)
 */
function sendRequestLogToSentry(opts: {
  method: string
  path: string
  status: number
  duration: string
  ctx: RequestContext | undefined
}): void {
  const { method, path, status, duration, ctx } = opts
  const sentryParts: Array<string> = [
    `${method} ${path} ${status} ${duration}s`,
  ]
  if (ctx?.model) {
    sentryParts.push(buildPlainModelLine(ctx))
  }
  if (ctx) {
    const modsLine = buildPlainModificationsLine(ctx)
    if (modsLine) sentryParts.push(modsLine)
    const behaviorLine = buildPlainNonDefaultBehaviors(ctx)
    if (behaviorLine) sentryParts.push(`NON-DEFAULT: ${behaviorLine}`)
  }
  Sentry.logger.info(sentryParts.join(" | "), {
    method,
    path,
    status,
    duration: Number(duration),
    model: ctx?.model ? getSentryModelName(ctx.model) : undefined,
    requestedModel:
      ctx?.requestedModel ? getSentryModelName(ctx.requestedModel) : undefined,
    provider: ctx?.provider,
    inputTokens: ctx?.inputTokens,
    accountId: ctx?.accountId,
    nonDefaultBehaviors: ctx?.nonDefaultBehaviors?.map(
      (behavior) => `${behavior.kind}: ${behavior.message}`,
    ),
  })
}

/**
 * Custom request logger middleware
 */
export async function requestLogger(c: Context, next: Next): Promise<void> {
  // Log raw request in debug mode
  if (state.debug) {
    await logRawRequest(c)
  }

  const startTime = Date.now()
  const method = c.req.method
  const path =
    c.req.path
    + (c.req.raw.url.includes("?") ? "?" + c.req.raw.url.split("?")[1] : "")

  // Initialize request context
  const contentLength = c.req.header("content-length")
  c.set(REQUEST_CONTEXT_KEY, {
    startTime,
    inputLength: contentLength ? Number(contentLength) : undefined,
  } as RequestContext)

  await next()

  // Skip logging for noisy telemetry endpoints
  if (path.startsWith("/api/event_logging/")) return

  // Get context that may have been set during request handling
  const ctx = c.get(REQUEST_CONTEXT_KEY) as RequestContext | undefined
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  const status = c.res.status
  const statusColor = getStatusColor(status)

  // Build the log block
  const lines: Array<string> = []

  // Separator
  lines.push(`${colors.dim}${"─".repeat(60)}${colors.reset}`)

  // Main request line: method, path, status, duration
  const statusBadge = `${statusColor}${status}${colors.reset}`
  const durationStr = `${colors.cyan}${duration}s${colors.reset}`
  lines.push(
    `${colors.bold}${method}${colors.reset} ${path} ${statusBadge} ${durationStr}`,
  )

  // Model routing line
  if (ctx?.model) {
    lines.push(buildModelLine(ctx))
  }

  // Applied modifications line
  if (ctx) {
    const modsLine = buildModificationsLine(ctx)
    if (modsLine) lines.push(modsLine)
    lines.push(...buildNonDefaultBehaviorLines(ctx))
  }

  // Timestamp
  lines.push(`  ${colors.dim}${getTimeString()}${colors.reset}`)

  // Record token usage for the usage tracker
  if (ctx?.inputTokens || ctx?.outputTokens) {
    recordUsage(ctx.inputTokens ?? 0, ctx.outputTokens ?? 0, ctx.model)
  }

  // Print all lines to terminal
  console.log(lines.join("\n"))

  // Send enriched log to Sentry
  sendRequestLogToSentry({ method, path, status, duration, ctx })
}

/**
 * Log token usage (for streaming responses where tokens are known after stream completes)
 */
export function logTokenUsage(inputTokens: number, outputTokens: number): void {
  const parts: Array<string> = []
  parts.push(
    `  ${colors.gray}Tokens:${colors.reset} ${colors.yellow}${inputTokens.toLocaleString()} in${colors.reset} ${colors.gray}/${colors.reset} ${colors.green}${outputTokens.toLocaleString()} out${colors.reset}`,
  )
  console.log(parts.join(""))

  Sentry.logger.info(
    `Tokens: ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out`,
    { inputTokens, outputTokens },
  )
}
