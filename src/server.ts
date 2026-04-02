import { Hono } from "hono"
import { cors } from "hono/cors"

import { apiKeyGuard } from "./lib/api-key-guard"
import { forwardError } from "./lib/error"
import { createAuthMiddleware } from "./lib/request-auth"
import { requestLogger } from "./lib/request-logger"
import { clientSessionStorage } from "./lib/request-session"
import { completionRoutes } from "./routes/chat-completions/route"
import { codeSessionsRoutes } from "./routes/code-sessions/route"
import { directConnectRoutes } from "./routes/direct-connect/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { environmentsRoutes } from "./routes/environments/route"
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
import { sessionsRoutes } from "./routes/sessions/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

// Global middleware — applied to ALL routes including pre-auth ones
server.use(requestLogger)
server.use(cors())

// Capture X-Claude-Code-Session-Id for session-affinity routing in multi-token mode
server.use("*", async (c, next) => {
  const sessionId = c.req.header("x-claude-code-session-id")
  await clientSessionStorage.run(sessionId, next)
})

// Routes that bypass apiKeyGuard and auth middleware
// GrowthBook remote eval — Claude Code's SDK calls this for feature flags
server.route("/api/eval", growthbookRoutes)
// Feature flags admin page (HTML served unauthenticated; API sub-routes have their own auth)
server.route("/feature-flags", featureFlagsRoutes)
// OAuth fake layer — authorize, token exchange, profile
server.route("/oauth", oauthBrowserRoutes)
server.route("/v1/oauth", oauthTokenRoutes)
server.route("/api", oauthApiRoutes)
// Code Sessions — Claude Code authenticates via its own bearer tokens
server.route("/v1/code/sessions", codeSessionsRoutes)
// Sessions compat layer — used by v1 and v2 bridges
server.route("/v1/sessions", sessionsRoutes)
// Bridge Environments — v1 poll-based Remote Control protocol
server.route("/v1/environments", environmentsRoutes)
// Direct Connect — WebSocket session management for --server mode
server.route("/sessions", directConnectRoutes)
server.route("/health", directConnectRoutes)

server.use(apiKeyGuard)
server.use("*", createAuthMiddleware())

server.onError(async (err, c) => {
  return await forwardError(c, err)
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
