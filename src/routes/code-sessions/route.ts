import consola from "consola"
import { Hono, type Context, type Next } from "hono"
import { randomUUID } from "node:crypto"

import {
  authorizeWorkerCapability,
  bindWorkerCapability,
  issueWorkerCapability,
} from "~/lib/bridge-capabilities"
import { resolveRequestCredential } from "~/lib/credential-resolver"
import { recordFailedAttempt } from "~/lib/ip-blocker"
import { resolveProtectedCredential } from "~/lib/protected-credential"
import { resolvePublicOrigin } from "~/lib/public-origin"
import { readRequestJson } from "~/lib/request-json"

import type { InternalEvent } from "./types"

import { subscribe, unsubscribe, broadcastEvents } from "./event-bus"
import {
  createSession,
  getSession,
  bumpWorkerEpoch,
  updateSessionTitle,
  updateWorkerState,
  heartbeat,
  addClientEvents,
  getClientEvents,
  addInternalEvents,
  getInternalEvents,
  getWorkerState,
} from "./session-store"

export const codeSessionsRoutes = new Hono()

function unauthorized(c: {
  json(value: unknown, status: 401): Response
}): Response {
  return c.json({ error: "Unauthorized" }, 401)
}

async function requireWorkerCapability(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  const id = c.req.param("id") ?? ""
  const auth = await resolveProtectedCredential(
    c.req.raw,
    async () => await authorizeWorkerCapability(c.req.raw, id),
  )
  if (auth.status !== "authorized") return unauthorized(c)
  const { credential: capability } = auth
  const session = getSession(id)
  if (!session) return unauthorized(c)
  if (
    capability.workerEpoch !== undefined
    && capability.workerEpoch !== session.workerEpoch
  ) {
    if (auth.clientIp !== null) recordFailedAttempt(auth.clientIp)
    return unauthorized(c)
  }
  await next()
}

codeSessionsRoutes.use("*", async (c, next) => {
  if (
    /\/worker(?:\/|$)/.test(c.req.path)
    || /\/[^/]+\/events\/stream\/?$/.test(c.req.path)
  ) {
    return next()
  }
  const auth = await resolveProtectedCredential(
    c.req.raw,
    async () =>
      await resolveRequestCredential(c.req.raw, ["user:sessions:claude_code"]),
  )
  if (auth.status !== "authorized") return unauthorized(c)
  await next()
})
codeSessionsRoutes.use("/:id/worker", requireWorkerCapability)
codeSessionsRoutes.use("/:id/worker/*", requireWorkerCapability)
// POST / — Create a code session
codeSessionsRoutes.post("/", async (c) => {
  const parsed = await readRequestJson(() =>
    c.req.json<{
      title?: string
      bridge?: string
      tags?: Array<string>
    }>(),
  )
  if (!parsed.ok) return c.json({ error: "Invalid JSON" }, 400)
  const body = parsed.value

  const session = createSession(
    body.title ?? "Untitled Session",
    body.tags ?? [],
  )

  consola.info(`Code session created: ${session.id}`)

  return c.json(
    {
      session: {
        id: session.id,
        title: session.title,
      },
    },
    201,
  )
})

// POST /:id/bridge — Fetch worker credentials
codeSessionsRoutes.post("/:id/bridge", (c) => {
  const id = c.req.param("id")
  const session = getSession(id)

  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  if (session.archived) {
    return c.json({ error: "Session is archived" }, 410)
  }

  // Session exists (checked above), so bumpWorkerEpoch will always return a number
  const epoch = bumpWorkerEpoch(id) as number

  const apiBaseUrl = resolvePublicOrigin(c.req.raw).toString()

  const workerJwt = issueWorkerCapability(id, epoch)

  consola.info(`Bridge created for session ${id}, epoch ${epoch}`)

  return c.json({
    worker_jwt: workerJwt,
    api_base_url: apiBaseUrl,
    expires_in: 3600,
    worker_epoch: epoch,
  })
})

// PATCH /:id — Update session
codeSessionsRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id")
  const parsed = await readRequestJson(() => c.req.json<{ title?: string }>())
  if (!parsed.ok) return c.json({ error: "Invalid JSON" }, 400)
  const body = parsed.value

  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  if (body.title !== undefined) {
    updateSessionTitle(id, body.title)
  }

  return c.json({ ok: true })
})

