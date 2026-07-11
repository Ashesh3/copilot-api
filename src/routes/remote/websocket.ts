import type { CallbackSubscriber } from "~/routes/code-sessions/event-bus"

import {
  broadcastEvents,
  subscribeWithCallback,
  unsubscribeCallback,
} from "~/routes/code-sessions/event-bus"
import {
  addClientEvents,
  getClientEvents,
  getSession,
} from "~/routes/code-sessions/session-store"

import {
  type RemoteWebSocketData,
  releaseRemoteController,
} from "./ws-security"

export const REMOTE_MAX_FRAME_BYTES = 64 * 1024
export const REMOTE_MAX_CATCHUP_EVENTS = 500
const REMOTE_MAX_CATCHUP_BYTES = 1024 * 1024
const REMOTE_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const REMOTE_LIFETIME_MS = 12 * 60 * 60 * 1000
const REMOTE_MESSAGES_PER_MINUTE = 60

interface RemoteSocket {
  data: RemoteWebSocketData & { rcSubscriber?: CallbackSubscriber }
  send(data: string): void
  close(code?: number, reason?: string): void
}

function closeRemote(ws: RemoteSocket, code: number, reason: string): void {
  cleanupRemote(ws)
  ws.close(code, reason)
}

function cleanupRemote(ws: RemoteSocket): void {
  if (ws.data.rcKeepalive) clearInterval(ws.data.rcKeepalive)
  if (ws.data.rcIdleTimer) clearTimeout(ws.data.rcIdleTimer)
  if (ws.data.rcLifetimeTimer) clearTimeout(ws.data.rcLifetimeTimer)
  if (ws.data.rcSubscriber) unsubscribeCallback(ws.data.rcSubscriber)
  ws.data.rcSubscriber = undefined
  releaseRemoteController(ws.data)
}

function resetIdleTimer(ws: RemoteSocket): void {
  if (ws.data.rcIdleTimer) clearTimeout(ws.data.rcIdleTimer)
  ws.data.rcIdleTimer = setTimeout(() => {
    closeRemote(ws, 4008, "Remote controller idle timeout")
  }, REMOTE_IDLE_TIMEOUT_MS)
}

function sendBounded(ws: RemoteSocket, value: unknown): boolean {
  const serialized = JSON.stringify(value)
  if (new TextEncoder().encode(serialized).length > REMOTE_MAX_FRAME_BYTES) {
    return false
  }
  ws.send(serialized)
  return true
}

function getBoundedCatchup(sessionId: string): Array<unknown> {
  const events = getClientEvents(sessionId, 0).slice(-REMOTE_MAX_CATCHUP_EVENTS)
  const selected: Array<unknown> = []
  let totalBytes = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const size = new TextEncoder().encode(JSON.stringify(event)).length
    if (
      size > REMOTE_MAX_FRAME_BYTES
      || totalBytes + size > REMOTE_MAX_CATCHUP_BYTES
    ) {
      continue
    }
    selected.push(event)
    totalBytes += size
  }
  return selected.reverse()
}

function parseClientMessage(
  message: string | Buffer | Uint8Array,
  sessionId: string,
): Record<string, unknown> | null {
  if (typeof message !== "string") return null
  if (new TextEncoder().encode(message).length > REMOTE_MAX_FRAME_BYTES)
    return null
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>
    if (
      parsed.type !== "user"
      || parsed.session_id !== sessionId
      || typeof parsed.message !== "object"
      || parsed.message === null
      || Array.isArray(parsed.message)
    ) {
      return null
    }
    const body = parsed.message as Record<string, unknown>
    if (
      body.role !== "user"
      || typeof body.content !== "string"
      || body.content.length === 0
      || body.content.length > 32_768
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function consumeMessageRate(data: RemoteWebSocketData): boolean {
  const now = Date.now()
  if (
    data.rcMessageWindowStartedAt === undefined
    || now - data.rcMessageWindowStartedAt >= 60_000
  ) {
    data.rcMessageWindowStartedAt = now
    data.rcMessageCount = 1
    return true
  }
  data.rcMessageCount = (data.rcMessageCount ?? 0) + 1
  return data.rcMessageCount <= REMOTE_MESSAGES_PER_MINUTE
}

export const remoteWebSocket = {
  open(ws: RemoteSocket) {
    const session = getSession(ws.data.sessionId)
    if (!session || session.archived) {
      closeRemote(ws, 4004, "Session not found")
      return
    }
    for (const event of getBoundedCatchup(ws.data.sessionId)) {
      sendBounded(ws, event)
    }
    ws.data.rcSubscriber = subscribeWithCallback(ws.data.sessionId, (event) => {
      try {
        sendBounded(ws, event)
      } catch {
        // The close callback performs cleanup.
      }
    })
    ws.data.rcKeepalive = setInterval(() => {
      try {
        sendBounded(ws, { type: "ping" })
      } catch {
        // The close callback performs cleanup.
      }
    }, 30_000)
    ws.data.rcLifetimeTimer = setTimeout(() => {
      closeRemote(ws, 4008, "Remote controller lifetime exceeded")
    }, REMOTE_LIFETIME_MS)
    resetIdleTimer(ws)
  },

  message(ws: RemoteSocket, message: string | Buffer | Uint8Array) {
    if (!consumeMessageRate(ws.data)) {
      closeRemote(ws, 4008, "Remote controller rate limit exceeded")
      return
    }
    const parsed = parseClientMessage(message, ws.data.sessionId)
    if (!parsed) {
      closeRemote(ws, 4007, "Invalid remote controller message")
      return
    }
    resetIdleTimer(ws)
    const created = addClientEvents(ws.data.sessionId, [
      {
        event_type: "client_event",
        source: "client",
        payload: parsed,
        created_at: new Date().toISOString(),
      },
    ])
    broadcastEvents(ws.data.sessionId, created)
  },

  close(ws: RemoteSocket) {
    cleanupRemote(ws)
  },
}
