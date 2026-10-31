import { randomBytes, randomInt, randomUUID } from "node:crypto"

import type { DesktopAuthMutationResult } from "~/lib/storage/desktop-gateway-auth-mutation"
import type { SqlSession, Storage } from "~/lib/storage/types"

import { isStoredGatewayCredential } from "~/lib/credential-value"
import {
  credentialDigest,
  findGatewayCredential,
} from "~/lib/storage/credentials-repository"
import { mutateDesktopAuth } from "~/lib/storage/desktop-gateway-auth-mutation"
import { StorageSchemaError } from "~/lib/storage/errors"
import { getStorageRuntime } from "~/lib/storage/runtime"

const DEVICE_LIFETIME_SECONDS = 300
const POLL_INTERVAL_SECONDS = 5
const ACCESS_LIFETIME_SECONDS = 3600
const REFRESH_LIFETIME_SECONDS = 30 * 24 * 60 * 60
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export interface DesktopGatewayAuthInput {
  issuer: string
  clientId?: string
  now?: number
}

export interface DesktopDeviceAuthorization {
  deviceCode: string
  userCode: string
  expiresIn: number
  interval: number
}

export interface DesktopGatewayTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  refreshTokenExpiresIn: number
  scopes: Array<string>
}

export type DesktopGatewayTokenResult =
  | { status: "ok"; tokens: DesktopGatewayTokens }
  | {
      status:
        | "authorization_pending"
        | "slow_down"
        | "access_denied"
        | "expired_token"
        | "invalid_grant"
    }

export type DesktopGatewayApprovalResult = {
  status: "approved" | "denied" | "invalid_code" | "invalid_credential"
}

export interface StoredInferenceCredential {
  principalId: string
  scopes: ReadonlyArray<string>
}

type DeviceStatus = "pending" | "approved" | "denied" | "consumed"

export interface DesktopDeviceAuthorizationView {
  userCode: string
  status: DeviceStatus | "expired"
  expiresIn: number
  interval: number
}

interface Authority {
  kind: "gateway" | "inference"
  id: string
  digest: string
}

interface DeviceGrant {
  issuer: string
  clientId: string | null
  status: DeviceStatus
  expiresAt: number
  interval: number
  nextPollAt: number
  authority: Authority | null
}

interface AuthSession {
  id: string
  principalId: string
  issuer: string
  clientId: string | null
  authority: Authority
  refreshExpiresAt: number
  revokedAt: number | null
}

function outcome<T>(value: T, changed = false): DesktopAuthMutationResult<T> {
  return { value, changed }
}

function invalidRecord(): never {
  throw new StorageSchemaError("Invalid Desktop gateway authentication record")
}

function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : invalidRecord()
}

function timestamp(value: unknown): number {
  return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : invalidRecord()
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value)
}

function authority(row: Record<string, unknown>): Authority {
  const kind = row.credential_kind
  if (kind !== "gateway" && kind !== "inference") return invalidRecord()
  return {
    kind,
    id: text(row.credential_id),
    digest: text(row.credential_digest),
  }
}

function deviceGrant(row: Record<string, unknown>): DeviceGrant {
  const status = row.status
  if (
    status !== "pending"
    && status !== "approved"
    && status !== "denied"
    && status !== "consumed"
  )
    return invalidRecord()
  const createdAt = timestamp(row.created_at)
  const expiresAt = timestamp(row.expires_at)
  const interval = timestamp(row.interval_seconds)
  if (expiresAt < createdAt || interval === 0) return invalidRecord()
  return {
    issuer: text(row.issuer),
    clientId: nullableText(row.client_id),
    status,
    expiresAt,
    interval,
    nextPollAt: timestamp(row.next_poll_at),
    authority: status === "pending" ? null : authority(row),
  }
}

function authSession(row: Record<string, unknown>): AuthSession {
  const createdAt = timestamp(row.created_at)
  const refreshExpiresAt = timestamp(row.refresh_expires_at)
  if (refreshExpiresAt < createdAt) return invalidRecord()
  timestamp(row.updated_at)
  return {
    id: text(row.id),
    principalId: text(row.principal_id),
    issuer: text(row.issuer),
    clientId: nullableText(row.client_id),
    authority: authority(row),
    refreshExpiresAt,
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at),
  }
}

