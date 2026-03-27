import type { TRPCContext } from "@breadcrumb/server"

import { appRouter } from "@breadcrumb/server"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { cors } from "hono/cors"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { apiKeyGuard } from "./lib/api-key-guard"
import { forwardError } from "./lib/error"
import { createAuthMiddleware } from "./lib/request-auth"
import { requestLogger } from "./lib/request-logger"
import { getTraceDb } from "./lib/trace-db"
import { tracesAuthMiddleware } from "./lib/traces-auth"
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

// Resolve breadcrumb web app dist directory
// Uses BREADCRUMB_DIST env var if set, otherwise resolves relative to the
// @breadcrumb/server package location (sibling apps/web/dist directory).
const BREADCRUMB_DIST = (() => {
  if (process.env.BREADCRUMB_DIST) return process.env.BREADCRUMB_DIST
  // import.meta.resolve gives a file:// URL to the package entry
  const serverEntry = import.meta.resolve("@breadcrumb/server")
  const serverDir = dirname(fileURLToPath(serverEntry))
  // serverDir = .../services/server/src → go up to breadcrumb root, then apps/web/dist
  return resolve(serverDir, "..", "..", "..", "apps", "web", "dist")
})()

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

// === Traces UI (Breadcrumb) — has its own auth, bypasses apiKeyGuard ===
server.use("/traces/*", tracesAuthMiddleware)

// tRPC handler for trace data queries
server.all("/traces/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/traces/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: (): TRPCContext => ({ db: getTraceDb() }),
  })
})

// Serve static assets from the Breadcrumb web app dist
server.get(
  "/traces/assets/*",
  serveStatic({
    root: BREADCRUMB_DIST,
    rewriteRequestPath: (path) => path.replace(/^\/traces/, ""),
  }),
)

// Serve static files at /traces/ root (favicon, icons, etc.)
server.get(
  "/traces/bread_favicon.svg",
  serveStatic({
    root: BREADCRUMB_DIST,
    rewriteRequestPath: (path) => path.replace(/^\/traces/, ""),
  }),
)
server.get(
  "/traces/bread_icon.svg",
  serveStatic({
    root: BREADCRUMB_DIST,
    rewriteRequestPath: (path) => path.replace(/^\/traces/, ""),
  }),
)
server.get(
  "/traces/favicon.svg",
  serveStatic({
    root: BREADCRUMB_DIST,
    rewriteRequestPath: (path) => path.replace(/^\/traces/, ""),
  }),
)

// SPA fallback — serve index.html for all other /traces routes (client-side routing)
server.get("/traces", async (c) => {
  const indexPath = join(BREADCRUMB_DIST, "index.html")
  const file = Bun.file(indexPath)
  return c.html(await file.text())
})
server.get("/traces/*", async (c) => {
  const path = c.req.path
  // Don't serve index.html for API or asset paths that weren't found
  if (path.startsWith("/traces/api/") || path.startsWith("/traces/assets/")) {
    return c.notFound()
  }
  const indexPath = join(BREADCRUMB_DIST, "index.html")
  const file = Bun.file(indexPath)
  return c.html(await file.text())
})

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
