import { Hono } from "hono"

import {
  extractClientIp,
  isIpBlocked,
  recordFailedAttempt,
} from "~/lib/ip-blocker"
import { extractRequestApiKey } from "~/lib/request-auth"
import { state } from "~/lib/state"

import {
  handleAddReplacement,
  handleArchiveSession,
  handleDeleteFlag,
  handleDeleteReplacement,
  handleDeregisterEnvironment,
  handleDestroySession,
  handleGetSessionEvents,
  handleGetSettings,
  handleGetUsage,
  handleListEnvironments,
  handleListFlags,
  handleListReplacements,
  handleListSessions,
  handleOverview,
  handleSetFlag,
  handleStartEnvironmentSession,
  handleToggleReplacement,
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

// Usage
dashboardRoutes.get("/api/usage", handleGetUsage)

// Settings
dashboardRoutes.get("/api/settings", handleGetSettings)
