import { createHash, randomBytes } from "node:crypto"

import type { DictationAuthority } from "./authorization"

const TICKET_LIFETIME_MS = 60_000

export interface DictationTicketBinding {
  authenticationRequest: Request
  authority: DictationAuthority
  streamDestination: string
}

interface PendingTicket extends DictationTicketBinding {
  expiresAt: number
  expiryTimer: ReturnType<typeof setTimeout>
}

const tickets = new Map<string, PendingTicket>()

function digest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex")
}

export function issueDictationTicket(binding: DictationTicketBinding): string {
  const now = Date.now()
  for (const [hash, entry] of tickets) {
    if (entry.expiresAt <= now) {
      clearTimeout(entry.expiryTimer)
      tickets.delete(hash)
    }
  }
  const ticket = randomBytes(32).toString("base64url")
  const hash = digest(ticket)
  const expiryTimer = setTimeout(() => tickets.delete(hash), TICKET_LIFETIME_MS)
  expiryTimer.unref()
  tickets.set(hash, {
    ...binding,
    expiresAt: now + TICKET_LIFETIME_MS,
    expiryTimer,
  })
  return ticket
}

export function redeemDictationTicket(
  ticket: string,
  streamDestination: string,
): DictationTicketBinding | undefined {
  const hash = digest(ticket)
  const entry = tickets.get(hash)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    clearTimeout(entry.expiryTimer)
    tickets.delete(hash)
    return undefined
  }
  if (entry.streamDestination !== streamDestination) return undefined
  // Consume before any asynchronous authorization or upgrade work. Concurrent
  // sockets must never redeem the same credential, even if a later check fails.
  clearTimeout(entry.expiryTimer)
  tickets.delete(hash)
  return entry
}