// POST /:id/worker/register — Register a worker for a session (CCR v2)
codeSessionsRoutes.post("/:id/worker/register", async (c) => {
  const id = c.req.param("id")
  const session = getSession(id)

  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  if (session.archived) {
    return c.json({ error: "Session is archived" }, 410)
  }

  const capabilityAuth = await resolveProtectedCredential(
    c.req.raw,
    async () => await authorizeWorkerCapability(c.req.raw, id),
  )
  if (capabilityAuth.status !== "authorized") return unauthorized(c)
  const { credential: capability } = capabilityAuth
  const epoch = bumpWorkerEpoch(id) as number
  if (!bindWorkerCapability(capability.rawCredential, id, epoch)) {
    if (capabilityAuth.clientIp !== null) {
      recordFailedAttempt(capabilityAuth.clientIp)
    }
    return unauthorized(c)
  }
  consola.info(`Worker registered for session ${id}, epoch ${epoch}`)

  return c.json({ worker_epoch: epoch })
})

// PUT /:id/worker — Report worker state
codeSessionsRoutes.put("/:id/worker", async (c) => {
  const id = c.req.param("id")
  const parsed = await readRequestJson(() =>
    c.req.json<{
      worker_epoch: number
      worker_status?: string
      external_metadata?: Record<string, unknown> | null
      requires_action_details?: {
        tool_name?: string
        action_description?: string
        request_id?: string
      } | null
    }>(),
  )
  if (!parsed.ok) return c.json({ error: "Invalid JSON" }, 400)
  const body = parsed.value

  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  const ok = updateWorkerState(id, body.worker_epoch, {
    status: body.worker_status as
      | "idle"
      | "running"
      | "requires_action"
      | undefined,
    externalMetadata: body.external_metadata,
    requiresActionDetails: body.requires_action_details,
  })

  if (!ok) {
    return c.json({ error: "Epoch mismatch" }, 409)
  }

  return c.json({ ok: true })
})

// GET /:id/worker — Read worker state
codeSessionsRoutes.get("/:id/worker", (c) => {
  const id = c.req.param("id")
  const workerState = getWorkerState(id)

  if (!workerState) {
    return c.json({ error: "Session not found" }, 404)
  }

  return c.json({ worker: workerState })
})

// POST /:id/worker/heartbeat — Worker heartbeat
codeSessionsRoutes.post("/:id/worker/heartbeat", async (c) => {
  const id = c.req.param("id")
  const parsed = await readRequestJson(() =>
    c.req.json<{ worker_epoch: number }>(),
  )
  if (!parsed.ok) return c.json({ error: "Invalid JSON" }, 400)
  const body = parsed.value

  const ok = heartbeat(id, body.worker_epoch)
  if (!ok) {
    return c.json({ error: "Epoch mismatch" }, 409)
  }

  return c.json({ ok: true })
})

// POST /:id/worker/events — Write client events
codeSessionsRoutes.post("/:id/worker/events", async (c) => {
  const id = c.req.param("id")
  const parsed = await readRequestJson(() =>
    c.req.json<{
      worker_epoch: number
      events: Array<{ payload: Record<string, unknown>; ephemeral?: boolean }>
    }>(),
  )
  if (!parsed.ok) return c.json({ error: "Invalid JSON" }, 400)
  const body = parsed.value
  if (!Array.isArray(body.events)) {
    return c.json({ error: "Invalid event batch" }, 400)
  }

  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  if (session.workerEpoch !== body.worker_epoch) {
    return c.json({ error: "Epoch mismatch" }, 409)
  }

  const now = new Date().toISOString()
  const created = addClientEvents(
    id,
    body.events.map((ev) => ({
      event_type: "client_event",
      source: "worker",
      payload: ev.payload,
      created_at: now,
    })),
  )

  broadcastEvents(id, created)

  return c.json({ ok: true })
})

// POST /:id/worker/events/delivery — Delivery ack
codeSessionsRoutes.post("/:id/worker/events/delivery", (c) => {
  return c.json({ ok: true })
})

// POST /:id/worker/internal-events — Write internal events
codeSessionsRoutes.post("/:id/worker/internal-events", async (c) => {
  const id = c.req.param("id")
  const parsed = await readRequestJson(() =>
    c.req.json<{
      worker_epoch: number
      events: Array<{
        payload: Record<string, unknown>
        is_compaction?: boolean
        agent_id?: string
      }>
    }>(),
  )
  if (!parsed.ok) return c.json({ error: "Invalid JSON" }, 400)
  const body = parsed.value
  if (!Array.isArray(body.events)) {
    return c.json({ error: "Invalid event batch" }, 400)
  }

  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  if (session.workerEpoch !== body.worker_epoch) {
    return c.json({ error: "Epoch mismatch" }, 409)
  }

  const now = new Date().toISOString()
  const events: Array<InternalEvent> = body.events.map((ev) => ({
    event_id: randomUUID(),
    event_type: "internal_event",
    payload: ev.payload,
    is_compaction: ev.is_compaction ?? false,
    created_at: now,
    agent_id: ev.agent_id,
  }))

  addInternalEvents(id, events)

  return c.json({ ok: true })
})

