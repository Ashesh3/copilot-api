import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs/promises"

import {
  registerCredentialProvider,
  resolveRequestCredentialKind,
} from "./credential-resolver"
import { extractClientIpFromHeaders, isIpBlocked } from "./ip-blocker"
import { PATHS } from "./paths"
import { getActiveApiKeys } from "./request-auth"

export const ADMIN_SESSION_COOKIE = "__Host-copilot_admin"
export const ADMIN_CSRF_COOKIE = "__Host-copilot_admin_csrf"
export const ADMIN_PASSWORD_MIN_LENGTH = 4
export const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000
const ENV_ADMIN_SESSION_VERSION_PREFIX = "env:"
const ARGON2ID_HASH_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/
const ARGON2ID_MIN_MEMORY_COST = 65_536
const ARGON2ID_MAX_MEMORY_COST = 1_048_576
const ARGON2ID_MIN_TIME_COST = 3
const ARGON2ID_MAX_TIME_COST = 10
const ARGON2ID_MIN_PARALLELISM = 1
const ARGON2ID_MAX_PARALLELISM = 16
const ARGON2ID_MIN_SALT_BYTES = 16
const ARGON2ID_MIN_HASH_BYTES = 32

type AdminSessionVersion =
  | number
  | `${typeof ENV_ADMIN_SESSION_VERSION_PREFIX}${string}`

interface LocalAdminAuthData {
  passwordHash: string
  sessionVersion: number
  createdAt: number
  updatedAt: number
}

interface EnvironmentAdminAuthData {
  source: "environment"
  credentialFingerprint: string
  sessionVersion: number
  createdAt: number
  updatedAt: number
}

type AdminAuthData = EnvironmentAdminAuthData | LocalAdminAuthData

