import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createPkceChallenge,
  hashOAuthSecret,
  OAUTH_AUTHORIZATION_CODE_TTL_MS,
  OAUTH_CLIENT_TOKEN_LIFETIME_SECONDS,
  OAuthStore,
} from "../src/lib/oauth-store"

const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const redirectUri = "http://localhost:54545/callback"
const state = "state-with-enough-entropy-123456789"
const verifier = "v".repeat(64)
const scopes = ["user:profile", "user:inference"]

let temporaryDirectory: string
let storePath: string

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-oauth-store-"),
  )
  storePath = path.join(temporaryDirectory, "oauth_tokens.json")
})

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

async function issueCode(store: OAuthStore, now = Date.now()): Promise<string> {
  return await store.issueAuthorizationCode({
    clientId,
    redirectUri,
    scopes,
    state,
    codeChallenge: createPkceChallenge(verifier),
    now,
  })
}

test("persists only token digests and resolves credentials after restart", async () => {
  const store = new OAuthStore(storePath)
  const code = await issueCode(store)
  const exchange = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    state,
    codeVerifier: verifier,
  })
  expect(exchange.status).toBe("ok")
  if (exchange.status !== "ok") return

  const persisted = await fs.readFile(storePath, "utf8")
  expect(persisted).not.toContain(code)
  expect(persisted).not.toContain(exchange.tokens.accessToken)
  expect(persisted).not.toContain(exchange.tokens.refreshToken)

  const reloadedStore = new OAuthStore(storePath)
  expect(
    await reloadedStore.resolveAccessToken(exchange.tokens.accessToken),
  ).toMatchObject({ scopes })
  const refresh = await reloadedStore.refreshAccessToken({
    refreshToken: exchange.tokens.refreshToken,
    clientId,
  })
  expect(refresh.status).toBe("ok")
})

test("expires authorization codes but keeps access tokens valid", async () => {
  const store = new OAuthStore(storePath)
  const now = Date.now()
  const expiredCode = await issueCode(store, now)
  const expiredExchange = await store.exchangeAuthorizationCode({
    code: expiredCode,
    clientId,
    redirectUri,
    state,
    codeVerifier: verifier,
    now: now + OAUTH_AUTHORIZATION_CODE_TTL_MS + 1,
  })
  expect(expiredExchange).toEqual({ status: "invalid_grant" })

  const code = await issueCode(store, now)
  const exchange = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    state,
    codeVerifier: verifier,
    now,
  })
  expect(exchange.status).toBe("ok")
  if (exchange.status !== "ok") return

  expect(
    await store.resolveAccessToken(
      exchange.tokens.accessToken,
      now + (OAUTH_CLIENT_TOKEN_LIFETIME_SECONDS + 1) * 1000,
    ),
  ).toMatchObject({ scopes })
})

test("honors legacy token records after their old expiry timestamps", async () => {
  const createdAt = 1_000
  const expiresAt = 2_000
  const familyId = "legacy-family-id-1234567890"
  const accessToken = "legacy-access-token"
  const refreshToken = "legacy-refresh-token"
  await fs.writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      authorizationCodes: {},
      accessTokens: {
        [hashOAuthSecret(accessToken)]: {
          principalId: "oauth:legacy",
          familyId,
          clientId,
          scopes,
          createdAt,
          expiresAt,
        },
      },
      refreshTokens: {
        [hashOAuthSecret(refreshToken)]: {
          principalId: "oauth:legacy",
          familyId,
          clientId,
          scopes,
          createdAt,
          expiresAt,
        },
      },
      inferenceCredentials: {},
      tokenFamilies: {
        [familyId]: { createdAt, expiresAt },
      },
    }),
  )

  const store = new OAuthStore(storePath)
  expect(
    await store.resolveAccessToken(accessToken, expiresAt + 1),
  ).toMatchObject({ scopes })
  expect(
    await store.refreshAccessToken({
      refreshToken,
      clientId,
      now: expiresAt + 1,
    }),
  ).toMatchObject({ status: "ok" })
})

test("keeps a code usable after a mismatched binding but consumes it once valid", async () => {
  const store = new OAuthStore(storePath)
  const code = await issueCode(store)
  const wrongRedirect = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri: "http://localhost:54546/callback",
    state,
    codeVerifier: verifier,
  })
  expect(wrongRedirect).toEqual({ status: "invalid_grant" })

  const valid = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    state,
    codeVerifier: verifier,
  })
  expect(valid.status).toBe("ok")

  const replay = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    state,
    codeVerifier: verifier,
  })
  expect(replay).toEqual({ status: "invalid_grant" })
})

