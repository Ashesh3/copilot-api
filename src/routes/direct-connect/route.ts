import { Hono } from "hono"

import {
  createDirectConnectSession,
  destroyDirectConnectSession,
  listDirectConnectSessions,
} from "./ws-handler"

export const directConnectRoutes = new Hono()

// POST / — Create a direct-connect session
directConnectRoutes.post("/", async (c) => {
  const body = await c.req.json<{
    cwd?: string
    dangerously_skip_permissions?: boolean
  }>()

  const sessionInfo = createDirectConnectSession(body.cwd)

  return c.json(sessionInfo, 201)
})

// GET /health — Server health check
directConnectRoutes.get("/health", (c) => {
  const sessions = listDirectConnectSessions()
  return c.json({ status: "ok", activeSessions: sessions.length })
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