function normalizeIssuer(value: string): string {
  const url = new URL(value)
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.search
    || url.hash
  )
    throw new TypeError(
      "Desktop authentication issuer must be an HTTP(S) base URL",
    )
  return url.origin + url.pathname.replace(/\/+$/, "")
}

function clientId(value: string | undefined): string | null {
  return value?.trim() || null
}

function userCode(value: string): string | null {
  const normalized = value.trim().toUpperCase().replaceAll("-", "")
  return /^[A-HJ-NP-Z2-9]{8}$/.test(normalized) ? normalized : null
}

function displayUserCode(value: string): string {
  return value.slice(0, 4) + "-" + value.slice(4)
}

function approvalAction(value: unknown): "approve" | "deny" {
  if (value === undefined || value === "approve") return "approve"
  if (value === "deny") return "deny"
  throw new TypeError("Invalid device authorization action")
}

function secret(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url")
}

function createTokens(): DesktopGatewayTokens {
  return {
    accessToken: secret("gw_at_"),
    refreshToken: secret("gw_rt_"),
    expiresIn: ACCESS_LIFETIME_SECONDS,
    refreshTokenExpiresIn: REFRESH_LIFETIME_SECONDS,
    scopes: ["user:inference"],
  }
}

function inferenceScopes(row: Record<string, unknown>): boolean {
  let scopes: unknown
  try {
    scopes = JSON.parse(text(row.scopes_json))
  } catch {
    return invalidRecord()
  }
  if (
    !Array.isArray(scopes)
    || scopes.some((scope: unknown) => typeof scope !== "string")
    || (row.enabled !== 0 && row.enabled !== 1)
  )
    return invalidRecord()
  return (
    row.enabled === 1
    && row.revoked_at === null
    && scopes.includes("user:inference")
  )
}

async function inferenceAuthorities(session: SqlSession, hex: string) {
  return session.query({
    sql: "SELECT id,digest,enabled,revoked_at,scopes_json FROM capi_inference_credentials WHERE digest IN (?,?)",
    args: [hex, Buffer.from(hex, "hex").toString("base64url")],
  })
}

async function resolveAuthority(
  session: SqlSession,
  suppliedKey: string,
): Promise<Authority | null> {
  const key = suppliedKey.trim()
  if (!key) return null
  const literal = /^[a-f\d]{64}$/i.test(key) ? key.toLowerCase() : key
  const digestRecords = await session.query({
    sql: "SELECT digest FROM capi_inference_credentials WHERE digest=? UNION ALL SELECT digest FROM capi_gateway_credentials WHERE digest=? LIMIT 1",
    args: [literal, literal],
  })
  if (digestRecords.length > 0) return null
  const digest = credentialDigest(key)
  const inference = await inferenceAuthorities(session, digest)
  if (inference.length > 0) {
    if (!inference.every((row) => inferenceScopes(row))) return null
    return {
      kind: "inference",
      id: text(inference[0].id),
      digest: text(inference[0].digest),
    }
  }
  const id = await findGatewayCredential(session, key)
  return id === null ? null : { kind: "gateway", id, digest }
}

async function isActiveAuthority(session: SqlSession, bound: Authority) {
  if (bound.kind === "gateway") {
    const rows = await session.query({
      sql: "SELECT s.secret_value FROM capi_gateway_credentials c JOIN capi_gateway_secrets s ON s.credential_id=c.id WHERE c.id=? AND c.digest=? AND c.revoked_at IS NULL",
      args: [bound.id, bound.digest],
    })
    const value = rows[0]?.secret_value
    return (
      isStoredGatewayCredential(value)
      && credentialDigest(value) === bound.digest
    )
  }
  const hex =
    /^[a-f\d]{64}$/i.test(bound.digest) ?
      bound.digest.toLowerCase()
    : Buffer.from(bound.digest, "base64url").toString("hex")
  if (!/^[a-f\d]{64}$/.test(hex)) return invalidRecord()
  const rows = await inferenceAuthorities(session, hex)
  return (
    rows.some((row) => row.id === bound.id && row.digest === bound.digest)
    && rows.every((row) => inferenceScopes(row))
  )
}

