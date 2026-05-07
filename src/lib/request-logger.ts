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
