/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun asynchronous rejection matchers have void type declarations. */
import "./helpers/auth-misc-data-dir"

import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  credentialDigest,
  insertGatewayCredential,
} from "~/lib/storage/credentials-repository"
import { DesktopGatewayAuthRepository } from "~/lib/storage/desktop-gateway-auth-repository"
import { StorageUnavailableError } from "~/lib/storage/errors"
import { getStoreRevision } from "~/lib/storage/operations"

import { createAuthStorageFixture } from "./helpers/auth-storage"

const issuer = "https://gateway.example/v1"
const issuerKey = "desktop-refresh-replay-test-key"
const hour = 3_600_000
const month = 2_592_000_000
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let repository: DesktopGatewayAuthRepository
let now: number

beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  repository = new DesktopGatewayAuthRepository(fixture.storage)
  now = Date.now() - 20_000
  await fixture.storage.transaction((session) =>
    insertGatewayCredential(session, {
      id: "desktop-retention-issuer",
      credential: issuerKey,
      label: "Desktop refresh test",
      createdAt: now,
    }),
  )
})

afterEach(async () => {
  await fixture.close()
})

async function issuedTokens(options: { at?: number; clientId?: string } = {}) {
  const at = options.at ?? now
  const device = await repository.issueDeviceAuthorization({
    issuer,
    clientId: options.clientId,
    now: at,
  })
  expect(
    await repository.approveDeviceAuthorization({
      issuer,
      issuerKey,
      userCode: device.userCode,
      now: at + 1,
    }),
  ).toEqual({ status: "approved" })
  const result = await repository.exchangeDeviceCode({
    issuer,
    clientId: options.clientId,
    deviceCode: device.deviceCode,
    now: at + 5000,
  })
  if (result.status !== "ok") throw new Error("Device fixture failed")
  return { tokens: result.tokens, issuedAt: at + 5000 }
}

async function rotate(refreshToken: string, at: number, clientId?: string) {
  const result = await repository.refresh({
    issuer,
    refreshToken,
    clientId,
    now: at,
  })
  if (result.status !== "ok") throw new Error("Refresh fixture failed")
  return result.tokens
}

async function rows(table: string) {
  return fixture.storage.read((session) =>
    session.query({ sql: "SELECT * FROM " + table, args: [] }),
  )
}

test("replaying a stolen consumed refresh token revokes only its compromised session", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  const attacker = await rotate(tokens.refreshToken, issuedAt + 1000)
  const unrelated = await issuedTokens()
  expect(
    await repository.refresh({
      issuer,
      refreshToken: tokens.refreshToken,
      now: issuedAt + 2000,
    }),
  ).toEqual({ status: "invalid_grant" })
  for (const token of [tokens.accessToken, attacker.accessToken])
    expect(
      await repository.resolveAccessToken(token, issuedAt + 2001),
    ).toBeNull()
  expect(
    await repository.refresh({
      issuer,
      refreshToken: attacker.refreshToken,
      now: issuedAt + 2001,
    }),
  ).toEqual({ status: "invalid_grant" })
  expect(
    await repository.resolveAccessToken(
      unrelated.tokens.accessToken,
      issuedAt + 2001,
    ),
  ).not.toBeNull()
})

test("revoking an original consumed refresh token invalidates its rotated successor", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  const attacker = await rotate(tokens.refreshToken, issuedAt + 1000)
  await repository.revoke({
    issuer,
    token: tokens.refreshToken,
    now: issuedAt + 2000,
  })
  expect(
    await repository.resolveAccessToken(attacker.accessToken, issuedAt + 2001),
  ).toBeNull()
  expect(
    await repository.refresh({
      issuer,
      refreshToken: attacker.refreshToken,
      now: issuedAt + 2001,
    }),
  ).toEqual({ status: "invalid_grant" })
})

