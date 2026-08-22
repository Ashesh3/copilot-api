import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  extractRequestCredential,
  hasSuppliedRequestCredential,
  isGoogleApiCredentialPath,
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

function request(pathname: string, headers?: Record<string, string>): Request {
  return new Request(
    `http://localhost${pathname}`,
    headers === undefined ? undefined : { headers: new Headers(headers) },
  )
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

test("rejects ambiguous credentials and accepts long credential values", () => {
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
  const longCredential = "x".repeat(4097)
  expect(
    extractRequestCredential(
      new Request("http://localhost", {
        headers: { authorization: `Bearer ${longCredential}` },
      }),
    ),
  ).toBe(longCredential)
})

test("recognizes only exact Google API credential action paths", () => {
  for (const prefix of ["", "/v1", "/v1beta"]) {
    for (const action of [
      "generateContent",
      "streamGenerateContent",
      "countTokens",
    ]) {
      const pathname = `${prefix}/models/model.with-dashes:${action}`
      expect(isGoogleApiCredentialPath(pathname)).toBe(true)
      expect(isGoogleApiCredentialPath(`${pathname}/`)).toBe(true)
    }
  }

  for (const pathname of [
    "/models",
    "/v1/models",
    "/v1beta/models",
    "/models/:generateContent",
    "/models/a/b:generateContent",
    "/v2/models/x:generateContent",
    "/models/x:futureAction",
    "/models/x:GenerateContent",
    "/proxy/v1/models/x:generateContent",
    "/v1/responses",
    "/v1/models/x:generateContent/extra",
    "/v1/models/x:generateContent//",
  ]) {
    expect(isGoogleApiCredentialPath(pathname)).toBe(false)
  }
})

test("collects, trims, and deduplicates Google query and header credentials", () => {
  const googlePath = "/v1/models/model.with-dashes:generateContent"
  expect(extractRequestCredential(request(`${googlePath}?key=shared`))).toBe(
    "shared",
  )
  expect(
    extractRequestCredential(
      request(`${googlePath}?key=%20shared%20`, {
        authorization: "Bearer shared",
        "x-api-key": " shared ",
        "x-goog-api-key": "shared",
      }),
    ),
  ).toBe("shared")
  expect(
    extractRequestCredential(
      request(`${googlePath}?key=first&key=second`, {
        "x-goog-api-key": "first",
      }),
    ),
  ).toBeNull()
  expect(
    extractRequestCredential(
      request(`${googlePath}?key=shared&key=%20shared%20`),
    ),
  ).toBe("shared")
  expect(
    extractRequestCredential(request(`${googlePath}?key=&key=shared`)),
  ).toBe("shared")
  expect(
    extractRequestCredential(request(`${googlePath}?key=first&key=second`)),
  ).toBeNull()
})

test("limits query credentials to Google actions and preserves supplied-attempt semantics", () => {
  const googlePath = "/v1beta/models/x:countTokens"
  expect(
    hasSuppliedRequestCredential(request(`${googlePath}?key=shared`)),
  ).toBe(true)
  expect(hasSuppliedRequestCredential(request(`${googlePath}?key=%20`))).toBe(
    false,
  )
  expect(extractRequestCredential(request(`${googlePath}?key=%20`))).toBeNull()

  for (const pathname of [
    "/v1/responses?key=shared",
    "/v1/models/x:futureAction?key=shared",
    "/v2/models/x:generateContent?key=shared",
    "/v1/responses?next=/v1/models/x:generateContent&key=shared",
  ]) {
    expect(hasSuppliedRequestCredential(request(pathname))).toBe(false)
    expect(extractRequestCredential(request(pathname))).toBeNull()
  }

  const suppliedHeaders: Array<Record<string, string>> = [
    { "x-api-key": "" },
    { "x-goog-api-key": "" },
    { authorization: "" },
    { authorization: "Basic malformed" },
  ]
  for (const headers of suppliedHeaders) {
    expect(
      hasSuppliedRequestCredential(request("/v1/responses", headers)),
    ).toBe(true)
    expect(
      extractRequestCredential(request("/v1/responses", headers)),
    ).toBeNull()
  }
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
