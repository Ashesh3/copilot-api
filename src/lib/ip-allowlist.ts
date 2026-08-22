import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { isIP } from "node:net"

import { PATHS } from "./paths"

export interface IpAllowlistEntry {
  ip: string
  enabled: boolean
  source: "authenticated" | "dashboard" | "manual"
  createdAt: string
  updatedAt: string
  lastSeenAt?: string
}

const IPV4_MAPPED_PREFIX = "::ffff:"

let entries: Array<IpAllowlistEntry> = []
let isLoaded = false
let skipPersistForTest = false
let allowlistOperation: Promise<void> = Promise.resolve()

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

  let source: IpAllowlistEntry["source"] = "manual"
  if (value.source === "authenticated") source = "authenticated"
  else if (value.source === "dashboard") source = "dashboard"

  const now = new Date().toISOString()
  return {
    ip,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    source,
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

function normalizeDurableEntries(raw: unknown): Array<IpAllowlistEntry> {
  if (!Array.isArray(raw)) {
    throw new TypeError("Invalid IP allowlist: expected an array")
  }

  const byIp = new Map<string, IpAllowlistEntry>()
  for (const item of raw) {
    const entry = normalizeDurableEntry(item)
    byIp.set(entry.ip, entry)
  }
  return [...byIp.values()].sort((a, b) => a.ip.localeCompare(b.ip))
}

function normalizeDurableEntry(raw: unknown): IpAllowlistEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("Invalid IP allowlist entry")
  }

  const value = raw as Record<string, unknown>
  const ip = typeof value.ip === "string" ? normalizeIpAddress(value.ip) : null
  if (ip === null) throw new Error("Invalid IP allowlist entry IP")
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new TypeError("Invalid IP allowlist entry enabled")
  }
  if (value.source !== undefined && !isIpAllowlistSource(value.source)) {
    throw new TypeError("Invalid IP allowlist entry source")
  }
  const createdAt = readOptionalDurableString(value, "createdAt")
  const updatedAt = readOptionalDurableString(value, "updatedAt")
  const lastSeenAt = readOptionalDurableString(value, "lastSeenAt")

  const now = new Date().toISOString()
  return {
    ip,
    enabled: value.enabled ?? true,
    source: isIpAllowlistSource(value.source) ? value.source : "manual",
    createdAt: createdAt ?? now,
    updatedAt: updatedAt ?? now,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  }
}

function isIpAllowlistSource(
  value: unknown,
): value is IpAllowlistEntry["source"] {
  return (
    value === "authenticated" || value === "dashboard" || value === "manual"
  )
}

function readOptionalDurableString(
  value: Record<string, unknown>,
  field: "createdAt" | "lastSeenAt" | "updatedAt",
): string | undefined {
  const fieldValue = value[field]
  if (fieldValue !== undefined && typeof fieldValue !== "string") {
    throw new TypeError(`Invalid IP allowlist entry ${field}`)
  }
  return fieldValue
}

