import {
  authenticateAdminRequest,
  isAdminSessionActive,
  isAllowedAdminOrigin,
} from "~/lib/admin-auth"
import { interceptEngine, type InterceptEvent } from "~/lib/intercept/engine"

/**
 * Live Intercept updates for the dashboard. A WebSocket rather than an event
 * stream: proxies such as Cloudflare buffer small, infrequent event-stream
 * chunks, while they relay WebSocket frames one by one.
 */
export const INTERCEPT_SOCKET_PATH = "/dashboard/api/intercept/ws"

const PING_MS = 15_000
/** A client this far behind reconnects and starts again from a snapshot. */
const MAX_QUEUED_EVENTS = 500
/** Bytes Bun may buffer for a slow client before it is dropped the same way. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

const CLOSE_SESSION_ENDED = 1008
const CLOSE_SERVER_ERROR = 1011
/** Closes a client that missed a frame, so it reconnects from a snapshot. */
const CLOSE_TRY_AGAIN = 1013

/** A JSON text frame; `data` of an engine event is the event itself. */
export type InterceptSocketMessage =
  | { event: InterceptEvent["type"]; data: InterceptEvent }
  | { event: "ping"; data: number }

/** The part of Bun's `ServerWebSocket` the channel uses. */
export interface InterceptSocket {
  /** Bun: bytes sent, -1 when buffered under backpressure, 0 when dropped. */
  send(data: string): number
  close(code?: number, reason?: string): void
  getBufferedAmount?(): number
}

export interface InterceptSocketData {
  type: "intercept"
  /** Headers of the upgrade request, to re-check its admin session. */
  sessionRequest: Request
  detach?: () => void
}

export type InterceptUpgradeResult = "upgraded" | "auth_failed" | "no_match"

/**
 * Upgrades `GET /dashboard/api/intercept/ws` for an admin session. Browsers
 * attach cookies to cross-site WebSocket handshakes, so the origin must be an
 * admin origin as well (cross-site WebSocket hijacking).
 */
export async function tryUpgradeInterceptWebSocket(
  request: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): Promise<InterceptUpgradeResult> {
  if (new URL(request.url).pathname !== INTERCEPT_SOCKET_PATH) return "no_match"
  if (!isAllowedAdminOrigin(request.headers.get("origin"))) return "auth_failed"
  if (!(await authenticateAdminRequest(request))) return "auth_failed"
  const data: InterceptSocketData = {
    type: "intercept",
    sessionRequest: new Request(request.url, { headers: request.headers }),
  }
  return server.upgrade(request, { data }) ? "upgraded" : "no_match"
}

/**
 * Sends a snapshot, then every engine event in order, each only while the
 * admin session that opened the socket is current: logout, a password change,
 * or expiry closes it. The check never extends the session, so an open socket
 * cannot keep it alive. Returns the cleanup to run when the socket closes.
 */
export function attachInterceptChannel(
  socket: InterceptSocket,
  sessionRequest: Request,
  options: { pingMs?: number } = {},
): () => void {
  const queue: Array<string> = []
  let closed = false
  let draining = false

  const detach = () => {
    if (closed) return
    closed = true
    queue.length = 0
    clearInterval(ping)
    unsubscribe()
  }

  const close = (code: number, reason: string) => {
    if (closed) return
    detach()
    socket.close(code, reason)
  }

  const sendFrame = (frame: string): boolean => {
    const result = socket.send(frame)
    // A dropped frame leaves the client out of date: close the socket so it
    // polls, then reconnects from a fresh snapshot.
    if (result === 0) {
      close(CLOSE_TRY_AGAIN, "Frame dropped")
      return false
    }
    if (
      result === -1
      && (socket.getBufferedAmount?.() ?? 0) > MAX_BUFFERED_BYTES
    ) {
      close(CLOSE_TRY_AGAIN, "Client fell behind")
      return false
    }
    return true
  }

  // One session check covers the frames queued before it started; frames
  // queued while it runs wait for the next one. Frames go out in order.
  const drain = async () => {
    draining = true
    try {
      while (!closed && queue.length > 0) {
        const count = queue.length
        if (!(await isAdminSessionActive(sessionRequest))) {
          close(CLOSE_SESSION_ENDED, "Session ended")
          return
        }
        for (const frame of queue.splice(0, count)) {
          if (!sendFrame(frame)) return
        }
      }
    } catch {
      close(CLOSE_SERVER_ERROR, "Delivery failed")
    } finally {
      draining = false
    }
  }

  const send = (message: InterceptSocketMessage) => {
    if (closed) return
    if (queue.length >= MAX_QUEUED_EVENTS) {
      close(CLOSE_TRY_AGAIN, "Client fell behind")
      return
    }
    queue.push(JSON.stringify(message))
    if (!draining) void drain()
  }

  // Subscribing and queueing the snapshot in the same tick loses no event.
  const unsubscribe = interceptEngine.subscribe((event) => {
    send({ event: event.type, data: event })
  })
  const ping = setInterval(() => {
    send({ event: "ping", data: Date.now() })
  }, options.pingMs ?? PING_MS)
  send({
    event: "snapshot",
    data: { type: "snapshot", snapshot: interceptEngine.getSnapshot() },
  })

  return detach
}
