import { Hono, type Context } from "hono"

import {
  extractClientIp,
  isIpBlocked,
  recordFailedAttempt,
  whitelistIp,
} from "~/lib/ip-blocker"
import { extractRequestApiKey } from "~/lib/request-auth"
import { state } from "~/lib/state"

import { getFeatureFlagsPage } from "./page"
import {
  getFeatureFlags,
  removeFeatureFlag,
  setFeatureFlag,
  type FeatureFlagValue,
} from "./store"

export const featureFlagsRoutes = new Hono()

// Serve the admin page (no auth on HTML; the page prompts for the API key
// which gates every /feature-flags/api call. Brute-force is bounded by the
// shared 3-strikes IP ban in apiKeyGuard.)
featureFlagsRoutes.get("/", (c) => {
  return c.html(getFeatureFlagsPage())
})

// Auth guard for API routes — reuses the same apiKeyAuth + IP ban mechanism
featureFlagsRoutes.use("/api", async (c: Context, next) => {
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

// GET /feature-flags/api — list all flags
featureFlagsRoutes.get("/api", (c) => {
  return c.json(getFeatureFlags())
})

// POST /feature-flags/api — set a flag
featureFlagsRoutes.post("/api", async (c) => {
  const body = await c.req.json<{ name: string; value: FeatureFlagValue }>()

  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }

  setFeatureFlag(body.name, body.value)
  return c.json({ success: true })
})

// DELETE /feature-flags/api — remove a flag
featureFlagsRoutes.delete("/api", async (c) => {
  const body = await c.req.json<{ name: string }>()

  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }

  const removed = removeFeatureFlag(body.name)
  if (!removed) {
    return c.json({ error: "Flag not found" }, 404)
  }

  return c.json({ success: true })
})