test("consumed-token replay and revocation validate issuer and registered client bindings", async () => {
  const { tokens, issuedAt } = await issuedTokens({
    clientId: "desktop-client",
  })
  const successor = await rotate(
    tokens.refreshToken,
    issuedAt + 1000,
    "desktop-client",
  )
  for (const binding of [
    { issuer: "https://other.example/v1", clientId: "desktop-client" },
    { issuer: "https://gateway.example", clientId: "desktop-client" },
    { issuer, clientId: "other-client" },
    { issuer },
  ]) {
    expect(
      await repository.refresh({
        ...binding,
        refreshToken: tokens.refreshToken,
        now: issuedAt + 2000,
      }),
    ).toEqual({ status: "invalid_grant" })
    await repository.revoke({
      ...binding,
      token: tokens.refreshToken,
      now: issuedAt + 2000,
    })
    expect(
      await repository.resolveAccessToken(
        successor.accessToken,
        issuedAt + 2001,
      ),
    ).not.toBeNull()
  }
  await repository.revoke({
    issuer,
    clientId: "desktop-client",
    token: tokens.refreshToken,
    now: issuedAt + 3000,
  })
  expect(
    await repository.resolveAccessToken(successor.accessToken, issuedAt + 3001),
  ).toBeNull()
})

test("consumed refresh mappings survive restart and retain the original token expiry", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  const successor = await rotate(tokens.refreshToken, issuedAt + 1000)
  expect(await rows("capi_desktop_consumed_refresh_tokens")).toMatchObject([
    {
      digest: credentialDigest(tokens.refreshToken),
      expires_at: issuedAt + month,
    },
  ])
  await fixture.restart()
  const reopened = new DesktopGatewayAuthRepository(fixture.storage)
  expect(
    await reopened.refresh({
      issuer,
      refreshToken: tokens.refreshToken,
      now: issuedAt + 2000,
    }),
  ).toEqual({ status: "invalid_grant" })
  expect(
    await reopened.resolveAccessToken(successor.accessToken, issuedAt + 2001),
  ).toBeNull()
})

test("an expired consumed token cannot revoke a still-active rotated session", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  const first = await rotate(tokens.refreshToken, issuedAt + 1000)
  const recent = await rotate(first.refreshToken, issuedAt + month - 1000)
  expect(
    await repository.refresh({
      issuer,
      refreshToken: tokens.refreshToken,
      now: issuedAt + month,
    }),
  ).toEqual({ status: "invalid_grant" })
  await repository.revoke({
    issuer,
    token: tokens.refreshToken,
    now: issuedAt + month,
  })
  expect(
    await repository.resolveAccessToken(recent.accessToken, issuedAt + month),
  ).not.toBeNull()
  await rotate(recent.refreshToken, issuedAt + month)
  const retained = await rows("capi_desktop_consumed_refresh_tokens")
  expect(retained.map((row) => row.digest)).not.toContain(
    credentialDigest(tokens.refreshToken),
  )
  expect(retained.map((row) => row.digest)).toContain(
    credentialDigest(first.refreshToken),
  )
})

test("failed refresh rolls back both rotation and consumed-token registration", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  fixture.failWrites()
  await expect(
    repository.refresh({
      issuer,
      refreshToken: tokens.refreshToken,
      now: issuedAt + 1000,
    }),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  fixture.failWrites(false)
  expect(await rows("capi_desktop_consumed_refresh_tokens")).toEqual([])
  const successor = await rotate(tokens.refreshToken, issuedAt + 1000)
  expect(
    await repository.resolveAccessToken(successor.accessToken, issuedAt + 1001),
  ).not.toBeNull()
})

test("lost refresh commit response preserves replay detection without duplicate tokens", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  fixture.loseNextCommitResponse()
  const successor = await rotate(tokens.refreshToken, issuedAt + 1000)
  expect(await rows("capi_desktop_consumed_refresh_tokens")).toHaveLength(1)
  expect(await rows("capi_desktop_access_tokens")).toHaveLength(2)
  await repository.refresh({
    issuer,
    refreshToken: tokens.refreshToken,
    now: issuedAt + 2000,
  })
  expect(
    await repository.resolveAccessToken(successor.accessToken, issuedAt + 2001),
  ).toBeNull()
})