async function insertAccess(
  session: SqlSession,
  input: { sessionId: string; token: string; now: number },
) {
  await session.execute({
    sql: "INSERT INTO capi_desktop_access_tokens (digest,session_id,created_at,expires_at) VALUES (?,?,?,?)",
    args: [
      credentialDigest(input.token),
      input.sessionId,
      input.now,
      input.now + ACCESS_LIFETIME_SECONDS * 1000,
    ],
  })
}

async function createSession(
  session: SqlSession,
  grant: DeviceGrant,
  now: number,
) {
  if (!grant.authority) return invalidRecord()
  const id = randomUUID()
  const tokens = createTokens()
  await session.execute({
    sql: "INSERT INTO capi_desktop_auth_sessions (id,principal_id,issuer,client_id,credential_kind,credential_id,credential_digest,refresh_digest,refresh_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    args: [
      id,
      "inference:desktop:" + id,
      grant.issuer,
      grant.clientId,
      grant.authority.kind,
      grant.authority.id,
      grant.authority.digest,
      credentialDigest(tokens.refreshToken),
      now + REFRESH_LIFETIME_SECONDS * 1000,
      now,
      now,
    ],
  })
  await insertAccess(session, { sessionId: id, token: tokens.accessToken, now })
  return tokens
}

export class DesktopGatewayAuthRepository {
  private readonly storage: Storage

  constructor(storage: Storage) {
    this.storage = storage
  }

