import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  extractRequestCredential,
  registerCredentialProvider,
  resolveRequestCredentialKind,
} from "../src/lib/credential-resolver"
import {
  createPkceChallenge,
  OAuthStore,
  setOAuthStoreForTest,
} from "../src/lib/oauth-store"
import { state } from "../src/lib/state"

const originalGatewayKey = state.apiKeyAuth
const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const redirectUri = "http://localhost:54545/callback"
const verifier = "v".repeat(64)
const oauthState = "state-with-enough-entropy-123456789"

let temporaryDirectory: string
let store: OAuthStore

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-credential-resolver-"),
  )
  store = new OAuthStore(path.join(temporaryDirectory, "oauth_tokens.json"))
  setOAuthStoreForTest(store)
  state.apiKeyAuth = "gateway-secret"
})

afterEach(async () => {
  setOAuthStoreForTest(null)
  state.apiKeyAuth = originalGatewayKey
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

function bearer(token: string): Request {
  return new Request("http://localhost/protected", {
    headers: { authorization: `Bearer ${token}` },
  })
}

async function issueOAuthToken(): Promise<string> {
  const code = await store.issueAuthorizationCode({
    clientId,
    redirectUri,
    scopes: ["user:profile", "user:inference"],
    state: oauthState,
    codeChallenge: createPkceChallenge(verifier),
  })
  const result = await store.exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    state: oauthState,
    codeVerifier: verifier,
  })
  if (result.status !== "ok") throw new Error("Failed to issue OAuth token")
  return result.tokens.accessToken
}

test("distinguishes gateway, OAuth, and inference-client credentials", async () => {
  const oauthToken = await issueOAuthToken()
  const inferenceKey = await store.mintInferenceCredential()

  expect(
    await resolveRequestCredentialKind(bearer("gateway-secret"), "gateway"),
  ).toMatchObject({ kind: "gateway" })
  expect(
    await resolveRequestCredentialKind(bearer(oauthToken), "oauth", {
      requiredScopes: ["user:profile"],
    }),
  ).toMatchObject({ kind: "oauth" })
  expect(
    await resolveRequestCredentialKind(
      bearer(inferenceKey),
      "inference-client",
      { requiredScopes: ["user:inference"] },
    ),
  ).toMatchObject({ kind: "inference-client" })
  expect(
    await resolveRequestCredentialKind(bearer(oauthToken), "gateway"),
  ).toBeNull()
})

test("rejects ambiguous and oversized credential envelopes", () => {
  expect(
    extractRequestCredential(
      new Request("http://localhost", {
        headers: {
          authorization: "Bearer first",
          "x-api-key": "second",
        },
      }),
    ),
  ).toBeNull()
  expect(
    extractRequestCredential(
      new Request("http://localhost", {
        headers: { authorization: `Bearer ${"x".repeat(4097)}` },
      }),
    ),
  ).toBeNull()
})

test("dispatches worker, environment, and admin through typed providers", async () => {
  const unregisterWorker = registerCredentialProvider(
    "worker",
    (_request, context) =>
      context.sessionId === "session-1" ?
        {
          kind: "worker",
          principalId: "worker:session-1",
          scopes: new Set(),
        }
      : null,
  )
  const unregisterEnvironment = registerCredentialProvider(
    "environment",
    (_request, context) =>
      context.environmentId === "environment-1" ?
        {
          kind: "environment",
          principalId: "environment:environment-1",
          scopes: new Set(),
        }
      : null,
  )
  const unregisterAdmin = registerCredentialProvider("admin", () => ({
    kind: "admin",
    principalId: "admin:test",
    scopes: new Set(),
  }))

  try {
    const request = new Request("http://localhost/protected")
    expect(
      await resolveRequestCredentialKind(request, "worker", {
        sessionId: "session-1",
      }),
    ).toMatchObject({ kind: "worker" })
    expect(
      await resolveRequestCredentialKind(request, "environment", {
        environmentId: "environment-1",
      }),
    ).toMatchObject({ kind: "environment" })
    expect(await resolveRequestCredentialKind(request, "admin")).toMatchObject({
      kind: "admin",
    })
  } finally {
    unregisterWorker()
    unregisterEnvironment()
    unregisterAdmin()
  }
})
