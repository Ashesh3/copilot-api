import { createHash, randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "./paths"

export const OAUTH_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
export const OAUTH_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const OAUTH_AUTHORIZATION_CODE_TTL_MS = 2 * 60 * 1000
const KNOWN_OAUTH_SCOPES = new Set([
  "user:inference",
  "user:profile",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "org:create_api_key",
])

interface AuthorizationCodeRecord {
  clientId: string
  redirectUri: string
  scopes: Array<string>
  state: string
  codeChallenge: string
  createdAt: number
  expiresAt: number
}

interface AccessTokenRecord {
  principalId: string
  familyId: string
  clientId: string
  scopes: Array<string>
  createdAt: number
  expiresAt: number
  revokedAt?: number
}

interface RefreshTokenRecord extends AccessTokenRecord {
  consumedAt?: number
}

interface InferenceCredentialRecord {
  principalId: string
  scopes: Array<string>
  createdAt: number
  revokedAt?: number
}

interface TokenFamilyRecord {
  createdAt: number
  expiresAt: number
  revokedAt?: number
}

interface OAuthStoreData {
  version: 1
  authorizationCodes: Partial<Record<string, AuthorizationCodeRecord>>
  accessTokens: Partial<Record<string, AccessTokenRecord>>
  refreshTokens: Partial<Record<string, RefreshTokenRecord>>
  inferenceCredentials: Partial<Record<string, InferenceCredentialRecord>>
  tokenFamilies: Partial<Record<string, TokenFamilyRecord>>
}

interface MutationResult<T> {
  value: T
  changed: boolean
}

export interface IssueAuthorizationCodeInput {
  clientId: string
  redirectUri: string
  scopes: ReadonlyArray<string>
  state: string
  codeChallenge: string
  now?: number
}

export interface ExchangeAuthorizationCodeInput {
  code: string
  clientId: string
  redirectUri: string
  state: string
  codeVerifier: string
  now?: number
}

export interface RefreshAccessTokenInput {
  refreshToken: string
  clientId: string
  scopes?: ReadonlyArray<string>
  now?: number
}

export interface IssuedOAuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scopes: Array<string>
}

export type AuthorizationCodeExchangeResult =
  | { status: "ok"; tokens: IssuedOAuthTokens }
  | { status: "invalid_grant" }

export type RefreshAccessTokenResult =
  | { status: "ok"; tokens: IssuedOAuthTokens }
  | { status: "invalid_grant" | "invalid_scope" | "reuse_detected" }

export interface StoredCredential {
  principalId: string
  scopes: ReadonlyArray<string>
}

function createEmptyStore(): OAuthStoreData {
  return {
    version: 1,
    authorizationCodes: {},
    accessTokens: {},
    refreshTokens: {},
    inferenceCredentials: {},
    tokenFamilies: {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function hasValidLifetime(value: {
  createdAt: number
  expiresAt: number
}): boolean {
  return value.expiresAt >= value.createdAt
}

function hasKnownScopes(value: unknown): value is Array<string> {
  return (
    isStringArray(value)
    && value.length > 0
    && value.length <= KNOWN_OAUTH_SCOPES.size
    && new Set(value).size === value.length
    && value.every((scope) => KNOWN_OAUTH_SCOPES.has(scope))
  )
}

function isAuthorizationCodeRecord(
  value: unknown,
): value is AuthorizationCodeRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.clientId === "string"
    && typeof value.redirectUri === "string"
    && hasKnownScopes(value.scopes)
    && typeof value.state === "string"
    && typeof value.codeChallenge === "string"
    && isFiniteTimestamp(value.createdAt)
    && isFiniteTimestamp(value.expiresAt)
    && hasValidLifetime(value as unknown as AuthorizationCodeRecord)
  )
}

function isAccessTokenRecord(value: unknown): value is AccessTokenRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.principalId === "string"
    && typeof value.familyId === "string"
    && typeof value.clientId === "string"
    && hasKnownScopes(value.scopes)
    && isFiniteTimestamp(value.createdAt)
    && isFiniteTimestamp(value.expiresAt)
    && (value.revokedAt === undefined || isFiniteTimestamp(value.revokedAt))
    && hasValidLifetime(value as unknown as AccessTokenRecord)
  )
}

function isRefreshTokenRecord(value: unknown): value is RefreshTokenRecord {
  if (!isRecord(value)) return false
  return (
    isAccessTokenRecord(value)
    && (value.consumedAt === undefined || isFiniteTimestamp(value.consumedAt))
  )
}

