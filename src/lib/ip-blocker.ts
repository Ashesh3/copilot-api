import type { Context } from "hono"

import consola from "consola"

import {
  isManagedIpAllowed,
  isManagedIpDisabled,
  normalizeIpAddress,
} from "./ip-allowlist"

export const AUTH_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000
export const IP_BAN_DURATION_MS = 24 * 60 * 60 * 1000
export const AUTH_FAILURE_THRESHOLD = 3

interface IpEntry {
  failures: Array<number>
  bannedUntil?: number
}

interface IpLease {
  expiresAt: number
}

interface CidrRange {
  family: 4 | 6
  network: bigint
  prefix: number
}

const PEER_IP_HEADER = "x-copilot-peer-ip"
const DEFAULT_TRUSTED_PROXY_CIDRS = "127.0.0.1/32,::1/128"
const ipTracker = new Map<string, IpEntry>()
const ipLeases = new Map<string, IpLease>()
let trustedProxyCache: { raw: string; ranges: Array<CidrRange> } | undefined

function ipv4ToBigInt(ip: string): bigint {
  return ip
    .split(".")
    .reduce((value, octet) => (value << 8n) | BigInt(octet), 0n)
}

function ipv6ToBigInt(ip: string): bigint {
  const [leftRaw, rightRaw = ""] = ip.split("::", 2)
  const left = leftRaw ? leftRaw.split(":") : []
  const right = rightRaw ? rightRaw.split(":") : []
  const missing = 8 - left.length - right.length
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ]
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)),
    0n,
  )
}

function ipToBigInt(ip: string): { family: 4 | 6; value: bigint } | null {
  const normalized = normalizeIpAddress(ip)
  if (!normalized) return null
  return normalized.includes(":") ?
      { family: 6, value: ipv6ToBigInt(normalized) }
    : { family: 4, value: ipv4ToBigInt(normalized) }
}

function parseCidr(value: string): CidrRange | null {
  const [address, prefixRaw] = value.trim().split("/", 2)
  if (!address) return null

  const parsed = ipToBigInt(address)
  if (!parsed) return null
  const bits = parsed.family === 4 ? 32 : 128
  const prefix = prefixRaw ? Number(prefixRaw) : bits
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null

  const shift = BigInt(bits - prefix)
  const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift
  return { family: parsed.family, network, prefix }
}

function getTrustedProxyRanges(): Array<CidrRange> {
  const raw =
    process.env.COPILOT_TRUSTED_PROXY_CIDRS ?? DEFAULT_TRUSTED_PROXY_CIDRS
  if (trustedProxyCache?.raw === raw) return trustedProxyCache.ranges

  const ranges = raw
    .split(",")
    .map((value) => parseCidr(value))
    .filter((range): range is CidrRange => range !== null)
  trustedProxyCache = { raw, ranges }
  return ranges
}

function isInCidr(ip: string, range: CidrRange): boolean {
  const parsed = ipToBigInt(ip)
  if (!parsed || parsed.family !== range.family) return false
  const bits = parsed.family === 4 ? 32 : 128
  const shift = BigInt(bits - range.prefix)
  const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift
  return network === range.network
}

export function isTrustedProxyPeer(ip: string): boolean {
  return getTrustedProxyRanges().some((range) => isInCidr(ip, range))
}

function getForwardedClientIp(headers: Headers): string | null {
  const xRealIp = normalizeIpAddress(headers.get("x-real-ip") ?? "")
  if (xRealIp) return xRealIp

  const forwarded = headers.get("x-forwarded-for")
  if (!forwarded) return null
  const first = forwarded.split(",", 1)[0]
  return first ? normalizeIpAddress(first) : null
}

/**
 * Resolve the client address using socket metadata injected by Bun. Forwarding
 * headers are considered only when that actual socket peer is an approved
 * proxy. Direct requests use the socket peer and cannot spoof this header
 * because `start.ts` overwrites it before Hono receives the request.
 */
