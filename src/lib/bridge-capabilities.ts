import { createHash, randomBytes } from "node:crypto"

import {
  extractRequestCredential,
  registerCredentialProvider,
  resolveRequestCredentialKind,
} from "./credential-resolver"

const WORKER_CAPABILITY_TTL_MS = 60 * 60 * 1000
const ENVIRONMENT_CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface WorkerCapability {
  sessionId: string
  workerEpoch?: number
  expiresAt: number
}

interface EnvironmentCapability {
  environmentId: string
  expiresAt: number
}

export interface AuthorizedWorkerCapability {
  rawCredential: string
  workerEpoch?: number
}

const workerCapabilities = new Map<string, WorkerCapability>()
const environmentCapabilities = new Map<string, EnvironmentCapability>()

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function randomCapability(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`
}

function pruneExpired<T extends { expiresAt: number }>(
  records: Map<string, T>,
  now = Date.now(),
): void {
  for (const [key, record] of records) {
    if (record.expiresAt <= now) records.delete(key)
  }
}

export function issueWorkerCapability(
  sessionId: string,
  workerEpoch?: number,
): string {
  pruneExpired(workerCapabilities)
  const capability = randomCapability("worker_")
  workerCapabilities.set(digest(capability), {
    sessionId,
    workerEpoch,
    expiresAt: Date.now() + WORKER_CAPABILITY_TTL_MS,
  })
  return capability
}

function resolveWorkerCapability(
  request: Request,
  sessionId: string,
): AuthorizedWorkerCapability | null {
  pruneExpired(workerCapabilities)
  const rawCredential = extractRequestCredential(request)
  if (!rawCredential) return null
  const record = workerCapabilities.get(digest(rawCredential))
  if (!record || record.sessionId !== sessionId) return null
  return { rawCredential, workerEpoch: record.workerEpoch }
}

export async function authorizeWorkerCapability(
  request: Request,
  sessionId: string,
): Promise<AuthorizedWorkerCapability | null> {
  const credential = await resolveRequestCredentialKind(request, "worker", {
    sessionId,
  })
  const rawCredential = credential?.metadata?.rawCredential
  const workerEpoch = credential?.metadata?.workerEpoch
  if (typeof rawCredential !== "string") return null
  return {
    rawCredential,
    ...(typeof workerEpoch === "number" ? { workerEpoch } : {}),
  }
}

export function bindWorkerCapability(
  rawCredential: string,
  sessionId: string,
  workerEpoch: number,
): boolean {
  const record = workerCapabilities.get(digest(rawCredential))
  if (
    !record
    || record.sessionId !== sessionId
    || record.expiresAt <= Date.now()
  ) {
    return false
  }
  record.workerEpoch = workerEpoch
  return true
}

export function revokeSessionCapabilities(sessionId: string): void {
  for (const [key, record] of workerCapabilities) {
    if (record.sessionId === sessionId) workerCapabilities.delete(key)
  }
}

export function issueEnvironmentCapability(environmentId: string): string {
  revokeEnvironmentCapabilities(environmentId)
  pruneExpired(environmentCapabilities)
  const capability = randomCapability("environment_")
  environmentCapabilities.set(digest(capability), {
    environmentId,
    expiresAt: Date.now() + ENVIRONMENT_CAPABILITY_TTL_MS,
  })
  return capability
}

function resolveEnvironmentCapability(
  request: Request,
  environmentId: string,
): boolean {
  pruneExpired(environmentCapabilities)
  const rawCredential = extractRequestCredential(request)
  if (!rawCredential) return false
  return (
    environmentCapabilities.get(digest(rawCredential))?.environmentId
    === environmentId
  )
}

export async function authorizeEnvironmentCapability(
  request: Request,
  environmentId: string,
): Promise<boolean> {
  return (
    (await resolveRequestCredentialKind(request, "environment", {
      environmentId,
    })) !== null
  )
}

export function revokeEnvironmentCapabilities(environmentId: string): void {
  for (const [key, record] of environmentCapabilities) {
    if (record.environmentId === environmentId) {
      environmentCapabilities.delete(key)
    }
  }
}

export function resetBridgeCapabilitiesForTest(): void {
  workerCapabilities.clear()
  environmentCapabilities.clear()
}

registerCredentialProvider("worker", (request, context) => {
  if (!context.sessionId) return null
  const capability = resolveWorkerCapability(request, context.sessionId)
  return capability ?
      {
        kind: "worker",
        metadata: {
          rawCredential: capability.rawCredential,
          ...(capability.workerEpoch === undefined ?
            {}
          : { workerEpoch: capability.workerEpoch }),
        },
        principalId: `worker:${context.sessionId}`,
        scopes: new Set<string>(),
      }
    : null
})

registerCredentialProvider("environment", (request, context) => {
  if (
    !context.environmentId
    || !resolveEnvironmentCapability(request, context.environmentId)
  ) {
    return null
  }
  return {
    kind: "environment",
    principalId: `environment:${context.environmentId}`,
    scopes: new Set<string>(),
  }
})
