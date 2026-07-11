import consola from "consola"

export interface DirectConnectSession {
  id: string
  createdAt: number
}

const sessions = new Map<string, DirectConnectSession>()

export const DIRECT_CONNECT_WS_PATH = "/ws/direct"

export const DIRECT_CONNECT_MAX_SESSIONS = 16
export const DIRECT_CONNECT_SESSION_TTL_MS = 60 * 60 * 1000
export const DIRECT_CONNECT_MAX_FRAME_BYTES = 64 * 1024
export const DIRECT_CONNECT_MAX_CONNECTIONS_PER_SESSION = 1

const activeConnections = new Map<string, number>()

function pruneExpiredSessions(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (session.createdAt + DIRECT_CONNECT_SESSION_TTL_MS <= now) {
      sessions.delete(id)
    }
  }
}

function generateSessionId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `dc_${hex}`
}

export function createDirectConnectSession(cwd?: string): {
  session_id: string
  ws_url: string
  work_dir?: string
} {
  pruneExpiredSessions()
  if (sessions.size >= DIRECT_CONNECT_MAX_SESSIONS) {
    throw new Error("Direct Connect session limit reached")
  }

  const id = generateSessionId()
  const session: DirectConnectSession = {
    id,
    createdAt: Date.now(),
  }
  sessions.set(id, session)
  consola.info(`Direct connect session created: ${id}`)

  return {
    session_id: id,
    ws_url: `ws://localhost:4141/ws/direct/${id}`,
    ...(cwd ? { work_dir: cwd } : {}),
  }
}

export function getDirectConnectSession(
  id: string,
): DirectConnectSession | undefined {
  pruneExpiredSessions()
  return sessions.get(id)
}

export function listDirectConnectSessions(): Array<DirectConnectSession> {
  pruneExpiredSessions()
  return Array.from(sessions.values())
}

export function destroyDirectConnectSession(id: string): boolean {
  return sessions.delete(id)
}

export function reserveDirectConnectConnection(sessionId: string): boolean {
  if (!getDirectConnectSession(sessionId)) return false
  const active = activeConnections.get(sessionId) ?? 0
  if (active >= DIRECT_CONNECT_MAX_CONNECTIONS_PER_SESSION) return false
  activeConnections.set(sessionId, active + 1)
  return true
}

export function releaseDirectConnectConnection(sessionId: string): void {
  const active = activeConnections.get(sessionId) ?? 0
  if (active <= 1) activeConnections.delete(sessionId)
  else activeConnections.set(sessionId, active - 1)
}

export function handleDirectConnectWebSocket(
  ws: {
    send(data: string | ArrayBuffer | Uint8Array): void
    close(code?: number, reason?: string): void
  },
  sessionId: string,
): {
  onMessage: (message: string | Buffer | Uint8Array) => void
  onClose: () => void
} {
  const session = getDirectConnectSession(sessionId)
  if (!session) {
    consola.warn(`[direct-connect] Unknown session: ${sessionId}`)
    ws.close(4004, "Session not found")
    releaseDirectConnectConnection(sessionId)
    return {
      onMessage: () => {},
      onClose: () => {},
    }
  }

  consola.debug(`[direct-connect] WebSocket connected for session ${sessionId}`)

  // Send initial session token message
  ws.send(JSON.stringify({ type: "session", token: sessionId }))

  return {
    onMessage(message: string | Buffer | Uint8Array) {
      if (!getDirectConnectSession(sessionId)) {
        ws.close(4004, "Session expired")
        return
      }
      if (typeof message !== "string") {
        ws.close(4007, "Binary frames not supported")
        return
      }
      if (
        new TextEncoder().encode(message).length
        > DIRECT_CONNECT_MAX_FRAME_BYTES
      ) {
        ws.close(4009, "Direct Connect frame too large")
        return
      }

      consola.debug(
        `[direct-connect] Message from ${sessionId}: ${new TextEncoder().encode(message).length} bytes`,
      )
    },
    onClose() {
      releaseDirectConnectConnection(sessionId)
      consola.debug(
        `[direct-connect] WebSocket closed for session ${sessionId}`,
      )
    },
  }
}

export function resetDirectConnectForTest(): void {
  sessions.clear()
  activeConnections.clear()
}
