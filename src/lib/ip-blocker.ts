import type { Context } from "hono"

interface IpEntry {
  count: number
  date: string
}

const ipTracker = new Map<string, IpEntry>()

/**
 * Extracts the client IP from the x-forwarded-for header.
 * Returns the first IP in the comma-separated list, or null if header is absent.
 */
export function extractClientIp(c: Context): string | null {
  const xForwardedFor = c.req.header("x-forwarded-for")

  if (!xForwardedFor) {
    return null
  }

  const ips = xForwardedFor.split(",")
  const firstIp = ips[0]?.trim()

  return firstIp || null
}

/**
 * Gets the current UTC date as YYYY-MM-DD string.
 */
function getUtcDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Checks if an IP is blocked due to 3+ failed attempts today (UTC).
 * Cleans up stale entries (entries from previous days).
 */
export function isIpBlocked(ip: string): boolean {
  const today = getUtcDateString()
  const entry = ipTracker.get(ip)

  if (!entry) {
    return false
  }

  // Stale entry cleanup: if date doesn't match today, delete and return false
  if (entry.date !== today) {
    ipTracker.delete(ip)
    return false
  }

  // Check if count meets or exceeds threshold
  return entry.count >= 3
}

/**
 * Records a failed authentication attempt for an IP.
 * Increments count if entry exists for today, otherwise creates new entry.
 */
export function recordFailedAttempt(ip: string): void {
  const today = getUtcDateString()
  const entry = ipTracker.get(ip)

  if (!entry) {
    // New entry
    ipTracker.set(ip, { count: 1, date: today })
    return
  }

  if (entry.date === today) {
    // Same day: increment count
    entry.count += 1
  } else {
    // Different day: reset to 1
    ipTracker.set(ip, { count: 1, date: today })
  }
}
