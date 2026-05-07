import type { Context } from "hono"

import {
  addReplacement,
  getAllReplacements,
  removeReplacement,
  toggleReplacement,
} from "~/lib/auto-replace"
import {
  addModelRedirect,
  getAllModelRedirects,
  moveModelRedirect,
  removeModelRedirect,
  toggleModelRedirect,
  updateModelRedirect,
} from "~/lib/model-redirect"
import { setModelRoutingOverride } from "~/lib/model-routing"
import {
  getAllModelSettings,
  isReasoningEffort,
  removeModelSettings,
  setModelSettings,
} from "~/lib/model-settings"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { getUsageResponse } from "~/lib/usage-tracker"
import {
  archiveSession,
  createSession,
  getClientEvents,
  listSessions,
} from "~/routes/code-sessions/session-store"
import {
  destroyDirectConnectSession,
  listDirectConnectSessions,
} from "~/routes/direct-connect/ws-handler"
import {
  deregisterEnvironment,
  enqueueWork,
  getEnvironment,
  listEnvironments,
} from "~/routes/environments/environment-store"
import {
  getFeatureFlags,
  removeFeatureFlag,
  setFeatureFlag,
} from "~/routes/feature-flags/store"

import packageJson from "../../../package.json" with { type: "json" }

const serverStartTime = Date.now()

type RedirectSourceEffort =
  | "all"
  | "default"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

type RedirectTargetEffort = "low" | "medium" | "high" | "xhigh" | "max"

type ModelSettingsEffort = "low" | "medium" | "high" | "xhigh" | "max"

interface ModelSettingsRequestBody {
  model?: string
  sentryModelName?: string | null
  supportedReasoningEfforts?: Array<ModelSettingsEffort> | null
  defaultReasoningEffort?: ModelSettingsEffort | null
  implicitReasoningDefault?: boolean | null
  exposeVirtualReasoningModels?: boolean | null
}

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

export async function handleListModelRedirects(c: Context) {
  return c.json(await getAllModelRedirects())
}

export async function handleAddModelRedirect(c: Context) {
  const body = await c.req.json<{
    sourceModel: string
    targetModel: string
    name?: string
    sourceEffort?: RedirectSourceEffort
    targetEffort?: RedirectTargetEffort
  }>()
  if (!body.sourceModel || !body.targetModel) {
    return c.json({ error: "sourceModel and targetModel are required" }, 400)
  }
  const rule = await addModelRedirect(body.sourceModel, body.targetModel, {
    name: body.name,
    sourceEffort: body.sourceEffort,
    targetEffort: body.targetEffort,
  })
  return c.json(rule)
}

export async function handleDeleteModelRedirect(c: Context) {
  const id = c.req.param("id")
  const removed = await removeModelRedirect(id)
  if (!removed) return c.json({ error: "Redirect not found" }, 404)
  return c.json({ success: true })
}

export async function handleToggleModelRedirect(c: Context) {
  const id = c.req.param("id")
  const rule = await toggleModelRedirect(id)
  if (!rule) return c.json({ error: "Redirect not found" }, 404)
  return c.json(rule)
}

export async function handleUpdateModelRedirect(c: Context) {
  const id = c.req.param("id")
  const body = await c.req.json<{
    name?: string
    sourceModel?: string
    sourceEffort?: RedirectSourceEffort
    targetModel?: string
    targetEffort?: RedirectTargetEffort | null
    enabled?: boolean
  }>()
  const rule = await updateModelRedirect(id, body)
  if (!rule) return c.json({ error: "Redirect not found" }, 404)
  return c.json(rule)
}

export async function handleMoveModelRedirect(c: Context) {
  const id = c.req.param("id")
  const body = await c.req.json<{ direction?: "up" | "down" }>()
  if (body.direction !== "up" && body.direction !== "down") {
    return c.json({ error: "direction must be up or down" }, 400)
  }
  const rule = await moveModelRedirect(id, body.direction)
  if (!rule) return c.json({ error: "Redirect not found" }, 404)
  return c.json(rule)
}

export async function handleListModelSettings(c: Context) {
  return c.json(await getAllModelSettings())
}

export async function handleSetModelSettings(c: Context) {
  const body = await c.req.json<ModelSettingsRequestBody>()

  if (!body.model || typeof body.model !== "string") {
    return c.json({ error: "model is required" }, 400)
  }

  const validationError = validateModelSettingsBody(body)
  if (validationError) return c.json({ error: validationError }, 400)

  const settings = await setModelSettings(body.model, modelSettingsUpdate(body))
  return c.json(settings)
}