async function loadAllowlist(): Promise<void> {
  skipPersistForTest = false
  try {
    const raw = await fs.readFile(PATHS.IP_ALLOWLIST_PATH)
    entries = normalizeDurableEntries(
      JSON.parse(raw.toString("utf8")) as unknown,
    )
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      entries = []
    } else {
      throw error
    }
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

function serializeAllowlistOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = allowlistOperation.then(operation, operation)
  allowlistOperation = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export function isValidIpAddress(ip: string): boolean {
  return normalizeIpAddress(ip) !== null
}

export async function listIpAllowlist(): Promise<Array<IpAllowlistEntry>> {
  return await serializeAllowlistOperation(async () => {
    await ensureLoaded()
    return entries.map((entry) => ({ ...entry }))
  })
}

export async function upsertIpAllowlistEntry(
  ip: string,
  options: {
    enabled?: boolean
    source?: IpAllowlistEntry["source"]
    seen?: boolean
  } = {},
): Promise<IpAllowlistEntry | null> {
  return await serializeAllowlistOperation(async () => {
    await ensureLoaded()

    const normalizedIp = normalizeIpAddress(ip)
    if (normalizedIp === null) return null

    const now = new Date().toISOString()
    const existingIndex = entries.findIndex(
      (entry) => entry.ip === normalizedIp,
    )
    const existing = entries.find((entry) => entry.ip === normalizedIp)

    if (existing) {
      const updated = {
        ...existing,
        ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
        ...(options.source === undefined ? {} : { source: options.source }),
        updatedAt: now,
        ...(options.seen ? { lastSeenAt: now } : {}),
      }
      const previousEntries = entries
      entries = entries.map((entry, index) =>
        index === existingIndex ? updated : entry,
      )
      try {
        await saveAllowlist()
      } catch (error) {
        // eslint-disable-next-line require-atomic-updates
        entries = previousEntries
        throw error
      }
      return { ...updated }
    }

    const entry: IpAllowlistEntry = {
      ip: normalizedIp,
      enabled: options.enabled ?? true,
      source: options.source ?? "manual",
      createdAt: now,
      updatedAt: now,
      ...(options.seen ? { lastSeenAt: now } : {}),
    }
    const previousEntries = entries
    entries = [...entries, entry].sort((a, b) => a.ip.localeCompare(b.ip))
    try {
      await saveAllowlist()
    } catch (error) {
      // eslint-disable-next-line require-atomic-updates
      entries = previousEntries
      throw error
    }
    consola.info(`[security] IP ${normalizedIp} added to managed allowlist`)
    return { ...entry }
  })
}

export async function promoteAuthenticatedIpAllowlistEntry(
  ip: string,
): Promise<IpAllowlistEntry | null> {
  return await serializeAllowlistOperation(async () => {
    await ensureLoaded()

    const normalizedIp = normalizeIpAddress(ip)
    if (normalizedIp === null) return null

    const existingIndex = entries.findIndex(
      (entry) => entry.ip === normalizedIp,
    )
    const existing = entries.find((entry) => entry.ip === normalizedIp)
    const now = new Date().toISOString()

    if (existing) {
      if (existing.enabled && existing.lastSeenAt !== undefined) {
        return { ...existing }
      }

      const updated: IpAllowlistEntry = {
        ...existing,
        enabled: true,
        updatedAt: now,
        lastSeenAt: now,
      }
      const previousEntries = entries
      entries = entries.map((entry, index) =>
        index === existingIndex ? updated : entry,
      )
      try {
        await saveAllowlist()
      } catch (error) {
        // eslint-disable-next-line require-atomic-updates
        entries = previousEntries
        throw error
      }
      return { ...updated }
    }

    const created: IpAllowlistEntry = {
      ip: normalizedIp,
      enabled: true,
      source: "authenticated",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }
    const previousEntries = entries
    entries = [...entries, created].sort((a, b) => a.ip.localeCompare(b.ip))
    try {
      await saveAllowlist()
    } catch (error) {
      // eslint-disable-next-line require-atomic-updates
      entries = previousEntries
      throw error
    }
    consola.info(`[security] IP ${normalizedIp} added to managed allowlist`)
    return { ...created }
  })
}

export async function removeIpAllowlistEntry(ip: string): Promise<boolean> {
  return await serializeAllowlistOperation(async () => {
    await ensureLoaded()

    const normalizedIp = normalizeIpAddress(ip)
    if (normalizedIp === null) return false

    const before = entries
    entries = entries.filter((entry) => entry.ip !== normalizedIp)
    if (entries.length === before.length) return false

    try {
      await saveAllowlist()
    } catch (error) {
      // eslint-disable-next-line require-atomic-updates
      entries = before
      throw error
    }
    consola.info(`[security] IP ${normalizedIp} removed from managed allowlist`)
    return true
  })
}

export async function clearIpAllowlist(): Promise<Array<IpAllowlistEntry>> {
  return await serializeAllowlistOperation(async () => {
    await ensureLoaded()
    const removed = entries.map((entry) => ({ ...entry }))
    if (removed.length === 0) return removed
    entries = []
    try {
      await saveAllowlist()
    } catch (error) {
      // eslint-disable-next-line require-atomic-updates
      entries = removed
      throw error
    }
    consola.info("[security] Managed IP allowlist cleared")
    return removed
  })
}

export async function setIpAllowlistEntryEnabled(
  ip: string,
  enabled: boolean,
): Promise<IpAllowlistEntry | null> {
  return await upsertIpAllowlistEntry(ip, { enabled })
}

export async function isManagedIpAllowed(ip: string): Promise<boolean> {
  return await serializeAllowlistOperation(async () => {
    await ensureLoaded()
    const normalizedIp = normalizeIpAddress(ip)
    if (normalizedIp === null) return false

    return entries.some((entry) => entry.ip === normalizedIp && entry.enabled)
  })
}

export async function isManagedIpAllowedForTransparentProxy(
  ip: string,
): Promise<boolean> {
  return await serializeAllowlistOperation(async () => {
    await ensureLoaded()
    const normalizedIp = normalizeIpAddress(ip)
    if (normalizedIp === null) return false

    return entries.some(
      (entry) =>
        entry.ip === normalizedIp
        && entry.enabled
        && entry.source !== "authenticated",
    )
  })
}

export async function isManagedIpDisabled(ip: string): Promise<boolean> {
  return await serializeAllowlistOperation(async () => {
    await ensureLoaded()
    const normalizedIp = normalizeIpAddress(ip)
    if (normalizedIp === null) return false

    return entries.some((entry) => entry.ip === normalizedIp && !entry.enabled)
  })
}

export function setIpAllowlistForTest(rawEntries: Array<unknown>): void {
  entries = normalizeEntries(rawEntries)
  isLoaded = true
  skipPersistForTest = true
}

export function resetIpAllowlistForTest(): void {
  entries = []
  isLoaded = false
  skipPersistForTest = false
  allowlistOperation = Promise.resolve()
}
