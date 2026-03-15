import * as Sentry from "@sentry/bun"
import { Hono } from "hono"
import { cors } from "hono/cors"

import { apiKeyGuard } from "./lib/api-key-guard"
import { createAuthMiddleware } from "./lib/request-auth"
import { requestLogger } from "./lib/request-logger"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { featureFlagsRoutes } from "./routes/feature-flags/route"
import { googleAIRoutes } from "./routes/google-ai/route"
import { growthbookRoutes } from "./routes/growthbook/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import {
  oauthApiRoutes,
  oauthBrowserRoutes,
  oauthTokenRoutes,
} from "./routes/oauth/route"
import { replacementsRoute } from "./routes/replacements/route"
import { responsesRoutes } from "./routes/responses/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

// Global middleware — applied to ALL routes including pre-auth ones
server.use(requestLogger)
server.use(cors())

// Routes that bypass apiKeyGuard and auth middleware
// GrowthBook remote eval — Claude Code's SDK calls this for feature flags
server.route("/api/eval", growthbookRoutes)
// Feature flags admin page (HTML served unauthenticated; API sub-routes have their own auth)
server.route("/feature-flags", featureFlagsRoutes)
// OAuth fake layer — authorize, token exchange, profile
server.route("/oauth", oauthBrowserRoutes)
server.route("/v1/oauth", oauthTokenRoutes)
server.route("/api", oauthApiRoutes)

server.use(apiKeyGuard)
server.use("*", createAuthMiddleware())

server.onError((err, c) => {
  Sentry.captureException(err)
  return c.json({ error: { message: err.message, type: "error" } }, 500)
})

server.get("/", (c) => c.text("Server running"))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/replacements", replacementsRoute)
server.route("/responses", responsesRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
// Google Generative AI compatible endpoints
// Handles POST /v1/models/{model}:generateContent and :streamGenerateContent
server.route("/v1/models", googleAIRoutes)
server.route("/v1beta/models", googleAIRoutes)
server.route("/models", googleAIRoutes)
