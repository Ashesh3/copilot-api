import * as Sentry from "@sentry/bun"
import consola from "consola"

import packageJson from "../../package.json" with { type: "json" }

/**
 * Check whether AI request/response content (prompts and completions)
 * should be recorded in Sentry spans.
 *
 * Controlled by `SENTRY_AI_RECORD_INPUTS` env var (default: "true").
 * Set to "false" to prevent `gen_ai.request.messages` and
 * `gen_ai.response.text` from being sent to Sentry.
 */
export function shouldRecordAiContent(): boolean {
  const value = process.env.SENTRY_AI_RECORD_INPUTS
  if (value === undefined || value === "") return true
  return value.toLowerCase() !== "false"
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return

  const tracesSampleRate = Number.parseFloat(
    process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1.0",
  )

  Sentry.init({
    dsn,
    release: `copilot-api@${packageJson.version}`,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate:
      Number.isFinite(tracesSampleRate) ? tracesSampleRate : 1.0,
    enableLogs: true,
    integrations: [
      Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
    ],
    beforeSend(event) {
      // Scrub sensitive headers
      if (event.request?.headers) {
        const sensitivePatterns = [
          "authorization",
          "api-key",
          "cookie",
          "x-api-key",
        ]
        const scrubbed: Record<string, string> = {}
        for (const [key, value] of Object.entries(event.request.headers)) {
          const lower = key.toLowerCase()
          if (!sensitivePatterns.some((p) => lower.includes(p))) {
            scrubbed[key] = value
          }
        }
        event.request.headers = scrubbed
      }
      return event
    },
  })

  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason)
  })

  // Pipe consola logs to Sentry
  consola.addReporter(Sentry.createConsolaReporter())

  consola.info("Sentry initialized")
}

/**
 * Map copilot-api model names to canonical model IDs recognized by
 * Sentry's cost calculation (via models.dev / OpenRouter).
 */
const SENTRY_MODEL_MAP: Record<string, string> = {
  // Claude models (copilot uses dots, models.dev uses hyphens)
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4.6-1m": "claude-opus-4-6",
  "claude-opus-4.6-fast": "claude-opus-4-6",
  "claude-opus-4.5": "claude-opus-4-5",
  "claude-opus-4": "claude-opus-4-0",
  "claude-opus-4.1": "claude-opus-4-1",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-sonnet-4": "claude-sonnet-4-0",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-3.5": "claude-3-5-haiku-20241022",
  // GPT models
  "gpt-4.1": "gpt-4.1-2025-04-14",
  "gpt-4.1-mini": "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano": "gpt-4.1-nano-2025-04-14",
  "gpt-4o": "gpt-4o-2024-08-06",
  "gpt-4o-mini": "gpt-4o-mini-2024-07-18",
  // o-series
  o3: "o3-2025-04-16",
  "o3-mini": "o3-mini-2025-01-31",
  "o4-mini": "o4-mini-2025-04-16",
}

export function getSentryModelName(model: string): string {
  return SENTRY_MODEL_MAP[model] ?? model
}

export function setupSentryShutdown(): void {
  process.on("SIGTERM", async () => {
    await Sentry.close(2000)
    process.exit(0)
  })
}
