import consola from "consola"
import { Hono } from "hono"

import { resolveRequestCredential } from "~/lib/credential-resolver"
import { resolveProtectedCredential } from "~/lib/protected-credential"
import { broadcastEvents } from "~/routes/code-sessions/event-bus"
import {
  archiveSession,
  getSession,
  listSessions,
  addClientEvents,
  updateSessionTitle,
} from "~/routes/code-sessions/session-store"

export const sessionsRoutes = new Hono()

sessionsRoutes.use("*", async (c, next) => {
  const auth = await resolveProtectedCredential(
    c.req.raw,
    async () =>
      await resolveRequestCredential(c.req.raw, ["user:sessions:claude_code"]),
  )
  if (auth.status !== "authorized") {
    return c.json({ error: "Unauthorized" }, 401)
  }
  await next()
})
/**
 * Map a compat session ID (session_*) to the internal code-session ID (cse_*).
 * Returns the mapped ID if the input starts with "session_", otherwise returns as-is.
 */
function mapSessionId(id: string): string {
  if (id.startsWith("session_")) {
    return `cse_${id.slice("session_".length)}`
  }
  return id
}

/**
 * Resolve a session by trying the mapped ID first, then the raw ID.
 */
function resolveSession(rawId: string) {
  const mappedId = mapSessionId(rawId)

  // Try mapped ID first
  const session = getSession(mappedId)
  if (session) return { session, resolvedId: mappedId }

  // If mapped differs from raw, try raw ID as fallback
  if (mappedId !== rawId) {
    const fallback = getSession(rawId)
    if (fallback) return { session: fallback, resolvedId: rawId }
  }

  return null
}

// GET / — List sessions
sessionsRoutes.get("/", (c) => {
  const sessions = listSessions()
    .filter((s) => !s.archived)
    .map((s) => ({
      id: s.id,
      title: s.title,
      state: s.state,
      created_at: new Date(s.createdAt).toISOString(),
    }))
  return c.json({ data: sessions })
})

// GET /:id — Get session details
sessionsRoutes.get("/:id", (c) => {
  const rawId = c.req.param("id")
  const result = resolveSession(rawId)
  if (!result) return c.json({ error: "Session not found" }, 404)
  const s = result.session
  return c.json({
    id: s.id,
    title: s.title,
    state: s.state,
    created_at: new Date(s.createdAt).toISOString(),
    archived: s.archived,
  })
})

// PATCH /:id — Update session (title)
sessionsRoutes.patch("/:id", async (c) => {
  const rawId = c.req.param("id")
  const result = resolveSession(rawId)
  if (!result) return c.json({ error: "Session not found" }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { title?: string }
  if (body.title) updateSessionTitle(result.resolvedId, body.title)
  return c.json({ ok: true })
})

// POST /:id/archive — Archive a session
sessionsRoutes.post("/:id/archive", (c) => {
  const rawId = c.req.param("id")
  const result = resolveSession(rawId)

  if (!result) {
    consola.debug(`Session not found for archive: ${rawId}`)
    return c.json({ error: "Session not found" }, 404)
  }

  const { session, resolvedId } = result

  if (session.archived) {
    return c.json({ error: "Session already archived" }, 409)
  }

  archiveSession(resolvedId)
  consola.info(`Session archived: ${resolvedId} (requested as ${rawId})`)

  return c.json({ ok: true })
})

// POST /:id/events — Send events to a session
sessionsRoutes.post("/:id/events", async (c) => {
  const rawId = c.req.param("id")
  const result = resolveSession(rawId)

  if (!result) {
    consola.debug(`Session not found for events: ${rawId}`)
    return c.json({ error: "Session not found" }, 404)
  }

  const { resolvedId } = result

  const body = await c.req.json<{
    events?: Array<Record<string, unknown>>
  }>()

  const events = body.events ?? []
  if (!Array.isArray(events)) {
    return c.json({ error: "Invalid event batch" }, 400)
  }

  if (events.length > 0) {
    const now = new Date().toISOString()
    const created = addClientEvents(
      resolvedId,
      events.map((ev) => ({
        event_type: "client_event",
        source: "client",
        payload: ev,
        created_at: now,
      })),
    )

    broadcastEvents(resolvedId, created)
    consola.debug(
      `Sent ${created.length} events to session ${resolvedId} (requested as ${rawId})`,
    )
  }

  return c.json({ ok: true })
})