function isInferenceCredentialRecord(
  value: unknown,
): value is InferenceCredentialRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.principalId === "string"
    && Array.isArray(value.scopes)
    && value.scopes.length === 1
    && value.scopes[0] === "user:inference"
    && isFiniteTimestamp(value.createdAt)
    && (value.revokedAt === undefined || isFiniteTimestamp(value.revokedAt))
  )
}

function isTokenFamilyRecord(value: unknown): value is TokenFamilyRecord {
  if (!isRecord(value)) return false
  return (
    isFiniteTimestamp(value.createdAt)
    && isFiniteTimestamp(value.expiresAt)
    && (value.revokedAt === undefined || isFiniteTimestamp(value.revokedAt))
    && hasValidLifetime(value as unknown as TokenFamilyRecord)
  )
}

function parseRecordMap<T>(
  value: unknown,
  validator: (entry: unknown) => entry is T,
  field: string,
): Partial<Record<string, T>> {
  if (!isRecord(value)) {
    throw new Error(`Invalid OAuth token store field: ${field}`)
  }
  const output: Partial<Record<string, T>> = Object.create(null) as Partial<
    Record<string, T>
  >
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[\w-]{20,128}$/.test(key) || !validator(entry)) {
      throw new Error(`Invalid OAuth token store record: ${field}`)
    }
    output[key] = entry
  }
  return output
}

function parseStore(raw: string): OAuthStoreData {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error("Unsupported OAuth token store format")
  }

  return {
    version: 1,
    authorizationCodes: parseRecordMap(
      parsed.authorizationCodes,
      isAuthorizationCodeRecord,
      "authorizationCodes",
    ),
    accessTokens: parseRecordMap(
      parsed.accessTokens,
      isAccessTokenRecord,
      "accessTokens",
    ),
    refreshTokens: parseRecordMap(
      parsed.refreshTokens,
      isRefreshTokenRecord,
      "refreshTokens",
    ),
    inferenceCredentials: parseRecordMap(
      parsed.inferenceCredentials,
      isInferenceCredentialRecord,
      "inferenceCredentials",
    ),
    tokenFamilies: parseRecordMap(
      parsed.tokenFamilies,
      isTokenFamilyRecord,
      "tokenFamilies",
    ),
  }
}

export function hashOAuthSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("base64url")
}

export function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url")
}

function randomSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`
}

function uniqueScopes(scopes: ReadonlyArray<string>): Array<string> {
  return [...new Set(scopes)]
}

function noop(): void {}

function changed<T>(value: T): MutationResult<T> {
  return { value, changed: true }
}

function unchanged<T>(value: T): MutationResult<T> {
  return { value, changed: false }
}

export class OAuthStore {
  readonly filePath: string
  private data: OAuthStoreData | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string = PATHS.OAUTH_STORE_PATH) {
    this.filePath = filePath
  }

  async issueAuthorizationCode(
    input: IssueAuthorizationCodeInput,
  ): Promise<string> {
    return await this.mutate((data) => {
      const now = input.now ?? Date.now()
      const code = randomSecret("cc_code_")
      data.authorizationCodes[hashOAuthSecret(code)] = {
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        scopes: uniqueScopes(input.scopes),
        state: input.state,
        codeChallenge: input.codeChallenge,
        createdAt: now,
        expiresAt: now + OAUTH_AUTHORIZATION_CODE_TTL_MS,
      }
      return changed(code)
    })
  }

  async exchangeAuthorizationCode(
    input: ExchangeAuthorizationCodeInput,
  ): Promise<AuthorizationCodeExchangeResult> {
    const codeDigest = hashOAuthSecret(input.code)
    const current = await this.read()
    if (!current.authorizationCodes[codeDigest]) {
      return { status: "invalid_grant" }
    }
    return await this.mutate((data) => {
      const now = input.now ?? Date.now()
      const codeRecord = data.authorizationCodes[codeDigest]
      if (
        !codeRecord
        || codeRecord.expiresAt <= now
        || codeRecord.clientId !== input.clientId
        || codeRecord.redirectUri !== input.redirectUri
        || codeRecord.state !== input.state
        || codeRecord.codeChallenge !== createPkceChallenge(input.codeVerifier)
      ) {
        if (
          codeRecord?.expiresAt !== undefined
          && codeRecord.expiresAt <= now
        ) {
          Reflect.deleteProperty(data.authorizationCodes, codeDigest)
          return changed<AuthorizationCodeExchangeResult>({
            status: "invalid_grant",
          })
        }
        return unchanged<AuthorizationCodeExchangeResult>({
          status: "invalid_grant",
        })
      }

      Reflect.deleteProperty(data.authorizationCodes, codeDigest)
      return changed<AuthorizationCodeExchangeResult>({
        status: "ok",
        tokens: this.issueTokenPair(data, {
          clientId: codeRecord.clientId,
          scopes: codeRecord.scopes,
          now,
        }),
      })
    })
  }

  async refreshAccessToken(
    input: RefreshAccessTokenInput,
  ): Promise<RefreshAccessTokenResult> {
    const refreshDigest = hashOAuthSecret(input.refreshToken)
    const current = await this.read()
    const currentRecord = current.refreshTokens[refreshDigest]
    if (!currentRecord || currentRecord.clientId !== input.clientId) {
      return { status: "invalid_grant" }
    }
    return await this.mutate((data) => {
      const now = input.now ?? Date.now()
      const refreshRecord = data.refreshTokens[refreshDigest]
      if (!refreshRecord || refreshRecord.clientId !== input.clientId) {
        return unchanged<RefreshAccessTokenResult>({ status: "invalid_grant" })
      }

      const family = data.tokenFamilies[refreshRecord.familyId]
      if (
        !family
        || family.revokedAt !== undefined
        || family.expiresAt <= now
        || refreshRecord.revokedAt !== undefined
        || refreshRecord.expiresAt <= now
      ) {
        return unchanged<RefreshAccessTokenResult>({ status: "invalid_grant" })
      }

      if (refreshRecord.consumedAt !== undefined) {
        this.revokeFamily(data, refreshRecord.familyId, now)
        return changed<RefreshAccessTokenResult>({ status: "reuse_detected" })
      }

      const requestedScopes =
        input.scopes === undefined ?
          refreshRecord.scopes
        : uniqueScopes(input.scopes)
      if (
        requestedScopes.length === 0
        || requestedScopes.some(
          (scope) => !refreshRecord.scopes.includes(scope),
        )
      ) {
        return unchanged<RefreshAccessTokenResult>({ status: "invalid_scope" })
      }

      refreshRecord.consumedAt = now
      return changed<RefreshAccessTokenResult>({
        status: "ok",
        tokens: this.issueTokenPair(data, {
          clientId: refreshRecord.clientId,
          scopes: requestedScopes,
          refreshScopes: refreshRecord.scopes,
          now,
          familyId: refreshRecord.familyId,
          principalId: refreshRecord.principalId,
          familyExpiresAt: family.expiresAt,
        }),
      })
    })
  }

  async mintInferenceCredential(now = Date.now()): Promise<string> {
    return await this.mutate((data) => {
      const rawKey = randomSecret("sk-copilot-")
      data.inferenceCredentials[hashOAuthSecret(rawKey)] = {
        principalId: `inference:${randomUUID()}`,
        scopes: ["user:inference"],
        createdAt: now,
      }
      return changed(rawKey)
    })
  }

  async resolveAccessToken(
    rawToken: string,
    now = Date.now(),
  ): Promise<StoredCredential | null> {
    const data = await this.read()
    const record = data.accessTokens[hashOAuthSecret(rawToken)]
    if (!record || record.revokedAt !== undefined || record.expiresAt <= now) {
      return null
    }
    const family = data.tokenFamilies[record.familyId]
    if (!family || family.revokedAt !== undefined || family.expiresAt <= now) {
      return null
    }
    return { principalId: record.principalId, scopes: [...record.scopes] }
  }

  async resolveInferenceCredential(
    rawKey: string,
  ): Promise<StoredCredential | null> {
    const data = await this.read()
    const record = data.inferenceCredentials[hashOAuthSecret(rawKey)]
    if (!record || record.revokedAt !== undefined) return null
    return { principalId: record.principalId, scopes: [...record.scopes] }
  }

  async revokeToken(rawToken: string, now = Date.now()): Promise<void> {
    const digest = hashOAuthSecret(rawToken)
    const current = await this.read()
    if (
      !current.refreshTokens[digest]
      && !current.accessTokens[digest]
      && !current.inferenceCredentials[digest]
    ) {
      return
    }
    await this.mutate((data) => {
      const refreshRecord = data.refreshTokens[digest]
      if (refreshRecord) {
        this.revokeFamily(data, refreshRecord.familyId, now)
        return changed(undefined)
      }

      const accessRecord = data.accessTokens[digest]
      if (accessRecord) {
        this.revokeFamily(data, accessRecord.familyId, now)
        return changed(undefined)
      }

      const inferenceRecord = data.inferenceCredentials[digest]
      if (inferenceRecord) {
        inferenceRecord.revokedAt = now
        return changed(undefined)
      }
      return unchanged(undefined)
    })
  }

  private issueTokenPair(
    data: OAuthStoreData,
    input: {
      clientId: string
      scopes: ReadonlyArray<string>
      now: number
      familyId?: string
      principalId?: string
      familyExpiresAt?: number
      refreshScopes?: ReadonlyArray<string>
    },
  ): IssuedOAuthTokens {
    const accessToken = randomSecret("cc_at_")
    const refreshToken = randomSecret("cc_rt_")
    const familyId = input.familyId ?? randomUUID()
    const principalId = input.principalId ?? `oauth:${randomUUID()}`
    const familyExpiresAt =
      input.familyExpiresAt ?? input.now + OAUTH_REFRESH_TOKEN_TTL_MS
    const scopes = uniqueScopes(input.scopes)

    data.tokenFamilies[familyId] ??= {
      createdAt: input.now,
      expiresAt: familyExpiresAt,
    }
    data.accessTokens[hashOAuthSecret(accessToken)] = {
      principalId,
      familyId,
      clientId: input.clientId,
      scopes,
      createdAt: input.now,
      expiresAt: input.now + OAUTH_ACCESS_TOKEN_TTL_MS,
    }
    data.refreshTokens[hashOAuthSecret(refreshToken)] = {
      principalId,
      familyId,
      clientId: input.clientId,
      scopes: uniqueScopes(input.refreshScopes ?? scopes),
      createdAt: input.now,
      expiresAt: familyExpiresAt,
    }

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(
        Math.min(
          OAUTH_ACCESS_TOKEN_TTL_MS,
          Math.max(0, familyExpiresAt - input.now),
        ) / 1000,
      ),
      scopes,
    }
  }

  private revokeFamily(
    data: OAuthStoreData,
    familyId: string,
    now: number,
  ): void {
    const family = data.tokenFamilies[familyId]
    if (family) family.revokedAt = now
    for (const record of Object.values(data.accessTokens)) {
      if (!record) continue
      if (record.familyId === familyId) record.revokedAt = now
    }
    for (const record of Object.values(data.refreshTokens)) {
      if (!record) continue
      if (record.familyId === familyId) record.revokedAt = now
    }
  }

  private async read(): Promise<OAuthStoreData> {
    await this.mutationQueue
    if (this.data) return this.data
    this.data = await this.readFromDisk()
    return this.data
  }

  private async mutate<T>(
    operation: (data: OAuthStoreData) => MutationResult<T>,
  ): Promise<T> {
    const previousMutation = this.mutationQueue
    let releaseMutation = noop
    this.mutationQueue = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    await previousMutation

    try {
      const currentData = this.data ?? (await this.readFromDisk())
      const nextData = structuredClone(currentData)
      const pruned = this.pruneExpired(nextData, Date.now())
      const result = operation(nextData)
      if (pruned || result.changed) {
        await this.writeToDisk(nextData)
        this.data = nextData
      } else {
        this.data = currentData
      }
      return result.value
    } finally {
      releaseMutation()
    }
  }

  private async readFromDisk(): Promise<OAuthStoreData> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8")
      return raw.trim() ? parseStore(raw) : createEmptyStore()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyStore()
      }
      throw error
    }
  }

  private pruneExpired(data: OAuthStoreData, now: number): boolean {
    let changed = false
    for (const [digest, record] of Object.entries(data.authorizationCodes)) {
      if (!record) continue
      if (record.expiresAt <= now) {
        Reflect.deleteProperty(data.authorizationCodes, digest)
        changed = true
      }
    }
    for (const [digest, record] of Object.entries(data.accessTokens)) {
      if (!record) continue
      if (record.expiresAt <= now) {
        Reflect.deleteProperty(data.accessTokens, digest)
        changed = true
      }
    }
    for (const [digest, record] of Object.entries(data.refreshTokens)) {
      if (!record) continue
      if (record.expiresAt <= now) {
        Reflect.deleteProperty(data.refreshTokens, digest)
        changed = true
      }
    }
    for (const [familyId, family] of Object.entries(data.tokenFamilies)) {
      if (!family) continue
      if (family.expiresAt <= now) {
        Reflect.deleteProperty(data.tokenFamilies, familyId)
        changed = true
      }
    }
    return changed
  }

  private async writeToDisk(data: OAuthStoreData): Promise<void> {
    const directory = path.dirname(this.filePath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.chmod(directory, 0o700).catch(() => undefined)

    const serialized = `${JSON.stringify(data, null, 2)}\n`
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
      })
      await fs.chmod(temporaryPath, 0o600).catch(() => undefined)
      await fs.rename(temporaryPath, this.filePath)
      await fs.chmod(this.filePath, 0o600).catch(() => undefined)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

let oauthStore = new OAuthStore()

export function getOAuthStore(): OAuthStore {
  return oauthStore
}

export function setOAuthStoreForTest(store: OAuthStore | null): void {
  oauthStore = store ?? new OAuthStore()
}