test("refresh tokens are repeatable without revoking the token family", async () => {
  const store = new OAuthStore(storePath)
  const code = await issueCode(store)
  const exchange = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    state,
    codeVerifier: verifier,
  })
  expect(exchange.status).toBe("ok")
  if (exchange.status !== "ok") return

  const rotation = await store.refreshAccessToken({
    refreshToken: exchange.tokens.refreshToken,
    clientId,
  })
  expect(rotation.status).toBe("ok")
  if (rotation.status !== "ok") return

  const retry = await store.refreshAccessToken({
    refreshToken: exchange.tokens.refreshToken,
    clientId,
  })
  expect(retry.status).toBe("ok")
  if (retry.status !== "ok") return
  expect(retry.tokens.refreshToken).toBe(exchange.tokens.refreshToken)
  expect(rotation.tokens.refreshToken).toBe(exchange.tokens.refreshToken)

  const restartedStore = new OAuthStore(storePath)
  expect(
    await restartedStore.resolveAccessToken(rotation.tokens.accessToken),
  ).not.toBeNull()
  expect(
    await restartedStore.refreshAccessToken({
      refreshToken: exchange.tokens.refreshToken,
      clientId,
    }),
  ).toMatchObject({ status: "ok" })
})

test("concurrent refresh attempts both succeed without revoking the family", async () => {
  const store = new OAuthStore(storePath)
  const code = await issueCode(store)
  const exchange = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    state,
    codeVerifier: verifier,
  })
  expect(exchange.status).toBe("ok")
  if (exchange.status !== "ok") return

  const results = await Promise.all([
    store.refreshAccessToken({
      refreshToken: exchange.tokens.refreshToken,
      clientId,
    }),
    store.refreshAccessToken({
      refreshToken: exchange.tokens.refreshToken,
      clientId,
    }),
  ])
  expect(results.map((result) => result.status)).toEqual(["ok", "ok"])
  for (const result of results) {
    if (result.status !== "ok") continue
    expect(result.tokens.refreshToken).toBe(exchange.tokens.refreshToken)
    expect(
      await store.resolveAccessToken(result.tokens.accessToken),
    ).not.toBeNull()
  }
})

test("invalid refresh and unknown revocation do not rewrite the store", async () => {
  const store = new OAuthStore(storePath)
  const code = await issueCode(store)
  const before = await fs.stat(storePath)

  expect(
    await store.refreshAccessToken({
      refreshToken: "unknown-refresh-token",
      clientId,
    }),
  ).toEqual({ status: "invalid_grant" })
  await store.revokeToken("unknown-token")

  const after = await fs.stat(storePath)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect((await fs.readFile(storePath, "utf8")).includes(code)).toBe(false)
})

test("refresh downscopes access without permanently narrowing the grant", async () => {
  const store = new OAuthStore(storePath)
  const code = await issueCode(store)
  const exchange = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    state,
    codeVerifier: verifier,
  })
  expect(exchange.status).toBe("ok")
  if (exchange.status !== "ok") return

  const narrowed = await store.refreshAccessToken({
    refreshToken: exchange.tokens.refreshToken,
    clientId,
    scopes: ["user:inference"],
  })
  expect(narrowed.status).toBe("ok")
  if (narrowed.status !== "ok") return
  expect(narrowed.tokens.scopes).toEqual(["user:inference"])

  const restored = await store.refreshAccessToken({
    refreshToken: narrowed.tokens.refreshToken,
    clientId,
    scopes,
  })
  expect(restored.status).toBe("ok")
  if (restored.status === "ok") expect(restored.tokens.scopes).toEqual(scopes)
})

test("rejects malformed persisted records instead of trusting stored scopes", async () => {
  await fs.writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      authorizationCodes: {},
      accessTokens: {
        "malformed-access-digest-value": {
          principalId: "oauth:attacker",
          familyId: "family-attacker-value-1234",
          clientId,
          scopes: ["*"],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      refreshTokens: {},
      inferenceCredentials: {},
      tokenFamilies: {},
    }),
  )

  expect(new OAuthStore(storePath).resolveAccessToken("raw")).rejects.toThrow(
    "Invalid OAuth token store record",
  )
})