test("device issuance and successful refresh prune expired access while preserving active tokens", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  const successor = await rotate(tokens.refreshToken, issuedAt + 1000)
  await repository.issueDeviceAuthorization({ issuer, now: issuedAt + hour })
  expect(
    (await rows("capi_desktop_access_tokens")).map((row) => row.digest),
  ).toEqual([credentialDigest(successor.accessToken)])
  expect(
    await repository.resolveAccessToken(successor.accessToken, issuedAt + hour),
  ).not.toBeNull()
  expect(await rows("capi_desktop_auth_sessions")).toHaveLength(1)
  expect(await rows("capi_desktop_consumed_refresh_tokens")).toHaveLength(1)
  const next = await rotate(successor.refreshToken, issuedAt + hour + 1000)
  expect(
    (await rows("capi_desktop_access_tokens")).map((row) => row.digest),
  ).toEqual([credentialDigest(next.accessToken)])
})

test("cleanup retires expired sessions while preserving unrelated active sessions", async () => {
  const old = await issuedTokens()
  const active = await issuedTokens({ at: old.issuedAt + month - 15_000 })
  await repository.issueDeviceAuthorization({
    issuer,
    now: old.issuedAt + month,
  })
  expect(await rows("capi_desktop_auth_sessions")).toHaveLength(1)
  expect(await rows("capi_desktop_access_tokens")).toHaveLength(1)
  expect(
    await repository.resolveAccessToken(
      active.tokens.accessToken,
      old.issuedAt + month,
    ),
  ).not.toBeNull()
})

test("natural refresh expiry does not remove a session with unexpired access", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  await fixture.storage.atomicBatch([
    {
      sql: "UPDATE capi_desktop_auth_sessions SET refresh_expires_at=?",
      args: [issuedAt + 500],
    },
  ])
  await repository.issueDeviceAuthorization({ issuer, now: issuedAt + 1000 })
  expect(await rows("capi_desktop_auth_sessions")).toHaveLength(1)
  expect(
    await repository.resolveAccessToken(tokens.accessToken, issuedAt + 1000),
  ).not.toBeNull()
  await repository.issueDeviceAuthorization({ issuer, now: issuedAt + hour })
  expect(await rows("capi_desktop_access_tokens")).toEqual([])
  expect(await rows("capi_desktop_auth_sessions")).toEqual([])
})

test("revoked sessions retain unexpired access records and replay mappings until their expiries", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  const successor = await rotate(tokens.refreshToken, issuedAt + 1000)
  await repository.revoke({
    issuer,
    token: successor.refreshToken,
    now: issuedAt + 2000,
  })
  expect(await rows("capi_desktop_access_tokens")).toHaveLength(2)
  await repository.issueDeviceAuthorization({
    issuer,
    now: issuedAt + hour + 1000,
  })
  expect(await rows("capi_desktop_access_tokens")).toEqual([])
  expect(await rows("capi_desktop_auth_sessions")).toHaveLength(1)
  expect(await rows("capi_desktop_consumed_refresh_tokens")).toHaveLength(1)
  await repository.issueDeviceAuthorization({ issuer, now: issuedAt + month })
  expect(await rows("capi_desktop_consumed_refresh_tokens")).toEqual([])
  expect(await rows("capi_desktop_auth_sessions")).toEqual([])
})

test("retention cleanup rolls back on failure and reconciles a lost issuance commit", async () => {
  const { tokens, issuedAt } = await issuedTokens()
  await rotate(tokens.refreshToken, issuedAt + 1000)
  fixture.failWrites()
  await expect(
    repository.issueDeviceAuthorization({ issuer, now: issuedAt + hour }),
  ).rejects.toBeInstanceOf(StorageUnavailableError)
  fixture.failWrites(false)
  expect(await rows("capi_desktop_access_tokens")).toHaveLength(2)
  fixture.loseNextCommitResponse()
  const device = await repository.issueDeviceAuthorization({
    issuer,
    now: issuedAt + hour,
  })
  expect(
    await repository.getDeviceAuthorization({
      issuer,
      userCode: device.userCode,
      now: issuedAt + hour,
    }),
  ).toMatchObject({ status: "pending" })
  expect(await rows("capi_desktop_access_tokens")).toHaveLength(1)
  expect(await getStoreRevision(fixture.storage)).toBe(0)
})