interface AdminSessionRecord {
  tokenHash: string
  csrfHash: string
  sessionVersion: AdminSessionVersion
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

interface AdminSessionsData {
  sessions: Array<AdminSessionRecord>
}

export interface CreatedAdminSession {
  token: string
  csrfToken: string
  expiresAt: number
}

export interface AuthenticatedAdminSession {
  tokenHash: string
  csrfToken: string
  expiresAt: number
}

export interface AdminAuthClock {
  now(): number
}

type ChangeAdminPasswordError =
  | { error: string; reason: "credential" }
  | { error: string; reason: "managed" }
  | { error: string; reason: "session" }
  | { error: string; reason: "validation" }

interface EffectiveAdminCredential {
  passwordHash: string
  sessionVersion: AdminSessionVersion
  source: "environment" | "local"
}

let authData: AdminAuthData | null | undefined
let sessionsData: AdminSessionsData | undefined
let writeQueue: Promise<void> = Promise.resolve()
let authMutationQueue: Promise<void> = Promise.resolve()
let inMemoryTestMode = false
let clock: AdminAuthClock = { now: () => Date.now() }

function noop(): void {}

async function serializeAuthMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = authMutationQueue
  let release = noop
  authMutationQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function randomToken(): string {
  return randomBytes(32).toString("base64url")
}

function now(): number {
  return clock.now()
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest()
  const rightDigest = createHash("sha256").update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

export function validateAdminPasswordHash(hash: string): string {
  const configured = hash.trim()
  if (!configured) {
    throw new Error("Administrator password hash cannot be empty")
  }

  const match = ARGON2ID_HASH_PATTERN.exec(configured)
  if (!match) {
    throw new Error(
      "Administrator password hash must be a valid Argon2id PHC string",
    )
  }
  const memoryCost = Number(match[1])
  const timeCost = Number(match[2])
  const parallelism = Number(match[3])
  const saltBytes = decodeCanonicalBase64(match[4])
  const hashBytes = decodeCanonicalBase64(match[5])
  if (
    memoryCost < ARGON2ID_MIN_MEMORY_COST
    || memoryCost > ARGON2ID_MAX_MEMORY_COST
    || timeCost < ARGON2ID_MIN_TIME_COST
    || timeCost > ARGON2ID_MAX_TIME_COST
    || parallelism < ARGON2ID_MIN_PARALLELISM
    || parallelism > ARGON2ID_MAX_PARALLELISM
    || saltBytes < ARGON2ID_MIN_SALT_BYTES
    || hashBytes < ARGON2ID_MIN_HASH_BYTES
  ) {
    throw new Error(
      "Administrator password hash has unsupported Argon2id parameters",
    )
  }
  return configured
}

function decodeCanonicalBase64(value: string): number {
  const decoded = Buffer.from(value, "base64")
  const canonical = decoded.toString("base64").replace(/=+$/, "")
  if (canonical !== value) {
    throw new Error("Administrator password hash has invalid Base64 encoding")
  }
  return decoded.byteLength
}

function getEnvironmentAdminPasswordHash(): string | null {
  const configured = process.env.COPILOT_ADMIN_PASSWORD_HASH?.trim()
  if (!configured) return null

  try {
    return validateAdminPasswordHash(configured)
  } catch (error) {
    throw new Error(
      `COPILOT_ADMIN_PASSWORD_HASH: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

async function getEffectiveAdminCredential(): Promise<EffectiveAdminCredential | null> {
  const environmentHash = getEnvironmentAdminPasswordHash()
  if (environmentHash) {
    return {
      passwordHash: environmentHash,
      sessionVersion: `${ENV_ADMIN_SESSION_VERSION_PREFIX}${digest(environmentHash)}`,
      source: "environment",
    }
  }
  const local = await loadAuthData()
  if (!local) return null
  if (isEnvironmentAdminAuthData(local)) {
    throw new Error(
      "COPILOT_ADMIN_PASSWORD_HASH is required because administrator authentication is environment-managed",
    )
  }
  return {
    passwordHash: local.passwordHash,
    sessionVersion: local.sessionVersion,
    source: "local",
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse((await fs.readFile(filePath)).toString("utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  if (inMemoryTestMode) return
  await fs.mkdir(PATHS.APP_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(PATHS.APP_DIR, 0o700).catch(() => undefined)
  const tempPath = `${filePath}.${process.pid}.${randomToken()}.tmp`
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await fs.chmod(tempPath, 0o600)
    await fs.rename(tempPath, filePath)
    await fs.chmod(filePath, 0o600).catch(() => undefined)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function enqueueWrite(filePath: string, value: unknown): Promise<void> {
  const snapshot = structuredClone(value)
  writeQueue = writeQueue.then(() => atomicWrite(filePath, snapshot))
  return writeQueue
}

async function loadAuthData(): Promise<AdminAuthData | null> {
  if (authData !== undefined) return authData
  const loaded = await readJson<AdminAuthData>(PATHS.ADMIN_AUTH_PATH)
  if (loaded === null) {
    // eslint-disable-next-line require-atomic-updates
    authData = null
    return authData
  }
  if (
    !Number.isInteger(loaded.sessionVersion)
    || loaded.sessionVersion <= 0
    || !Number.isFinite(loaded.createdAt)
    || !Number.isFinite(loaded.updatedAt)
    || (isEnvironmentAdminAuthData(loaded)
      && !/^[\w-]{43}$/.test(loaded.credentialFingerprint))
    || (!isEnvironmentAdminAuthData(loaded)
      && typeof loaded.passwordHash !== "string")
  ) {
    throw new Error("Invalid administrator authentication store")
  }
  // eslint-disable-next-line require-atomic-updates
  authData = loaded
  return authData
}

function isEnvironmentAdminAuthData(
  value: AdminAuthData,
): value is EnvironmentAdminAuthData {
  return "source" in value && "credentialFingerprint" in value
}

async function loadSessionsData(): Promise<AdminSessionsData> {
  if (sessionsData !== undefined) return sessionsData
  const loaded = await readJson<AdminSessionsData>(PATHS.ADMIN_SESSIONS_PATH)
  if (loaded !== null && !Array.isArray(loaded.sessions)) {
    throw new Error("Invalid administrator session store")
  }
  // eslint-disable-next-line require-atomic-updates
  sessionsData = {
    sessions: (loaded?.sessions ?? [])
      .filter((session) => isSession(session))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt),
  }
  return sessionsData
}

function isSession(value: unknown): value is AdminSessionRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Partial<AdminSessionRecord>
  return (
    typeof record.tokenHash === "string"
    && typeof record.csrfHash === "string"
    && isAdminSessionVersion(record.sessionVersion)
    && typeof record.createdAt === "number"
    && typeof record.lastSeenAt === "number"
    && typeof record.expiresAt === "number"
  )
}

function isAdminSessionVersion(value: unknown): value is AdminSessionVersion {
  return (
    (Number.isInteger(value) && (value as number) > 0)
    || (typeof value === "string" && /^env:[\w-]{43}$/.test(value))
  )
}

function validatePassword(password: string): string | null {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    return `Admin password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`
  }
  return null
}

function gatewayKeyMatches(candidate: string): boolean {
  const activeKeys = getActiveApiKeys()
  let matched = false
  for (const key of activeKeys) {
    matched = safeEqual(candidate, key) || matched
  }
  return activeKeys.length > 0 && matched
}

export async function getAdminAuthStatus(): Promise<{
  configured: boolean
  gatewayConfigured: boolean
  passwordManagedExternally: boolean
}> {
  const credential = await getEffectiveAdminCredential()
  return {
    configured: credential !== null,
    gatewayConfigured: getActiveApiKeys().length > 0,
    passwordManagedExternally: credential?.source === "environment",
  }
}

export async function initializeAdminAuth(): Promise<void> {
  await serializeAuthMutation(async () => {
    const environmentHash = getEnvironmentAdminPasswordHash()
    const existing = await loadAuthData()
    if (!environmentHash) {
      if (existing && isEnvironmentAdminAuthData(existing)) {
        throw new Error(
          "COPILOT_ADMIN_PASSWORD_HASH is required because administrator authentication is environment-managed",
        )
      }
      return
    }
    const credentialFingerprint = digest(environmentHash)
    if (
      existing
      && isEnvironmentAdminAuthData(existing)
      && safeEqual(existing.credentialFingerprint, credentialFingerprint)
    ) {
      return
    }

    await persistEnvironmentAdminAuth(existing, credentialFingerprint)
  })
}

async function ensureEnvironmentAdminAuthInitialized(
  credentialFingerprint: string,
): Promise<void> {
  const existing = await loadAuthData()
  if (
    existing
    && isEnvironmentAdminAuthData(existing)
    && safeEqual(existing.credentialFingerprint, credentialFingerprint)
  ) {
    return
  }

  await serializeAuthMutation(async () => {
    const current = await loadAuthData()
    if (
      current
      && isEnvironmentAdminAuthData(current)
      && safeEqual(current.credentialFingerprint, credentialFingerprint)
    ) {
      return
    }
    await persistEnvironmentAdminAuth(current, credentialFingerprint)
  })
}

async function persistEnvironmentAdminAuth(
  existing: AdminAuthData | null,
  credentialFingerprint: string,
): Promise<void> {
  const currentTime = now()
  authData = {
    source: "environment",
    credentialFingerprint,
    sessionVersion: (existing?.sessionVersion ?? 0) + 1,
    createdAt: existing?.createdAt ?? currentTime,
    updatedAt: currentTime,
  }
  sessionsData = { sessions: [] }
  await enqueueWrite(PATHS.ADMIN_AUTH_PATH, authData)
  await enqueueWrite(PATHS.ADMIN_SESSIONS_PATH, sessionsData)
}

export async function setupAdminAuth(
  gatewayKey: string,
  password: string,
): Promise<{ session: CreatedAdminSession } | { error: string }> {
  return await serializeAuthMutation(async () => {
    if ((await getEffectiveAdminCredential()) !== null) {
      return { error: "Administrator authentication is already configured" }
    }
    if (!gatewayKeyMatches(gatewayKey)) {
      return { error: "Authentication failed" }
    }
    const passwordError = validatePassword(password)
    if (passwordError) return { error: passwordError }

    const currentTime = now()
    authData = {
      passwordHash: await Bun.password.hash(password, {
        algorithm: "argon2id",
        memoryCost: 65_536,
        timeCost: 3,
      }),
      sessionVersion: 1,
      createdAt: currentTime,
      updatedAt: currentTime,
    }
    await enqueueWrite(PATHS.ADMIN_AUTH_PATH, authData)
    return { session: await createAdminSession() }
  })
}

async function verifyPassword(password: string): Promise<boolean> {
  const current = await getEffectiveAdminCredential()
  if (!current) {
    await Bun.password.hash(password || "invalid-admin-password", {
      algorithm: "argon2id",
      memoryCost: 65_536,
      timeCost: 3,
    })
    return false
  }
  try {
    return await Bun.password.verify(password, current.passwordHash)
  } catch {
    return false
  }
}

export async function loginAdmin(
  gatewayKey: string,
  password: string,
): Promise<CreatedAdminSession | null> {
  const [validPassword] = await Promise.all([verifyPassword(password)])
  if (
    !gatewayKeyMatches(gatewayKey)
    || !validPassword
    || validatePassword(password) !== null
  ) {
    return null
  }
  const environmentHash = getEnvironmentAdminPasswordHash()
  if (environmentHash) {
    await ensureEnvironmentAdminAuthInitialized(digest(environmentHash))
  }
  return await serializeAuthMutation(async () => await createAdminSession())
}

async function createAdminSession(): Promise<CreatedAdminSession> {
  const current = await getEffectiveAdminCredential()
  if (!current)
    throw new Error("Administrator authentication is not configured")
  const data = await loadSessionsData()
  const currentTime = now()
  pruneSessions(data, current.sessionVersion, currentTime)

  const token = randomToken()
  const csrfToken = randomToken()
  const record: AdminSessionRecord = {
    tokenHash: digest(token),
    csrfHash: digest(csrfToken),
    sessionVersion: current.sessionVersion,
    createdAt: currentTime,
    lastSeenAt: currentTime,
    expiresAt: currentTime + ADMIN_SESSION_TTL_MS,
  }
  data.sessions.push(record)
  data.sessions.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  sessionsData = data
  await enqueueWrite(PATHS.ADMIN_SESSIONS_PATH, data)
  return { token, csrfToken, expiresAt: record.expiresAt }
}

function pruneSessions(
  data: AdminSessionsData,
  version: AdminSessionVersion,
  now: number,
): boolean {
  const before = data.sessions.length
  data.sessions = data.sessions.filter(
    (session) => session.sessionVersion === version && session.expiresAt > now,
  )
  return data.sessions.length !== before
}

function parseCookieHeader(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >
  if (!header) return cookies
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=")
    if (separator < 1) continue
    const key = segment.slice(0, separator).trim()
    const value = segment.slice(separator + 1).trim()
    if (key) cookies[key] = value
  }
  return cookies
}

// Authentication deliberately evaluates cookie, CSRF, origin, expiry, and
// session version in one place.

async function resolveAdminSession(
  request: Request,
  options: { requireCsrf?: boolean } = {},
): Promise<AuthenticatedAdminSession | null> {
  const current = await getEffectiveAdminCredential()
  if (!current) return null
  const data = await loadSessionsData()
  const currentTime = now()
  const pruned = pruneSessions(data, current.sessionVersion, currentTime)
  const cookies = parseCookieHeader(request.headers.get("cookie"))
  const token = cookies[ADMIN_SESSION_COOKIE]
  if (!token) {
    if (pruned) await enqueueWrite(PATHS.ADMIN_SESSIONS_PATH, data)
    return null
  }
  const tokenHash = digest(token)
  const session = data.sessions.find((entry) =>
    safeEqual(entry.tokenHash, tokenHash),
  )
  if (!session) {
    if (pruned) await enqueueWrite(PATHS.ADMIN_SESSIONS_PATH, data)
    return null
  }

  const csrfToken = cookies[ADMIN_CSRF_COOKIE]
  if (options.requireCsrf) {
    const supplied = request.headers.get("x-copilot-csrf")
    if (
      !csrfToken
      || !supplied
      || !safeEqual(csrfToken, supplied)
      || !safeEqual(digest(supplied), session.csrfHash)
      || !isAllowedAdminOrigin(request.headers.get("origin"))
    ) {
      return null
    }
  }
  const shouldPersist =
    currentTime - session.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS
  session.expiresAt = currentTime + ADMIN_SESSION_TTL_MS
  if (shouldPersist) session.lastSeenAt = currentTime
  if (pruned || shouldPersist) {
    sessionsData = data
    await enqueueWrite(PATHS.ADMIN_SESSIONS_PATH, data)
  }
  return {
    tokenHash,
    csrfToken,
    expiresAt: session.expiresAt,
  }
}

export async function authenticateAdminRequest(
  request: Request,
  options: { requireCsrf?: boolean } = {},
): Promise<AuthenticatedAdminSession | null> {
  const clientIp = extractClientIpFromHeaders(request.headers)
  if (clientIp !== null && isIpBlocked(clientIp)) return null

  const credential = await resolveRequestCredentialKind(request, "admin", {
    requireCsrf: options.requireCsrf,
  })
  const tokenHash = credential?.metadata?.tokenHash
  const csrfToken = credential?.metadata?.csrfToken
  const expiresAt = credential?.metadata?.expiresAt
  if (
    typeof tokenHash !== "string"
    || typeof csrfToken !== "string"
    || typeof expiresAt !== "number"
  ) {
    return null
  }
  return {
    tokenHash,
    csrfToken,
    expiresAt,
  }
}

export function isAllowedAdminOrigin(origin: string | null): boolean {
  if (!origin) return false
  const configured = process.env.COPILOT_ADMIN_ORIGIN?.trim()
  if (configured) return origin === configured
  try {
    const url = new URL(origin)
    return (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      && (url.protocol === "http:" || url.protocol === "https:")
    )
  } catch {
    return false
  }
}

export async function logoutAdmin(request: Request): Promise<void> {
  await serializeAuthMutation(async () => {
    const session = await authenticateAdminRequest(request, {
      requireCsrf: true,
    })
    if (!session) return
    const data = await loadSessionsData()
    data.sessions = data.sessions.filter(
      (entry) => !safeEqual(entry.tokenHash, session.tokenHash),
    )
    sessionsData = data
    await enqueueWrite(PATHS.ADMIN_SESSIONS_PATH, data)
  })
}

export async function changeAdminPassword(
  request: Request,
  currentPassword: string,
  newPassword: string,
): Promise<CreatedAdminSession | ChangeAdminPasswordError> {
  return await serializeAuthMutation(async () => {
    const session = await authenticateAdminRequest(request, {
      requireCsrf: true,
    })
    if (!session) {
      return { error: "Authentication failed", reason: "session" }
    }
    if (!(await verifyPassword(currentPassword))) {
      return { error: "Authentication failed", reason: "credential" }
    }
    const effective = await getEffectiveAdminCredential()
    if (effective?.source === "environment") {
      return {
        error:
          "Administrator password is managed by COPILOT_ADMIN_PASSWORD_HASH",
        reason: "managed",
      }
    }
    const passwordError = validatePassword(newPassword)
    if (passwordError) {
      return { error: passwordError, reason: "validation" }
    }
    const current = await loadAuthData()
    if (!current || isEnvironmentAdminAuthData(current)) {
      return { error: "Authentication failed", reason: "session" }
    }
    current.passwordHash = await Bun.password.hash(newPassword, {
      algorithm: "argon2id",
      memoryCost: 65_536,
      timeCost: 3,
    })
    current.sessionVersion += 1
    current.updatedAt = now()
    authData = current
    sessionsData = { sessions: [] }
    await enqueueWrite(PATHS.ADMIN_AUTH_PATH, current)
    await enqueueWrite(PATHS.ADMIN_SESSIONS_PATH, sessionsData)
    return await createAdminSession()
  })
}

export async function resetAdminAuth(): Promise<void> {
  await serializeAuthMutation(async () => {
    authData = null
    sessionsData = { sessions: [] }
    if (inMemoryTestMode) return
    await Promise.all([
      fs.rm(PATHS.ADMIN_AUTH_PATH, { force: true }),
      fs.rm(PATHS.ADMIN_SESSIONS_PATH, { force: true }),
    ])
  })
}

export function setAdminAuthTestMode(enabled: boolean): void {
  inMemoryTestMode = enabled
  authData = null
  sessionsData = { sessions: [] }
  writeQueue = Promise.resolve()
  authMutationQueue = Promise.resolve()
  clock = { now: () => Date.now() }
}

export function setAdminAuthClockForTest(testClock?: AdminAuthClock): void {
  clock = testClock ?? { now: () => Date.now() }
}

registerCredentialProvider("admin", async (request, context) => {
  const session = await resolveAdminSession(request, {
    requireCsrf: context.requireCsrf,
  })
  return session ?
      {
        kind: "admin",
        metadata: {
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
          tokenHash: session.tokenHash,
        },
        principalId: `admin:${session.tokenHash.slice(0, 16)}`,
        scopes: new Set<string>(),
      }
    : null
})
