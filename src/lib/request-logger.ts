import type { Context, Next } from "hono"

import { state } from "./state"

/**
 * Request context stored for logging on response
 */
export interface RequestContext {
  startTime: number
  model?: string
  inputTokens?: number
  outputTokens?: number
  provider?: "Copilot" | "Azure OpenAI"
}

const REQUEST_CONTEXT_KEY = "requestContext"

// ANSI color codes
const colors = {
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
 * Log raw HTTP request details (for debug mode)
 */
async function logRawRequest(c: Context): Promise<void> {
  const method = c.req.method
  const url = c.req.url
  const headers = Object.fromEntries(c.req.raw.headers.entries())

  const lines: string[] = []
  lines.push(`${colors.magenta}${colors.bold}[DEBUG] Incoming Request${colors.reset}`)
  lines.push(`${colors.cyan}${method}${colors.reset} ${url}`)
  lines.push(`${colors.dim}Headers:${colors.reset}`)

  for (const [key, value] of Object.entries(headers)) {
    // Mask authorization headers
    const displayValue = key.toLowerCase().includes("authorization")
      ? `${value.slice(0, 20)}...`
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
          const parsed = JSON.parse(body)
          const sanitized: Record<string, unknown> = {}

          for (const [key, value] of Object.entries(parsed)) {
            if (key === "messages" || key === "prompt") {
              sanitized[key] = `[${Array.isArray(value) ? value.length : 1} items omitted]`
            } else {
              sanitized[key] = value
            }
          }

          lines.push(`${colors.dim}Body (sanitized):${colors.reset}`)
          lines.push(`  ${JSON.stringify(sanitized, null, 2).split("\n").join("\n  ")}`)
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
    c.req.path +
    (c.req.raw.url.includes("?") ? "?" + c.req.raw.url.split("?")[1] : "")

  // Initialize request context
  c.set(REQUEST_CONTEXT_KEY, { startTime } as RequestContext)

  await next()

  // Get context that may have been set during request handling
  const ctx = c.get(REQUEST_CONTEXT_KEY) as RequestContext | undefined
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  const status = c.res.status
  const statusColor = getStatusColor(status)

  // Build the log block
  const lines: string[] = []

  // Separator
  lines.push(`${colors.dim}${"─".repeat(60)}${colors.reset}`)

  // Main request line: method, path, status, duration
  const statusBadge = `${statusColor}${status}${colors.reset}`
  const durationStr = `${colors.cyan}${duration}s${colors.reset}`
  lines.push(
    `${colors.bold}${method}${colors.reset} ${path} ${statusBadge} ${durationStr}`,
  )

  // Provider and model info
  if (ctx?.provider && ctx?.model) {
    const providerColor =
      ctx.provider === "Azure OpenAI" ? colors.blue : colors.magenta
    lines.push(
      `  ${colors.gray}Provider:${colors.reset} ${providerColor}${ctx.provider}${colors.reset} ${colors.gray}->${colors.reset} ${colors.white}${ctx.model}${colors.reset}`,
    )
  }

  // Token info
  if (ctx?.inputTokens !== undefined || ctx?.outputTokens !== undefined) {
    const tokenParts: string[] = []
    if (ctx.inputTokens !== undefined) {
      tokenParts.push(
        `${colors.gray}Input:${colors.reset} ${colors.yellow}${ctx.inputTokens.toLocaleString()}${colors.reset}`,
      )
    }
    if (ctx.outputTokens !== undefined) {
      tokenParts.push(
        `${colors.gray}Output:${colors.reset} ${colors.green}${ctx.outputTokens.toLocaleString()}${colors.reset}`,
      )
    }
    lines.push(`  ${tokenParts.join("  ")}`)
  }

  // Timestamp
  lines.push(`  ${colors.dim}${getTimeString()}${colors.reset}`)

  // Print all lines
  console.log(lines.join("\n"))
}
