import { Hono } from "hono"

import { requireIpAllowlist } from "~/lib/ip-allowlist-guard"

import { createSession } from "../code-sessions/session-store"
import {
  acknowledgeWork,
  deregisterEnvironment,
  enqueueWork,
  getEnvironment,
  pollForWork,
  registerEnvironment,
  stopWork,
} from "./environment-store"

export const environmentsRoutes = new Hono()

// Bridge registration, work polling, and session enqueue all run pre-auth.
// Gate the whole surface on the IP allowlist so only known machines can
// register as a bridge or pull work items.
environmentsRoutes.use("*", requireIpAllowlist)

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

// POST /:id/work — Enqueue work (start a session in the environment)
environmentsRoutes.post("/:id/work", async (c) => {
  const envId = c.req.param("id")
  const env = getEnvironment(envId)
  if (!env) {
    return c.json({ error: "Environment not found" }, 404)
  }

  const body = await c.req
    .json<{ title?: string }>()
    .catch(() => ({ title: undefined }))
  const session = createSession(
    body.title ?? `Session in ${env.machineName}`,
    [],
  )

  const protocol =
    c.req.header("x-forwarded-proto")
    ?? (c.req.url.startsWith("https") ? "https" : "https")
  const host = c.req.header("host") ?? "localhost"
  const apiBaseUrl = `${protocol}://${host}`

  const workItem = enqueueWork({ envId, sessionId: session.id, apiBaseUrl })
  if (!workItem) {
    return c.json({ error: "Failed to enqueue work" }, 500)
  }

  return c.json({
    work: workItem,
    session: { id: session.id, title: session.title },
  })
})
