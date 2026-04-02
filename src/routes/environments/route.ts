import { Hono } from "hono"

import {
  acknowledgeWork,
  deregisterEnvironment,
  pollForWork,
  registerEnvironment,
  stopWork,
} from "./environment-store"

export const environmentsRoutes = new Hono()

// POST /bridge — Register bridge environment
environmentsRoutes.post("/bridge", async (c) => {
  const body = await c.req.json<{
    machine_name: string
    directory: string
    branch: string
    git_repo_url?: string | null
    max_sessions?: number
    metadata?: Record<string, unknown>
    environment_id?: string
  }>()

  const result = registerEnvironment(body)
  return c.json(result)
})

// DELETE /bridge/:id — Deregister environment
environmentsRoutes.delete("/bridge/:id", (c) => {
  const id = c.req.param("id")
  deregisterEnvironment(id)
  return c.body(null, 204)
})

// GET /:id/work/poll — Poll for work
environmentsRoutes.get("/:id/work/poll", (c) => {
  const id = c.req.param("id")
  const item = pollForWork(id)
  if (!item) {
    return c.body(null, 204)
  }
  return c.json(item)
})

// POST /:id/work/:workId/ack — Acknowledge work
environmentsRoutes.post("/:id/work/:workId/ack", (c) => {
  const id = c.req.param("id")
  const workId = c.req.param("workId")
  const ok = acknowledgeWork(id, workId)
  if (!ok) {
    return c.json({ error: "work item not found" }, 404)
  }
  return c.json({ ok: true })
})

// POST /:id/work/:workId/stop — Stop work
environmentsRoutes.post("/:id/work/:workId/stop", (c) => {
  const id = c.req.param("id")
  const workId = c.req.param("workId")
  const ok = stopWork(id, workId)
  if (!ok) {
    return c.json({ error: "work item not found" }, 404)
  }
  return c.json({ ok: true })
})

// POST /:id/work/:workId/heartbeat — Heartbeat
environmentsRoutes.post("/:id/work/:workId/heartbeat", (c) => {
  return c.json({ lease_extended: true, state: "active", ttl_seconds: 60 })
})

// POST /:id/bridge/reconnect — Reconnect session
environmentsRoutes.post("/:id/bridge/reconnect", (c) => {
  return c.json({ ok: true })
})
