import * as Sentry from "@sentry/bun"

import packageJson from "../../package.json" with { type: "json" }

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return

  Sentry.init({
    dsn,
    release: `copilot-api@${packageJson.version}`,
    environment: process.env.NODE_ENV ?? "development",
    enableLogs: true,
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
}

export function setupSentryShutdown(): void {
  process.on("SIGTERM", async () => {
    await Sentry.close(2000)
    process.exit(0)
  })
}
