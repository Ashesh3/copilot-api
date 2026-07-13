import { Hono } from "hono"

import {
  authorizeEnvironmentCapability,
  issueEnvironmentCapability,
  revokeEnvironmentCapabilities,
} from "~/lib/bridge-capabilities"
import { resolveRequestCredential } from "~/lib/credential-resolver"
import { resolveProtectedCredential } from "~/lib/protected-credential"

import { createSession } from "../code-sessions/session-store"
import {
  acknowledgeWork,
  deregisterEnvironment,
  enqueueWork,
  generateEnvironmentId,
  getEnvironment,
  pollForWork,
  registerEnvironment,
  stopWork,
} from "./environment-store"

export const environmentsRoutes = new Hono()

function unauthorized(c: {
  json(value: unknown, status: 401): Response
}): Response {
  return c.json({ error: "Unauthorized" }, 401)
}

async function requireOAuth(request: Request): Promise<boolean> {
  const auth = await resolveProtectedCredential(
    request,
    async () =>
      await resolveRequestCredential(request, ["user:sessions:claude_code"]),
  )
  return auth.status === "authorized"
}

async function requireEnvironmentCapability(
  request: Request,
  environmentId: string,
): Promise<boolean> {
  const auth = await resolveProtectedCredential(request, async () => {
    const allowed = await authorizeEnvironmentCapability(request, environmentId)
    return allowed ? true : null
  })
  return auth.status === "authorized"
}

// POST /bridge — Register bridge environment
environmentsRoutes.post("/bridge", async (c) => {
  if (!(await requireOAuth(c.req.raw))) return unauthorized(c)
  const body = await c.req.json<{
    machine_name: string
    directory: string
    branch: string
    git_repo_url?: string | null
    max_sessions?: number
    metadata?: Record<string, unknown>
    environment_id?: string
  }>()

  const environmentId = body.environment_id ?? generateEnvironmentId()
  const secret = issueEnvironmentCapability(environmentId)
  const result = registerEnvironment({
    ...body,
    environment_id: environmentId,
    secret,
  })
  return c.json(result)
})

// DELETE /bridge/:id — Deregister environment
environmentsRoutes.delete("/bridge/:id", async (c) => {
  const id = c.req.param("id")
  if (!(await requireOAuth(c.req.raw))) return unauthorized(c)
  deregisterEnvironment(id)
  revokeEnvironmentCapabilities(id)
  return c.body(null, 204)
})

// GET /:id/work/poll — Poll for work
environmentsRoutes.get("/:id/work/poll", async (c) => {
  const id = c.req.param("id")
  if (!(await requireEnvironmentCapability(c.req.raw, id))) {
    return unauthorized(c)
  }
  const item = pollForWork(id)
  if (!item) {
    return c.body(null, 204)
  }
  return c.json(item)
})

// POST /:id/work/:workId/ack — Acknowledge work
environmentsRoutes.post("/:id/work/:workId/ack", async (c) => {
  const id = c.req.param("id")
  if (!(await requireEnvironmentCapability(c.req.raw, id))) {
    return unauthorized(c)
  }
  const workId = c.req.param("workId")
  const ok = acknowledgeWork(id, workId)
  if (!ok) {
    return c.json({ error: "work item not found" }, 404)
  }
  return c.json({ ok: true })
})

// POST /:id/work/:workId/stop — Stop work
environmentsRoutes.post("/:id/work/:workId/stop", async (c) => {
  const id = c.req.param("id")
  if (!(await requireEnvironmentCapability(c.req.raw, id))) {
    return unauthorized(c)
  }
  const workId = c.req.param("workId")
  const ok = stopWork(id, workId)
  if (!ok) {
    return c.json({ error: "work item not found" }, 404)
  }
  return c.json({ ok: true })
})

// POST /:id/work/:workId/heartbeat — Heartbeat
environmentsRoutes.post("/:id/work/:workId/heartbeat", async (c) => {
  if (!(await requireEnvironmentCapability(c.req.raw, c.req.param("id")))) {
    return unauthorized(c)
  }
  return c.json({ lease_extended: true, state: "active", ttl_seconds: 60 })
})

// POST /:id/bridge/reconnect — Reconnect session
environmentsRoutes.post("/:id/bridge/reconnect", async (c) => {
  if (!(await requireEnvironmentCapability(c.req.raw, c.req.param("id")))) {
    return unauthorized(c)
  }
  return c.json({ ok: true })
})

// POST /:id/work — Enqueue work (start a session in the environment)
environmentsRoutes.post("/:id/work", async (c) => {
  const envId = c.req.param("id")
  if (!(await requireOAuth(c.req.raw))) return unauthorized(c)
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
