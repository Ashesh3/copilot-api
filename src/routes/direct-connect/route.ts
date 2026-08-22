import { Hono } from "hono"

import { resolveRequestCredential } from "~/lib/credential-resolver"
import { resolveProtectedCredential } from "~/lib/protected-credential"
import { resolvePublicOrigin } from "~/lib/public-origin"
import { readRequestJson } from "~/lib/request-json"

import {
  createDirectConnectSession,
  destroyDirectConnectSession,
  listDirectConnectSessions,
} from "./ws-handler"

export const directConnectRoutes = new Hono()

export function isDirectConnectEnabled(): boolean {
  return process.env.COPILOT_API_ENABLE_DIRECT_CONNECT === "true"
}

// Direct Connect is an experimental private-development surface. Even when a
// caller imports this router directly, keep it unavailable unless explicitly
// enabled. The server mounts it behind the normal API authentication guards.
directConnectRoutes.use("*", async (c, next) => {
  if (!isDirectConnectEnabled()) {
    return c.json({ error: "Not found" }, 404)
  }

  const auth = await resolveProtectedCredential(
    c.req.raw,
    async () => await resolveRequestCredential(c.req.raw, ["user:inference"]),
  )
  if (auth.status !== "authorized") {
    c.header("Cache-Control", "no-store")
    return c.json({ error: "Unauthorized" }, 401)
  }

  await next()
})

// POST / — Create a direct-connect session
directConnectRoutes.post("/", async (c) => {
  const parsed = await readRequestJson(() =>
    c.req.json<{
      cwd?: string
      dangerously_skip_permissions?: boolean
    }>(),
  )
  if (!parsed.ok) return c.json({ error: "Invalid JSON" }, 400)
  const body = parsed.value

  const sessionInfo = createDirectConnectSession(
    resolvePublicOrigin(c.req.raw),
    body.cwd,
  )

  return c.json(sessionInfo, 201)
})

// GET /api/sessions — List all sessions
directConnectRoutes.get("/api/sessions", (c) => {
  const sessions = listDirectConnectSessions()
  return c.json(sessions.map((s) => ({ id: s.id, createdAt: s.createdAt })))
})

// DELETE /api/sessions/:id — Destroy a session
directConnectRoutes.delete("/api/sessions/:id", (c) => {
  const id = c.req.param("id")
  const deleted = destroyDirectConnectSession(id)

  if (!deleted) {
    return c.json({ error: "Session not found" }, 404)
  }

  return c.body(null, 204)
})
