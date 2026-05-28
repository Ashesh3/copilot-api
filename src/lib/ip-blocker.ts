import type { Context } from "hono"

import consola from "consola"

import { isManagedIpAllowed, isManagedIpDisabled } from "./ip-allowlist"

interface IpEntry {
  count: number
  date: string
}

const ipTracker = new Map<string, IpEntry>()
const whitelistedIps = new Set<string>()

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
 * Whitelists an IP for the lifetime of the server process.
 * Once whitelisted, the IP will never be blocked regardless of failed attempts.
 */
export function whitelistIp(ip: string): void {
  if (!whitelistedIps.has(ip)) {
    whitelistedIps.add(ip)
    // Clear any existing failed attempts
    ipTracker.delete(ip)
    consola.info(`[security] IP ${ip} whitelisted after successful auth`)
  }
}

export function isIpWhitelisted(ip: string): boolean {
  return whitelistedIps.has(ip)
}

export function unwhitelistIp(ip: string): boolean {
  return whitelistedIps.delete(ip)
}

export async function isIpAllowedForWhitelistedRoute(
  ip: string,
): Promise<boolean> {
  if (await isManagedIpDisabled(ip)) return false
  return whitelistedIps.has(ip) || (await isManagedIpAllowed(ip))
}

/**
 * Checks if an IP is blocked due to 3+ failed attempts today (UTC).
 * Whitelisted IPs are never blocked.
 * Cleans up stale entries (entries from previous days).
 */
export function isIpBlocked(ip: string): boolean {
  if (whitelistedIps.has(ip)) {
    return false
  }

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
  if (entry.count >= 3) {
    consola.debug(`[security] Blocked request from banned IP ${ip}`)
    return true
  }
  return false
}

/**
 * Records a failed authentication attempt for an IP.
 * Increments count if entry exists for today, otherwise creates new entry.
 * Returns the current attempt count after recording.
 */
export function recordFailedAttempt(ip: string): number {
  const today = getUtcDateString()
  const entry = ipTracker.get(ip)

  if (!entry) {
    // New entry
    ipTracker.set(ip, { count: 1, date: today })
    consola.warn(`[security] Failed auth attempt from ${ip} (1/3)`)
    return 1
  }

  if (entry.date === today) {
    // Same day: increment count
    entry.count += 1
    if (entry.count === 3) {
      consola.warn(`[security] IP ${ip} banned — 3 failed auth attempts today`)
    } else {
      consola.warn(
        `[security] Failed auth attempt from ${ip} (${entry.count}/3)`,
      )
    }
    return entry.count
  } else {
    // Different day: reset to 1
    ipTracker.set(ip, { count: 1, date: today })
    consola.warn(`[security] Failed auth attempt from ${ip} (1/3)`)
    return 1
  }
}
