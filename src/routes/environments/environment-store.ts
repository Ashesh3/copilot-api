import consola from "consola"
import { randomUUID } from "node:crypto"

import type { Environment, WorkItem } from "./types"

const environments = new Map<string, Environment>()

function generateId(): string {
  return `env_${randomUUID().replaceAll("-", "").slice(0, 24)}`
}

function generateSecret(): string {
  return randomUUID()
}

export function registerEnvironment(params: {
  machine_name: string
  directory: string
  branch: string
  git_repo_url?: string | null
  max_sessions?: number
  metadata?: Record<string, unknown>
  environment_id?: string
}): { environment_id: string; environment_secret: string } {
  const id = params.environment_id ?? generateId()

  // If re-registering with the same id, reuse it
  const existing = environments.get(id)
  if (existing) {
    consola.info(`Re-registering environment ${id}`)
    existing.machineName = params.machine_name
    existing.directory = params.directory
    existing.branch = params.branch
    existing.gitRepoUrl = params.git_repo_url ?? null
    existing.maxSessions = params.max_sessions ?? 1
    existing.metadata = params.metadata ?? {}
    return { environment_id: id, environment_secret: existing.secret }
  }

  const secret = generateSecret()
  const env: Environment = {
    id,
    secret,
    machineName: params.machine_name,
    directory: params.directory,
    branch: params.branch,
    gitRepoUrl: params.git_repo_url ?? null,
    maxSessions: params.max_sessions ?? 1,
    metadata: params.metadata ?? {},
    createdAt: Date.now(),
    workQueue: [],
  }
  environments.set(id, env)
  consola.info(`Registered environment ${id}`)
  return { environment_id: id, environment_secret: secret }
}

export function getEnvironment(id: string): Environment | undefined {
  return environments.get(id)
}

export function deregisterEnvironment(id: string): boolean {
  const deleted = environments.delete(id)
  if (deleted) {
    consola.info(`Deregistered environment ${id}`)
  }
  return deleted
}

export function pollForWork(id: string): WorkItem | null {
  const env = environments.get(id)
  if (!env) return null
  const pending = env.workQueue.find((w) => w.state === "pending")
  return pending ?? null
}

export function acknowledgeWork(envId: string, workId: string): boolean {
  const env = environments.get(envId)
  if (!env) return false
  const item = env.workQueue.find((w) => w.id === workId)
  if (!item) return false
  item.state = "acknowledged"
  return true
}

export function stopWork(envId: string, workId: string): boolean {
  const env = environments.get(envId)
  if (!env) return false
  const item = env.workQueue.find((w) => w.id === workId)
  if (!item) return false
  item.state = "stopped"
  return true
}

export function enqueueWork(
  envId: string,
  sessionId: string,
  type: "session" | "healthcheck" = "session",
): WorkItem | null {
  const env = environments.get(envId)
  if (!env) return null

  const secretPayload = JSON.stringify({
    session_ingress_token: randomUUID(),
    api_base_url: `/v1/environments/${envId}`,
    session_id: sessionId,
  })
  const encodedSecret = Buffer.from(secretPayload).toString("base64url")

  const item: WorkItem = {
    id: randomUUID(),
    type: "work",
    environment_id: envId,
    state: "pending",
    data: {
      type,
      id: sessionId,
    },
    secret: encodedSecret,
    created_at: new Date().toISOString(),
  }
  env.workQueue.push(item)
  consola.debug(`Enqueued work ${item.id} for environment ${envId}`)
  return item
}
