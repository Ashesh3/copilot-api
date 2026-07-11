import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { isIP } from "node:net"

import { PATHS } from "./paths"

export interface IpAllowlistEntry {
  ip: string
  enabled: boolean
  source: "dashboard" | "manual"
  createdAt: string
  updatedAt: string
  lastSeenAt?: string
}

const IPV4_MAPPED_PREFIX = "::ffff:"

let entries: Array<IpAllowlistEntry> = []
let isLoaded = false
let skipPersistForTest = false

/** Canonicalize a literal IPv4/IPv6 address. Hostnames and zone IDs are rejected. */
export function normalizeIpAddress(ip: string): string | null {
  let candidate = ip.trim()
  if (!candidate) return null

  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1)
  }
  if (candidate.includes("%")) return null

  const family = isIP(candidate)
  if (family === 4) return candidate
  if (family !== 6) return null

  if (candidate.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
    const mapped = candidate.slice(IPV4_MAPPED_PREFIX.length)
    if (isIP(mapped) === 4) return mapped
  }

  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname
    const normalized = hostname.slice(1, -1).toLowerCase()
    if (normalized.startsWith(IPV4_MAPPED_PREFIX)) {
      const mapped = normalized.slice(IPV4_MAPPED_PREFIX.length)
      if (isIP(mapped) === 4) return mapped
    }
    return normalized
  } catch {
    return null
  }
}

function normalizeEntry(raw: unknown): IpAllowlistEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined
  }

  const value = raw as Record<string, unknown>
  const ip = typeof value.ip === "string" ? normalizeIpAddress(value.ip) : null
  if (ip === null) return undefined

  const now = new Date().toISOString()
  return {
    ip,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    source: value.source === "dashboard" ? "dashboard" : "manual",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    lastSeenAt:
      typeof value.lastSeenAt === "string" ? value.lastSeenAt : undefined,
  }
}

function normalizeEntries(raw: unknown): Array<IpAllowlistEntry> {
  if (!Array.isArray(raw)) return []

  const byIp = new Map<string, IpAllowlistEntry>()
  for (const item of raw) {
    const entry = normalizeEntry(item)
    if (entry) byIp.set(entry.ip, entry)
  }
  return [...byIp.values()].sort((a, b) => a.ip.localeCompare(b.ip))
}

async function loadAllowlist(): Promise<void> {
  skipPersistForTest = false
  try {
    const raw = await fs.readFile(PATHS.IP_ALLOWLIST_PATH)
    entries = normalizeEntries(JSON.parse(raw.toString("utf8")) as unknown)
  } catch {
    entries = []
  }
  isLoaded = true
}

async function saveAllowlist(): Promise<void> {
  if (skipPersistForTest) return

  const temporaryPath = `${PATHS.IP_ALLOWLIST_PATH}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(PATHS.APP_DIR, { recursive: true, mode: 0o700 })
    await fs.chmod(PATHS.APP_DIR, 0o700)
    await fs.writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await fs.chmod(temporaryPath, 0o600)
    await fs.rename(temporaryPath, PATHS.IP_ALLOWLIST_PATH)
    await fs.chmod(PATHS.IP_ALLOWLIST_PATH, 0o600)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    consola.error("Failed to save IP allowlist:", error)
    throw error
  }
}

async function ensureLoaded(): Promise<void> {
  if (!isLoaded) await loadAllowlist()
}

export function isValidIpAddress(ip: string): boolean {
  return normalizeIpAddress(ip) !== null
}

export async function listIpAllowlist(): Promise<Array<IpAllowlistEntry>> {
  await ensureLoaded()
  return entries.map((entry) => ({ ...entry }))
}

export async function upsertIpAllowlistEntry(
  ip: string,
  options: {
    enabled?: boolean
    source?: IpAllowlistEntry["source"]
    seen?: boolean
  } = {},
): Promise<IpAllowlistEntry | null> {
  await ensureLoaded()

  const normalizedIp = normalizeIpAddress(ip)
  if (normalizedIp === null) return null

  const now = new Date().toISOString()
  const existing = entries.find((entry) => entry.ip === normalizedIp)

  if (existing) {
    if (options.enabled !== undefined) existing.enabled = options.enabled
    if (options.source !== undefined) existing.source = options.source
    existing.updatedAt = now
    if (options.seen) existing.lastSeenAt = now
    await saveAllowlist()
    return { ...existing }
  }

  const entry: IpAllowlistEntry = {
    ip: normalizedIp,
    enabled: options.enabled ?? true,
    source: options.source ?? "manual",
    createdAt: now,
    updatedAt: now,
    ...(options.seen ? { lastSeenAt: now } : {}),
  }
  entries.push(entry)
  entries.sort((a, b) => a.ip.localeCompare(b.ip))
  await saveAllowlist()
  consola.info(`[security] IP ${normalizedIp} added to managed allowlist`)
  return { ...entry }
}

export async function removeIpAllowlistEntry(ip: string): Promise<boolean> {
  await ensureLoaded()

  const normalizedIp = normalizeIpAddress(ip)
  if (normalizedIp === null) return false

  const before = entries.length
  entries = entries.filter((entry) => entry.ip !== normalizedIp)
  if (entries.length === before) return false

  await saveAllowlist()
  consola.info(`[security] IP ${normalizedIp} removed from managed allowlist`)
  return true
}

export async function setIpAllowlistEntryEnabled(
  ip: string,
  enabled: boolean,
): Promise<IpAllowlistEntry | null> {
  return await upsertIpAllowlistEntry(ip, { enabled })
}

export async function isManagedIpAllowed(ip: string): Promise<boolean> {
  await ensureLoaded()
  const normalizedIp = normalizeIpAddress(ip)
  if (normalizedIp === null) return false

  return entries.some((entry) => entry.ip === normalizedIp && entry.enabled)
}

export async function isManagedIpDisabled(ip: string): Promise<boolean> {
  await ensureLoaded()
  const normalizedIp = normalizeIpAddress(ip)
  if (normalizedIp === null) return false

  return entries.some((entry) => entry.ip === normalizedIp && !entry.enabled)
}

export function setIpAllowlistForTest(rawEntries: Array<unknown>): void {
  entries = normalizeEntries(rawEntries)
  isLoaded = true
  skipPersistForTest = true
}
