import type { Context } from "hono"

import {
  addReplacement,
  getAllReplacements,
  removeReplacement,
  toggleReplacement,
} from "~/lib/auto-replace"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { getUsageResponse } from "~/lib/usage-tracker"
import {
  archiveSession,
  getClientEvents,
  listSessions,
} from "~/routes/code-sessions/session-store"
import {
  destroyDirectConnectSession,
  listDirectConnectSessions,
} from "~/routes/direct-connect/ws-handler"
import {
  deregisterEnvironment,
  listEnvironments,
} from "~/routes/environments/environment-store"
import {
  getFeatureFlags,
  removeFeatureFlag,
  setFeatureFlag,
} from "~/routes/feature-flags/store"

import packageJson from "../../../package.json" with { type: "json" }

const serverStartTime = Date.now()

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  const parts: Array<string> = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)

  return parts.join(" ")
}

export function handleOverview(c: Context) {
  const codeSessions = listSessions().filter((s) => !s.archived)
  const directConnectSessions = listDirectConnectSessions()
  const environments = listEnvironments()
  const flags = getFeatureFlags()

  const uptimeMs = Date.now() - serverStartTime

  return c.json({
    activeSessions: codeSessions.length + directConnectSessions.length,
    codeSessionsCount: codeSessions.length,
    directConnectCount: directConnectSessions.length,
    environmentsCount: environments.length,
    flagsCount: Object.keys(flags).length,
    uptime: formatUptime(uptimeMs),
    health: "ok",
  })
}

export function handleListSessions(c: Context) {
  const codeSessions = listSessions()
    .filter((s) => !s.archived)
    .map((s) => ({
      id: s.id,
      title: s.title,
      state: s.state,
      type: "code-session" as const,
      createdAt: s.createdAt,
      lastHeartbeat: s.lastHeartbeat,
      tags: s.tags,
    }))

  const directConnectSessions = listDirectConnectSessions().map((s) => ({
    id: s.id,
    title: s.id,
    state: "connected" as const,
    type: "direct-connect" as const,
    createdAt: s.createdAt,
    lastHeartbeat: null,
    tags: [],
  }))

  return c.json([...codeSessions, ...directConnectSessions])
}

export function handleArchiveSession(c: Context) {
  const id = c.req.param("id")
  const success = archiveSession(id)
  if (!success) {
    return c.json({ error: "Session not found or already archived" }, 404)
  }
  return c.json({ success: true })
}

export function handleDestroySession(c: Context) {
  const id = c.req.param("id")

  // Try direct-connect first
  if (destroyDirectConnectSession(id)) {
    return c.json({ success: true })
  }

  // Fall back to archiving code session
  if (archiveSession(id)) {
    return c.json({ success: true })
  }

  return c.json({ error: "Session not found" }, 404)
}

export function handleGetSessionEvents(c: Context) {
  const id = c.req.param("id")
  const allEvents = getClientEvents(id, 0)
  const last20 = allEvents.slice(-20)
  return c.json(last20)
}

export function handleListEnvironments(c: Context) {
  const envs = listEnvironments().map((env) => ({
    id: env.id,
    machineName: env.machineName,
    directory: env.directory,
    branch: env.branch,
    gitRepoUrl: env.gitRepoUrl,
    maxSessions: env.maxSessions,
    createdAt: env.createdAt,
    pendingWorkCount: env.workQueue.filter((w) => w.state === "pending").length,
  }))
  return c.json(envs)
}

export function handleDeregisterEnvironment(c: Context) {
  const id = c.req.param("id")
  const success = deregisterEnvironment(id)
  if (!success) {
    return c.json({ error: "Environment not found" }, 404)
  }
  return c.json({ success: true })
}

export function handleListFlags(c: Context) {
  return c.json(getFeatureFlags())
}

export async function handleSetFlag(c: Context) {
  const body = await c.req.json<{ name: string; value: unknown }>()
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }
  setFeatureFlag(
    body.name,
    body.value as boolean | string | number | Record<string, unknown>,
  )
  return c.json({ success: true })
}

export async function handleDeleteFlag(c: Context) {
  const body = await c.req.json<{ name: string }>()
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }
  const removed = removeFeatureFlag(body.name)
  if (!removed) {
    return c.json({ error: "Flag not found" }, 404)
  }
  return c.json({ success: true })
}

export async function handleListReplacements(c: Context) {
  const replacements = await getAllReplacements()
  return c.json(replacements)
}

export async function handleAddReplacement(c: Context) {
  const body = await c.req.json<{
    pattern: string
    replacement?: string
    isRegex?: boolean
    name?: string
  }>()
  if (!body.pattern || typeof body.pattern !== "string") {
    return c.json({ error: "pattern is required" }, 400)
  }
  const rule = await addReplacement(body.pattern, body.replacement ?? "", {
    isRegex: body.isRegex,
    name: body.name,
  })
  return c.json(rule)
}

export async function handleDeleteReplacement(c: Context) {
  const id = c.req.param("id")
  const removed = await removeReplacement(id)
  if (!removed) {
    return c.json({ error: "Replacement not found" }, 404)
  }
  return c.json({ success: true })
}

export async function handleToggleReplacement(c: Context) {
  const id = c.req.param("id")
  const rule = await toggleReplacement(id)
  if (!rule) {
    return c.json({ error: "Replacement not found or is a system rule" }, 404)
  }
  return c.json(rule)
}

export function handleGetUsage(c: Context) {
  return c.json(getUsageResponse())
}

export function handleGetSettings(c: Context) {
  return c.json({
    version: packageJson.version,
    port: process.env.PORT ?? "4141",
    host: process.env.HOST ?? "localhost",
    authEnabled: Boolean(state.apiKeyAuth),
    multiToken: state.isMultiToken,
    rateLimitSeconds: state.rateLimitSeconds ?? null,
    sentryEnabled: Boolean(process.env.SENTRY_DSN),
    groqEnabled: Boolean(process.env.GROQ_API_KEY),
    dataDir: PATHS.APP_DIR,
    debug: state.debug,
    verbose: state.verbose,
  })
}