function validateModelSettingsBody(
  body: ModelSettingsRequestBody,
): string | undefined {
  if (!isValidSentryModelName(body.sentryModelName)) {
    return "sentryModelName is invalid"
  }

  if (!isValidSupportedReasoningEfforts(body.supportedReasoningEfforts)) {
    return "supportedReasoningEfforts is invalid"
  }

  if (!isValidModelSettingsEffort(body.defaultReasoningEffort)) {
    return "defaultReasoningEffort is invalid"
  }

  return undefined
}

function isValidSentryModelName(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string"
}

function isValidSupportedReasoningEfforts(value: unknown): boolean {
  return (
    value === undefined
    || value === null
    || (Array.isArray(value)
      && value.every((effort) => isValidModelSettingsEffort(effort)))
  )
}

function isValidModelSettingsEffort(
  effort: unknown,
): effort is ModelSettingsEffort | null | undefined {
  return (
    effort === undefined
    || effort === null
    || effort === "max"
    || isReasoningEffort(effort)
  )
}

function modelSettingsUpdate(body: ModelSettingsRequestBody) {
  return {
    ...(body.sentryModelName !== undefined ?
      { sentryModelName: body.sentryModelName }
    : {}),
    ...(body.supportedReasoningEfforts !== undefined ?
      { supportedReasoningEfforts: body.supportedReasoningEfforts }
    : {}),
    ...(body.defaultReasoningEffort !== undefined ?
      { defaultReasoningEffort: body.defaultReasoningEffort }
    : {}),
    ...(body.implicitReasoningDefault !== undefined ?
      { implicitReasoningDefault: body.implicitReasoningDefault }
    : {}),
    ...(body.exposeVirtualReasoningModels !== undefined ?
      { exposeVirtualReasoningModels: body.exposeVirtualReasoningModels }
    : {}),
  }
}

export async function handleDeleteModelSettings(c: Context) {
  const model = c.req.param("model")
  const removed = await removeModelSettings(model)
  if (!removed) return c.json({ error: "Model settings not found" }, 404)
  return c.json({ success: true })
}

export function handleListModelRouting(c: Context) {
  const accounts = tokenPool.getAllAccounts().map((account) => ({
    id: account.id,
    accountType: account.accountType,
    healthy: account.healthy,
    modelsCount: account.models.size,
  }))

  const models = tokenPool.getModelAccountAvailability().map((entry) => ({
    id: entry.model.id,
    name: entry.model.name,
    vendor: entry.model.vendor,
    preview: entry.model.preview,
    accounts: entry.accounts,
  }))

  return c.json({
    multiToken: state.isMultiToken,
    accounts,
    models,
  })
}

export async function handleSetModelRouting(c: Context) {
  const body = await c.req.json<{
    modelId?: string
    accountId?: number
    enabled?: boolean
  }>()

  if (!body.modelId || typeof body.modelId !== "string") {
    return c.json({ error: "modelId is required" }, 400)
  }
  if (typeof body.accountId !== "number" || !Number.isInteger(body.accountId)) {
    return c.json({ error: "accountId is required" }, 400)
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled is required" }, 400)
  }

  const account = tokenPool
    .getAllAccounts()
    .find((item) => item.id === body.accountId)
  if (!account) {
    return c.json({ error: "Account not found" }, 404)
  }
  if (!account.models.has(body.modelId)) {
    return c.json({ error: "Model is not available on this account" }, 400)
  }

  const override = await setModelRoutingOverride(
    body.modelId,
    body.accountId,
    body.enabled,
  )
  tokenPool.rebuildModelIndex()

  return c.json(override)
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

export function handleStartEnvironmentSession(c: Context) {
  const envId = c.req.param("id")
  const env = getEnvironment(envId)
  if (!env) {
    return c.json({ error: "Environment not found" }, 404)
  }

  const session = createSession(`Session in ${env.machineName}`, [])

  const protocol =
    c.req.header("x-forwarded-proto")
    ?? (c.req.url.startsWith("https") ? "https" : "https")
  const host = c.req.header("host") ?? "localhost"
  const apiBaseUrl = `${protocol}://${host}`

  const workItem = enqueueWork({ envId, sessionId: session.id, apiBaseUrl })
  if (!workItem) {
    return c.json({ error: "Failed to enqueue work" }, 500)
  }

  return c.json({
    sessionId: session.id,
    workId: workItem.id,
    success: true,
  })
}