export function extractClientIp(c: Context): string | null {
  return extractClientIpFromHeaders(c.req.raw.headers)
}

export function extractClientIpFromHeaders(headers: Headers): string | null {
  const peerIp = normalizeIpAddress(headers.get(PEER_IP_HEADER) ?? "")
  if (!peerIp) return null
  if (!isTrustedProxyPeer(peerIp)) return peerIp
  return getForwardedClientIp(headers)
}

function pruneEntry(entry: IpEntry, currentTime: number): void {
  entry.failures = entry.failures.filter(
    (timestamp) => currentTime - timestamp < AUTH_FAILURE_WINDOW_MS,
  )
  if (entry.bannedUntil !== undefined && entry.bannedUntil <= currentTime) {
    delete entry.bannedUntil
  }
}

/** Create an explicit, expiring IP lease. This is never called after auth. */
export function leaseIp(ip: string, ttlMs: number): boolean {
  const normalized = normalizeIpAddress(ip)
  if (!normalized || !Number.isFinite(ttlMs) || ttlMs <= 0) return false
  ipLeases.set(normalized, { expiresAt: Date.now() + ttlMs })
  return true
}

export function isIpWhitelisted(ip: string): boolean {
  const normalized = normalizeIpAddress(ip)
  if (!normalized) return false
  const lease = ipLeases.get(normalized)
  if (!lease) return false
  if (lease.expiresAt <= Date.now()) {
    ipLeases.delete(normalized)
    return false
  }
  return true
}

export function unwhitelistIp(ip: string): boolean {
  const normalized = normalizeIpAddress(ip)
  return normalized ? ipLeases.delete(normalized) : false
}

export async function isIpAllowedForWhitelistedRoute(
  ip: string,
): Promise<boolean> {
  const normalized = normalizeIpAddress(ip)
  if (!normalized || (await isManagedIpDisabled(normalized))) return false
  return isIpWhitelisted(normalized) || (await isManagedIpAllowed(normalized))
}

export function isIpBlocked(ip: string): boolean {
  const normalized = normalizeIpAddress(ip)
  if (!normalized) return true
  if (isIpWhitelisted(normalized)) return false

  const entry = ipTracker.get(normalized)
  if (!entry) return false
  const currentTime = Date.now()
  pruneEntry(entry, currentTime)
  if (entry.failures.length === 0 && entry.bannedUntil === undefined) {
    ipTracker.delete(normalized)
    return false
  }
  if (entry.bannedUntil !== undefined && entry.bannedUntil > currentTime) {
    consola.debug(`[security] Blocked request from banned IP ${normalized}`)
    return true
  }
  return false
}

export function recordFailedAttempt(ip: string): number {
  const normalized = normalizeIpAddress(ip)
  if (!normalized) return AUTH_FAILURE_THRESHOLD

  const currentTime = Date.now()
  const entry = ipTracker.get(normalized) ?? { failures: [] }
  pruneEntry(entry, currentTime)
  entry.failures.push(currentTime)
  ipTracker.set(normalized, entry)

  const failureCount = entry.failures.length
  if (failureCount >= AUTH_FAILURE_THRESHOLD) {
    entry.bannedUntil = currentTime + IP_BAN_DURATION_MS
  }
  if (failureCount === AUTH_FAILURE_THRESHOLD) {
    consola.warn(
      `[security] IP ${normalized} banned after repeated auth failures`,
    )
  } else if (failureCount === 1) {
    consola.warn(
      `[security] Failed auth attempt from ${normalized} (1/${AUTH_FAILURE_THRESHOLD})`,
    )
  } else {
    consola.warn(`[security] Failed auth attempt from ${normalized}`)
  }
  return failureCount
}

export function resetIpSecurityForTest(): void {
  ipTracker.clear()
  ipLeases.clear()
  trustedProxyCache = undefined
}
