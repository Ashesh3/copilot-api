const LEASE_TTL_MS = 24 * 60 * 60_000
const MAX_LEASES = 10_000
const MAX_AFFINITY_KEY_LENGTH = 512

interface RoutingAffinityLease {
  accountId: number
  assignedAt: number
}

let leases = new Map<string, RoutingAffinityLease>()

function validKey(key: unknown): key is string {
  return (
    typeof key === "string"
    && key.length > 0
    && key.trim() === key
    && key.length <= MAX_AFFINITY_KEY_LENGTH
  )
}

function validAccountId(accountId: unknown): accountId is number {
  return (
    typeof accountId === "number"
    && Number.isSafeInteger(accountId)
    && accountId >= 0
  )
}

function validTimestamp(timestamp: unknown): timestamp is number {
  return typeof timestamp === "number" && Number.isFinite(timestamp)
}

export function getRoutingAffinityLease(
  key: string,
  now = Date.now(),
): number | undefined {
  try {
    if (!validKey(key) || !validTimestamp(now)) return undefined
    const lease = leases.get(key)
    if (!lease) return undefined
    if (now - lease.assignedAt >= LEASE_TTL_MS) {
      leases.delete(key)
      return undefined
    }
    return lease.accountId
  } catch {
    return undefined
  }
}

export function setRoutingAffinityLease(
  key: string,
  accountId: number,
  now = Date.now(),
): void {
  try {
    if (!validKey(key) || !validAccountId(accountId) || !validTimestamp(now)) {
      return
    }
    leases.delete(key)
    leases.set(key, { accountId, assignedAt: now })
    if (leases.size <= MAX_LEASES) return
    const oldestKey = leases.keys().next().value
    if (oldestKey !== undefined) leases.delete(oldestKey)
  } catch {
    // Affinity leases must never affect routing.
  }
}

export function resetRoutingAffinityLeasesForTest(): void {
  leases = new Map()
}
