import { Hono } from "hono"
import { cors } from "hono/cors"
import { randomUUID } from "node:crypto"

import { apiKeyGuard } from "./lib/api-key-guard"
import { forwardError } from "./lib/error"
import { createAuthMiddleware } from "./lib/request-auth"
import { requestLogger } from "./lib/request-logger"
import {
  clientSessionStorage,
  getQuotaHeaders,
  quotaHeadersStorage,
  requestIdStorage,
  routedAccountStorage,
} from "./lib/request-session"
import { transparentProxy } from "./lib/transparent-proxy"
import { completionRoutes } from "./routes/chat-completions/route"
import { getCodeLauncherPage } from "./routes/code-launcher/page"
import { codeSessionsRoutes } from "./routes/code-sessions/route"
import { dashboardRoutes } from "./routes/dashboard/route"
import { directConnectRoutes } from "./routes/direct-connect/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { environmentsRoutes } from "./routes/environments/route"
import { featureFlagsRoutes } from "./routes/feature-flags/route"
import { googleAIRoutes } from "./routes/google-ai/route"
import { growthbookRoutes } from "./routes/growthbook/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRedirectsRoute } from "./routes/model-redirects/route"
import { modelRoutes } from "./routes/models/route"
import {
  oauthApiRoutes,
  oauthBrowserRoutes,
  oauthTokenRoutes,
} from "./routes/oauth/route"
import { remoteRoutes } from "./routes/remote/route"
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
  const requestId = c.req.header("x-request-id") ?? randomUUID()

  await requestIdStorage.run(requestId, async () => {
    await clientSessionStorage.run(sessionId, async () => {
      await quotaHeadersStorage.run({}, async () => {
        await routedAccountStorage.run({}, async () => {
          await next()

          for (const [key, value] of Object.entries(getQuotaHeaders())) {
            c.header(key, value)
          }
        })
      })
    })
  })

  c.header("x-request-id", requestId)
})

// Routes that bypass apiKeyGuard and auth middleware
// GrowthBook remote eval — Claude Code's SDK calls this for feature flags
server.route("/api/eval", growthbookRoutes)
// Feature flags admin page (HTML served unauthenticated; API sub-routes have their own auth)
server.route("/feature-flags", featureFlagsRoutes)
// Dashboard admin page (HTML served unauthenticated; API sub-routes have their own auth)
server.route("/dashboard", dashboardRoutes)
// Remote Control page (HTML served unauthenticated; uses dashboard API for auth)
server.route("/remote", remoteRoutes)
// OAuth fake layer — authorize, token exchange, profile
server.route("/oauth", oauthBrowserRoutes)
server.route("/v1/oauth", oauthTokenRoutes)
server.route("/api", oauthApiRoutes)
// Code Sessions — Claude Code authenticates via its own bearer tokens
server.route("/v1/code/sessions", codeSessionsRoutes)
// Code triggers and GitHub import (siblings of /v1/code/sessions)
server.get("/v1/code/triggers", (c) => c.json({ triggers: [] }))
server.post("/v1/code/triggers", (c) => c.json({ triggers: [] }))
server.post("/v1/code/github/import-token", (c) => {
  return c.json({ github_username: "copilot-api-user" })
})
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

// Redirect /code/session_* URLs (from Claude Code's remote-control output) to the remote control page
server.get("/code/:sessionKey", (c) => {
  const sessionKey = c.req.param("sessionKey")
  const sessionId =
    sessionKey.startsWith("session_") ?
      `cse_${sessionKey.slice("session_".length)}`
    : sessionKey
  return c.redirect(`/remote?session=${sessionId}`)
})

// Environment launcher at /code?environment=env_xxx (URL Claude Code prints)
server.get("/code", (c) => {
  const envId = c.req.query("environment")
  if (!envId) {
    return c.redirect("/dashboard#environments")
  }
  return c.html(getCodeLauncherPage(envId))
})

// v1 stubs for endpoints Claude Code calls that don't need full implementations
server.get("/v1/environment_providers", (c) => c.json({ environments: [] }))
server.post("/v1/environment_providers/cloud/create", (c) =>
  c.json({ environment: { id: "env_stub", status: "created" } }),
)
server.get("/v1/mcp_servers", (c) => c.json({ data: [] }))
server.get("/v1/session_ingress/session/:id", (c) =>
  c.json({ session_id: c.req.param("id"), status: "active" }),
)
server.get("/v1/ultrareview/quota", (c) => c.json({ remaining: 0, total: 0 }))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/replacements", replacementsRoute)
server.route("/model-redirects", modelRedirectsRoute)
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

server.all("*", transparentProxy)