  async issueDeviceAuthorization(
    input: DesktopGatewayAuthInput,
  ): Promise<DesktopDeviceAuthorization> {
    const issuer = normalizeIssuer(input.issuer)
    const now = timestamp(input.now ?? Date.now())
    const selectedClient = clientId(input.clientId)
    const deviceCode = secret("gw_device_")
    const normalizedCode = Array.from(
      { length: 8 },
      () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)],
    ).join("")
    const digest = credentialDigest(deviceCode)
    return mutateDesktopAuth(
      this.storage,
      {
        kind: "device",
        actor: issuer,
        binding: { issuer, selectedClient, digest, now },
      },
      async (session) => {
        await session.execute({
          sql: "DELETE FROM capi_desktop_device_grants WHERE expires_at<=?",
          args: [now],
        })
        await session.execute({
          sql: "INSERT INTO capi_desktop_device_grants (device_digest,user_code_digest,issuer,client_id,created_at,expires_at,interval_seconds,next_poll_at) VALUES (?,?,?,?,?,?,?,?)",
          args: [
            digest,
            credentialDigest(normalizedCode),
            issuer,
            selectedClient,
            now,
            now + DEVICE_LIFETIME_SECONDS * 1000,
            POLL_INTERVAL_SECONDS,
            now,
          ],
        })
        return outcome(
          {
            deviceCode,
            userCode: displayUserCode(normalizedCode),
            expiresIn: DEVICE_LIFETIME_SECONDS,
            interval: POLL_INTERVAL_SECONDS,
          },
          true,
        )
      },
    )
  }

  async getDeviceAuthorization(input: {
    issuer: string
    userCode: string
    now?: number
  }): Promise<DesktopDeviceAuthorizationView | null> {
    const code = userCode(input.userCode)
    if (!code) return null
    const issuer = normalizeIssuer(input.issuer)
    const now = timestamp(input.now ?? Date.now())
    return this.storage.read(async (session) => {
      const rows = await session.query({
        sql: "SELECT * FROM capi_desktop_device_grants WHERE user_code_digest=? AND issuer=?",
        args: [credentialDigest(code), issuer],
      })
      if (!rows[0]) return null
      const grant = deviceGrant(rows[0])
      return {
        userCode: displayUserCode(code),
        status: grant.expiresAt <= now ? "expired" : grant.status,
        expiresIn: Math.max(0, Math.ceil((grant.expiresAt - now) / 1000)),
        interval: grant.interval,
      }
    })
  }

  async approveDeviceAuthorization(input: {
    issuer: string
    userCode: string
    issuerKey: string
    action?: "approve" | "deny"
    now?: number
  }): Promise<DesktopGatewayApprovalResult> {
    const code = userCode(input.userCode)
    if (!code) return { status: "invalid_code" }
    const issuer = normalizeIssuer(input.issuer)
    const now = timestamp(input.now ?? Date.now())
    const action = approvalAction(input.action)
    const digest = credentialDigest(code)
    return mutateDesktopAuth<DesktopGatewayApprovalResult>(
      this.storage,
      {
        kind: "approve",
        actor: issuer,
        binding: { issuer, digest, action, now },
      },
      async (session) => {
        const rows = await session.query({
          sql: "SELECT * FROM capi_desktop_device_grants WHERE user_code_digest=? AND issuer=?",
          args: [digest, issuer],
        })
        if (!rows[0]) return outcome({ status: "invalid_code" })
        const grant = deviceGrant(rows[0])
        if (grant.status !== "pending" || grant.expiresAt <= now)
          return outcome({ status: "invalid_code" })
        const approved = await resolveAuthority(session, input.issuerKey)
        if (!approved) return outcome({ status: "invalid_credential" })
        const status = action === "deny" ? "denied" : "approved"
        const updated = await session.execute({
          sql: "UPDATE capi_desktop_device_grants SET status=?,credential_kind=?,credential_id=?,credential_digest=?,approved_at=? WHERE user_code_digest=? AND issuer=? AND status='pending' AND expires_at>?",
          args: [
            status,
            approved.kind,
            approved.id,
            approved.digest,
            now,
            digest,
            issuer,
            now,
          ],
        })
        return updated.rowsAffected === 1 ?
            outcome({ status }, true)
          : outcome({ status: "invalid_code" })
      },
    )
  }

  async exchangeDeviceCode(
    input: DesktopGatewayAuthInput & { deviceCode: string },
  ): Promise<DesktopGatewayTokenResult> {
    const issuer = normalizeIssuer(input.issuer)
    const now = timestamp(input.now ?? Date.now())
    const selectedClient = clientId(input.clientId)
    const digest = credentialDigest(input.deviceCode)
    return mutateDesktopAuth<DesktopGatewayTokenResult>(
      this.storage,
      {
        kind: "exchange",
        actor: issuer,
        binding: { issuer, selectedClient, digest, now },
      },
      async (session) => {
        const rows = await session.query({
          sql: "SELECT * FROM capi_desktop_device_grants WHERE device_digest=? AND issuer=?",
          args: [digest, issuer],
        })
        if (!rows[0]) return outcome({ status: "invalid_grant" })
        const grant = deviceGrant(rows[0])
        if (grant.clientId !== selectedClient || grant.status === "consumed")
          return outcome({ status: "invalid_grant" })
        if (grant.expiresAt <= now) return outcome({ status: "expired_token" })
        if (grant.status === "denied")
          return outcome({ status: "access_denied" })
        if (now < grant.nextPollAt) {
          await session.execute({
            sql: "UPDATE capi_desktop_device_grants SET interval_seconds=?,next_poll_at=? WHERE device_digest=?",
            args: [
              grant.interval + 5,
              now + (grant.interval + 5) * 1000,
              digest,
            ],
          })
          return outcome({ status: "slow_down" }, true)
        }
        if (grant.status === "pending") {
          await session.execute({
            sql: "UPDATE capi_desktop_device_grants SET next_poll_at=? WHERE device_digest=?",
            args: [now + grant.interval * 1000, digest],
          })
          return outcome({ status: "authorization_pending" }, true)
        }
        if (
          !grant.authority
          || !(await isActiveAuthority(session, grant.authority))
        )
          return outcome({ status: "invalid_grant" })
        const consumed = await session.execute({
          sql: "UPDATE capi_desktop_device_grants SET status='consumed',consumed_at=? WHERE device_digest=? AND status='approved' AND consumed_at IS NULL",
          args: [now, digest],
        })
        if (consumed.rowsAffected !== 1)
          return outcome({ status: "invalid_grant" })
        return outcome(
          { status: "ok", tokens: await createSession(session, grant, now) },
          true,
        )
      },
    )
  }

  async refresh(
    input: DesktopGatewayAuthInput & { refreshToken: string },
  ): Promise<DesktopGatewayTokenResult> {
    const issuer = normalizeIssuer(input.issuer)
    const now = timestamp(input.now ?? Date.now())
    const selectedClient = clientId(input.clientId)
    const digest = credentialDigest(input.refreshToken)
    return mutateDesktopAuth<DesktopGatewayTokenResult>(
      this.storage,
      {
        kind: "refresh",
        actor: issuer,
        binding: { issuer, selectedClient, digest, now },
      },
      async (session) => {
        const rows = await session.query({
          sql: "SELECT * FROM capi_desktop_auth_sessions WHERE refresh_digest=? AND issuer=?",
          args: [digest, issuer],
        })
        if (!rows[0]) return outcome({ status: "invalid_grant" })
        const bound = authSession(rows[0])
        if (
          bound.clientId !== selectedClient
          || bound.revokedAt !== null
          || bound.refreshExpiresAt <= now
          || !(await isActiveAuthority(session, bound.authority))
        )
          return outcome({ status: "invalid_grant" })
        const tokens = createTokens()
        const rotated = await session.execute({
          sql: "UPDATE capi_desktop_auth_sessions SET refresh_digest=?,refresh_expires_at=?,updated_at=? WHERE id=? AND refresh_digest=? AND revoked_at IS NULL AND refresh_expires_at>?",
          args: [
            credentialDigest(tokens.refreshToken),
            now + REFRESH_LIFETIME_SECONDS * 1000,
            now,
            bound.id,
            digest,
            now,
          ],
        })
        if (rotated.rowsAffected !== 1)
          return outcome({ status: "invalid_grant" })
        await insertAccess(session, {
          sessionId: bound.id,
          token: tokens.accessToken,
          now,
        })
        return outcome({ status: "ok", tokens }, true)
      },
    )
  }

  async resolveAccessToken(
    token: string,
    now = Date.now(),
  ): Promise<StoredInferenceCredential | null> {
    if (!/^gw_at_[\w-]{43}$/.test(token)) return null
    timestamp(now)
    return this.storage.read(async (session) => {
      const rows = await session.query({
        sql: "SELECT s.*,a.expires_at AS access_expires_at FROM capi_desktop_access_tokens a JOIN capi_desktop_auth_sessions s ON s.id=a.session_id WHERE a.digest=?",
        args: [credentialDigest(token)],
      })
      if (!rows[0]) return null
      const bound = authSession(rows[0])
      if (
        timestamp(rows[0].access_expires_at) <= now
        || bound.revokedAt !== null
        || !(await isActiveAuthority(session, bound.authority))
      )
        return null
      return { principalId: bound.principalId, scopes: ["user:inference"] }
    })
  }

  async revoke(input: {
    issuer: string
    token: string
    now?: number
  }): Promise<void> {
    const issuer = normalizeIssuer(input.issuer)
    const now = timestamp(input.now ?? Date.now())
    const digest = credentialDigest(input.token)
    return mutateDesktopAuth(
      this.storage,
      { kind: "revoke", actor: issuer, binding: { issuer, digest, now } },
      async (session) => {
        const rows = await session.query({
          sql: "SELECT id FROM capi_desktop_auth_sessions WHERE issuer=? AND refresh_digest=? UNION ALL SELECT s.id FROM capi_desktop_auth_sessions s JOIN capi_desktop_access_tokens a ON a.session_id=s.id WHERE s.issuer=? AND a.digest=? LIMIT 1",
          args: [issuer, digest, issuer, digest],
        })
        if (!rows[0]) return outcome(undefined)
        const updated = await session.execute({
          sql: "UPDATE capi_desktop_auth_sessions SET revoked_at=?,updated_at=? WHERE id=? AND revoked_at IS NULL",
          args: [now, now, text(rows[0].id)],
        })
        return outcome(undefined, updated.rowsAffected > 0)
      },
    )
  }
}

export function getDesktopGatewayAuthRepository(): DesktopGatewayAuthRepository {
  return new DesktopGatewayAuthRepository(getStorageRuntime().storage)
}
