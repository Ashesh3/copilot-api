import consola from "consola"

import { toWebSocketUrl } from "~/lib/public-origin"

export interface DirectConnectSession {
  id: string
  createdAt: number
}

const sessions = new Map<string, DirectConnectSession>()

export const DIRECT_CONNECT_WS_PATH = "/ws/direct"

function generateSessionId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `dc_${hex}`
}

export function createDirectConnectSession(
  publicOrigin: URL,
  cwd?: string,
): {
  session_id: string
  ws_url: string
  work_dir?: string
} {
  const id = generateSessionId()
  const session: DirectConnectSession = {
    id,
    createdAt: Date.now(),
  }
  sessions.set(id, session)
  consola.info(`Direct connect session created: ${id}`)

  return {
    session_id: id,
    ws_url: toWebSocketUrl(publicOrigin, ["ws", "direct", id]).toString(),
    ...(cwd ? { work_dir: cwd } : {}),
  }
}

export function getDirectConnectSession(
  id: string,
): DirectConnectSession | undefined {
  return sessions.get(id)
}

export function listDirectConnectSessions(): Array<DirectConnectSession> {
  return Array.from(sessions.values())
}

export function destroyDirectConnectSession(id: string): boolean {
  return sessions.delete(id)
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
        ws.close(4004, "Session not found")
        return
      }
      if (typeof message !== "string") {
        ws.close(4007, "Binary frames not supported")
        return
      }
      consola.debug(
        `[direct-connect] Message from ${sessionId}: ${new TextEncoder().encode(message).length} bytes`,
      )
    },
    onClose() {
      consola.debug(
        `[direct-connect] WebSocket closed for session ${sessionId}`,
      )
    },
  }
}

export function resetDirectConnectForTest(): void {
  sessions.clear()
}
