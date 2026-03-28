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

export function setupSentryShutdown(): void {
  process.on("SIGTERM", async () => {
    await Sentry.close(2000)
    process.exit(0)
  })
}