// GET /:id/worker/internal-events — Read internal events
codeSessionsRoutes.get("/:id/worker/internal-events", (c) => {
  const id = c.req.param("id")
  const subagents = c.req.query("subagents") === "true"
  const agentId = c.req.query("agent_id")

  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  const events = getInternalEvents(id, {
    subagents,
    agentId: agentId ?? undefined,
  })

  return c.json({ data: events })
})

// GET /:id/events/stream — SSE event stream
codeSessionsRoutes.get("/:id/events/stream", async (c) => {
  const id = c.req.param("id")
  const auth = await resolveProtectedCredential(
    c.req.raw,
    async () => await authorizeWorkerCapability(c.req.raw, id),
  )
  if (auth.status !== "authorized") return unauthorized(c)
  consola.info(
    `[code-sessions] SSE stream subscriber connected — session=${id}`,
  )
  const fromSeqNumStr = c.req.query("from_sequence_num")
  const fromSeqNum = fromSeqNumStr ? Number.parseInt(fromSeqNumStr, 10) : 0

  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      // Send any missed events first
      const missed = getClientEvents(id, fromSeqNum)
      for (const event of missed) {
        const frame = `event: client_event\nid: ${event.sequence_num}\ndata: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(frame))
      }

      // Subscribe for future events
      const sub = subscribe(id, controller, fromSeqNum)

      consola.debug(`SSE subscriber connected for session ${id}`)

      // Handle client disconnect
      c.req.raw.signal.addEventListener("abort", () => {
        consola.debug(`SSE subscriber disconnected for session ${id}`)
        unsubscribe(sub)
        try {
          controller.close()
        } catch {
          // Already closed
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
})

// GET /:id/worker/events/stream — SSE stream for workers (same as events/stream)
codeSessionsRoutes.get("/:id/worker/events/stream", (c) => {
  const id = c.req.param("id")
  consola.info(
    `[code-sessions] SSE worker stream subscriber connected — session=${id}`,
  )
  const fromSeqNumStr = c.req.query("from_sequence_num")
  const fromSeqNum = fromSeqNumStr ? Number.parseInt(fromSeqNumStr, 10) : 0

  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      // Send any missed events first
      const missed = getClientEvents(id, fromSeqNum)
      for (const event of missed) {
        const frame = `event: client_event\nid: ${event.sequence_num}\ndata: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(frame))
      }

      // Subscribe for future events
      const sub = subscribe(id, controller, fromSeqNum)

      consola.debug(`SSE worker subscriber connected for session ${id}`)

      // Handle client disconnect
      c.req.raw.signal.addEventListener("abort", () => {
        consola.debug(`SSE worker subscriber disconnected for session ${id}`)
        unsubscribe(sub)
        try {
          controller.close()
        } catch {
          // Already closed
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
})

// POST /:id/events — Post event to session
codeSessionsRoutes.post("/:id/events", async (c) => {
  const id = c.req.param("id")
  const parsed = await readRequestJson(() =>
    c.req.json<{ payload: Record<string, unknown> }>(),
  )
  if (!parsed.ok) return c.json({ error: "Invalid JSON" }, 400)
  const body = parsed.value

  const payloadType =
    "type" in body.payload ? String(body.payload.type) : "unknown"
  consola.info(
    `[code-sessions] POST /:id/events — id=${id} payload.type=${payloadType}`,
  )

  const session = getSession(id)
  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  const now = new Date().toISOString()
  const created = addClientEvents(id, [
    {
      event_type: "client_event",
      source: "client",
      payload: body.payload,
      created_at: now,
    },
  ])

  consola.info(
    `[code-sessions] Broadcasting ${created.length} events to SSE subscribers`,
  )
  broadcastEvents(id, created)

  return c.json({ ok: true })
})

// GET /:id/teleport-events — Get teleport events for a session
codeSessionsRoutes.get("/:id/teleport-events", (c) => {
  return c.json({ events: [] })
})
