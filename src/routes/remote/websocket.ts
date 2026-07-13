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

import { type RemoteWebSocketData } from "./ws-security"

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
  if (ws.data.rcSubscriber) unsubscribeCallback(ws.data.rcSubscriber)
  ws.data.rcSubscriber = undefined
}

function sendJson(ws: RemoteSocket, value: unknown): void {
  ws.send(JSON.stringify(value))
}

function parseClientMessage(
  message: string | Buffer | Uint8Array,
  sessionId: string,
): Record<string, unknown> | null {
  if (typeof message !== "string") return null
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
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export const remoteWebSocket = {
  open(ws: RemoteSocket) {
    const session = getSession(ws.data.sessionId)
    if (!session || session.archived) {
      closeRemote(ws, 4004, "Session not found")
      return
    }
    for (const event of getClientEvents(ws.data.sessionId, 0)) {
      sendJson(ws, event)
    }
    ws.data.rcSubscriber = subscribeWithCallback(ws.data.sessionId, (event) => {
      try {
        sendJson(ws, event)
      } catch {
        // The close callback performs cleanup.
      }
    })
    ws.data.rcKeepalive = setInterval(() => {
      try {
        sendJson(ws, { type: "ping" })
      } catch {
        // The close callback performs cleanup.
      }
    }, 30_000)
  },

  message(ws: RemoteSocket, message: string | Buffer | Uint8Array) {
    const parsed = parseClientMessage(message, ws.data.sessionId)
    if (!parsed) {
      closeRemote(ws, 4007, "Invalid remote controller message")
      return
    }
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
