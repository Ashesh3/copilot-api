import { Hono } from "hono"

import {
  extractClientIp,
  isIpBlocked,
  recordFailedAttempt,
  whitelistIp,
} from "~/lib/ip-blocker"
import { extractRequestApiKey } from "~/lib/request-auth"
import { state } from "~/lib/state"

import {
  handleAddModelRedirect,
  handleAddNebiusCustomProvider,
  handleAddReplacement,
  handleArchiveSession,
  handleClearLlmDebugLogs,
  handleDeleteCustomProvider,
  handleDeleteFlag,
  handleDeleteModelRedirect,
  handleDeleteModelSettings,
  handleDeleteReplacement,
  handleDeregisterEnvironment,
  handleDestroySession,
  handleGetLlmDebugLog,
  handleGetSessionEvents,
  handleGetSettings,
  handleGetUsage,
  handleListCustomProviders,
  handleListEnvironments,
  handleListFlags,
  handleListLlmDebugLogs,
  handleListModelRedirects,
  handleListModelRouting,
  handleListModelSettings,
  handleListReplacements,
  handleListSessions,
  handleMoveModelRedirect,
  handleOverview,
  handleSetFlag,
  handleSetModelSettings,
  handleSetModelRouting,
  handleStartEnvironmentSession,
  handleToggleModelRedirect,
  handleToggleReplacement,
  handleUpdateModelRedirect,
  handleUpsertCustomProvider,
} from "./api"
import { getDashboardPage } from "./page"

export const dashboardRoutes = new Hono()

// Serve the admin page (no auth needed -- the page handles auth via API calls)
dashboardRoutes.get("/", (c) => {
  return c.html(getDashboardPage())
})

// Auth guard for API routes -- reuses the same apiKeyAuth + IP ban mechanism
dashboardRoutes.use("/api/*", async (c, next) => {
  const clientIp = extractClientIp(c)

  if (clientIp !== null && isIpBlocked(clientIp)) {
    await new Promise(() => {})
    return
  }

  if (!state.apiKeyAuth) {
    await next()
    return
  }

  const requestApiKey = extractRequestApiKey(c)

  if (requestApiKey === state.apiKeyAuth) {
    if (clientIp !== null) {
      whitelistIp(clientIp)
    }
    await next()
    return
  }

  if (clientIp !== null) {
    recordFailedAttempt(clientIp)
  }

  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
})

// Overview
dashboardRoutes.get("/api/overview", handleOverview)

// Sessions
dashboardRoutes.get("/api/sessions", handleListSessions)
dashboardRoutes.post("/api/sessions/:id/archive", handleArchiveSession)
dashboardRoutes.delete("/api/sessions/:id", handleDestroySession)
dashboardRoutes.get("/api/sessions/:id/events", handleGetSessionEvents)

// Environments
dashboardRoutes.get("/api/environments", handleListEnvironments)
dashboardRoutes.delete("/api/environments/:id", handleDeregisterEnvironment)
dashboardRoutes.post(
  "/api/environments/:id/start",
  handleStartEnvironmentSession,
)

// Feature Flags
dashboardRoutes.get("/api/flags", handleListFlags)
dashboardRoutes.post("/api/flags", handleSetFlag)
dashboardRoutes.delete("/api/flags", handleDeleteFlag)

// Replacements
dashboardRoutes.get("/api/replacements", handleListReplacements)
dashboardRoutes.post("/api/replacements", handleAddReplacement)
dashboardRoutes.delete("/api/replacements/:id", handleDeleteReplacement)
dashboardRoutes.patch("/api/replacements/:id", handleToggleReplacement)

// Model Redirects
dashboardRoutes.get("/api/model-redirects", handleListModelRedirects)
dashboardRoutes.post("/api/model-redirects", handleAddModelRedirect)
dashboardRoutes.delete("/api/model-redirects/:id", handleDeleteModelRedirect)
dashboardRoutes.patch("/api/model-redirects/:id", handleUpdateModelRedirect)
dashboardRoutes.patch(
  "/api/model-redirects/:id/toggle",
  handleToggleModelRedirect,
)
dashboardRoutes.post("/api/model-redirects/:id/move", handleMoveModelRedirect)

// Model Settings
dashboardRoutes.get("/api/model-settings", handleListModelSettings)
dashboardRoutes.post("/api/model-settings", handleSetModelSettings)
dashboardRoutes.delete("/api/model-settings/:model", handleDeleteModelSettings)

// Custom Providers
dashboardRoutes.get("/api/custom-providers", handleListCustomProviders)
dashboardRoutes.post("/api/custom-providers", handleUpsertCustomProvider)
dashboardRoutes.post(
  "/api/custom-providers/nebius-qwen3",
  handleAddNebiusCustomProvider,
)
dashboardRoutes.delete("/api/custom-providers/:id", handleDeleteCustomProvider)

// Model Routing
dashboardRoutes.get("/api/model-routing", handleListModelRouting)
dashboardRoutes.post("/api/model-routing", handleSetModelRouting)

// Usage
dashboardRoutes.get("/api/usage", handleGetUsage)

// LLM Debug Logs
dashboardRoutes.get("/api/llm-debug", handleListLlmDebugLogs)
dashboardRoutes.get("/api/llm-debug/:id", handleGetLlmDebugLog)
dashboardRoutes.delete("/api/llm-debug", handleClearLlmDebugLogs)

// Settings
dashboardRoutes.get("/api/settings", handleGetSettings)
