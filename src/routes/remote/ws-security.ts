import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import {
  authenticateAdminRequest,
  isAllowedAdminOrigin,
} from "~/lib/admin-auth"
import { getSession } from "~/routes/code-sessions/session-store"

export const REMOTE_TICKET_TTL_MS = 60_000
export const REMOTE_MAX_PENDING_TICKETS = 512
export const REMOTE_MAX_CONTROLLERS_PER_SESSION = 2
export const REMOTE_MAX_CONTROLLERS_GLOBAL = 20

interface TicketRecord {
  adminSessionId: string
  sessionId: string
  expiresAt: number
}

export interface RemoteWebSocketData {
  type: "remote-control"
  sessionId: string
  controllerKey: string
  controllerReleased: boolean
  rcSubscriber?: unknown
  rcKeepalive?: ReturnType<typeof setInterval>
  rcIdleTimer?: ReturnType<typeof setTimeout>
  rcLifetimeTimer?: ReturnType<typeof setTimeout>
  rcMessageWindowStartedAt?: number
  rcMessageCount?: number
}

export type RemoteUpgradeResult =
  | "upgraded"
  | "auth_failed"
  | "no_match"
  | "limit_reached"

const tickets = new Map<string, TicketRecord>()
const controllersBySession = new Map<string, number>()
let activeControllers = 0

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return (
    leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
  )
}

function pruneTickets(now = Date.now()): void {
  for (const [key, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(key)
  }
}

export function mintRemoteWebSocketTicket(
  adminSessionId: string,
  sessionId: string,
): { ticket: string; expiresAt: number } {
  pruneTickets()
  while (tickets.size >= REMOTE_MAX_PENDING_TICKETS) {
    const oldest = tickets.keys().next().value
    if (!oldest) break
    tickets.delete(oldest)
  }
  const ticket = randomBytes(32).toString("base64url")
  const expiresAt = Date.now() + REMOTE_TICKET_TTL_MS
  tickets.set(digest(ticket), { adminSessionId, sessionId, expiresAt })
  return { ticket, expiresAt }
}

function extractTicket(request: Request): string | null {
  const protocols =
    request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((value) => value.trim()) ?? []
  const protocol = protocols.find((value) =>
    value.startsWith("copilot-ticket."),
  )
  const ticket = protocol?.slice("copilot-ticket.".length)
  return ticket && /^[\w-]{43}$/.test(ticket) ? ticket : null
}

function reserveController(sessionId: string): string | null {
  const sessionCount = controllersBySession.get(sessionId) ?? 0
  if (
    sessionCount >= REMOTE_MAX_CONTROLLERS_PER_SESSION
    || activeControllers >= REMOTE_MAX_CONTROLLERS_GLOBAL
  ) {
    return null
  }
  controllersBySession.set(sessionId, sessionCount + 1)
  activeControllers += 1
  return sessionId
}

export function releaseRemoteController(data: RemoteWebSocketData): void {
  if (data.controllerReleased) return
  data.controllerReleased = true
  const count = controllersBySession.get(data.controllerKey) ?? 0
  if (count <= 1) controllersBySession.delete(data.controllerKey)
  else controllersBySession.set(data.controllerKey, count - 1)
  activeControllers = Math.max(0, activeControllers - 1)
}

export async function tryUpgradeRemoteWebSocket(
  request: Request,
  server: { upgrade(req: Request, opts?: object): boolean },
): Promise<RemoteUpgradeResult> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/ws/remote/")) return "no_match"
  let sessionId: string
  try {
    sessionId = decodeURIComponent(url.pathname.slice("/ws/remote/".length))
  } catch {
    return "auth_failed"
  }
  if (!/^cse_[a-z0-9]{24}$/.test(sessionId)) return "auth_failed"
  if (!isAllowedAdminOrigin(request.headers.get("origin"))) return "auth_failed"

  const ticket = extractTicket(request)
  if (!ticket) return "auth_failed"
  const ticketKey = digest(ticket)
  const record = tickets.get(ticketKey)
  if (!record) return "auth_failed"
  if (record.expiresAt <= Date.now()) {
    tickets.delete(ticketKey)
    return "auth_failed"
  }

  const adminSession = await authenticateAdminRequest(request)
  // Re-read and consume atomically after the async authentication operation.
  if (tickets.get(ticketKey) !== record) return "auth_failed"
  tickets.delete(ticketKey)
  if (
    !adminSession
    || !safeEqual(record.adminSessionId, adminSession.tokenHash)
    || !safeEqual(record.sessionId, sessionId)
  ) {
    return "auth_failed"
  }

  const session = getSession(sessionId)
  if (!session || session.archived) return "auth_failed"
  const controllerKey = reserveController(sessionId)
  if (!controllerKey) return "limit_reached"

  const data: RemoteWebSocketData = {
    type: "remote-control",
    sessionId,
    controllerKey,
    controllerReleased: false,
  }
  const upgraded = server.upgrade(request, {
    data,
    headers: { "Sec-WebSocket-Protocol": "copilot-remote" },
  })
  if (!upgraded) {
    releaseRemoteController(data)
    return "no_match"
  }
  return "upgraded"
}

export function resetRemoteWebSocketSecurityForTest(): void {
  tickets.clear()
  controllersBySession.clear()
  activeControllers = 0
}
