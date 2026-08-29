import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { setConfigForTest } from "../src/lib/config"
import {
  extractRequestCredential,
  hasSuppliedRequestCredential,
  isGoogleApiCredentialPath,
  registerCredentialProvider,
  resolveCredential,
  resolveGatewayCredential,
  resolveRequestCredentialKind,
} from "../src/lib/credential-resolver"
import {
  createPkceChallenge,
  OAuthStore,
  setOAuthStoreForTest,
} from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import { trustedJwtDigestStore } from "../src/lib/trusted-jwt-digests"

const originalGatewayKey = state.apiKeyAuth
const originalInferenceCredentialDigests =
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
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
  setConfigForTest({ auth: { apiKeys: [] } })
  delete process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  trustedJwtDigestStore.replaceForTest([])
})

afterEach(async () => {
  setOAuthStoreForTest(null)
  setConfigForTest(null)
  state.apiKeyAuth = originalGatewayKey
  if (originalInferenceCredentialDigests === undefined) {
    delete process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S
  } else {
    process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S =
      originalInferenceCredentialDigests
  }
  trustedJwtDigestStore.resetAfterTest()
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
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

test("limits configured digest credentials to inference scope", async () => {
  const rawCredential = "test-codex-desktop-token"
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S =
    "a3b73b87238555863cbe9291649bd56227b8871aaa7bfc052d9f704bbfce8585"

  expect(
    await resolveCredential(rawCredential, ["user:inference"]),
  ).toMatchObject({
    kind: "inference-client",
    principalId: "inference-env:a3b73b8723855586",
    scopes: new Set(["user:inference"]),
  })
  expect(await resolveCredential(rawCredential, ["user:profile"])).toBeNull()
  expect(
    await resolveCredential(rawCredential, ["org:create_api_key"]),
  ).toBeNull()
})

test("limits dashboard-managed JWT digests to inference scope", async () => {
  const rawCredential = "managed.jwt.signature"
  const digest = sha256Hex(rawCredential)
  const entry = trustedJwtDigestStore.add({ label: "Laptop", digest })

  expect(
    await resolveCredential(rawCredential, ["user:inference"]),
  ).toMatchObject({
    principalId: `inference-managed:${entry.id}`,
    kind: "inference-client",
    scopes: new Set(["user:inference"]),
  })
  expect(await resolveCredential(rawCredential, ["user:profile"])).toBeNull()
  expect(
    await resolveCredential(rawCredential, ["org:create_api_key"]),
  ).toBeNull()
  expect(await resolveCredential(digest)).toBeNull()

  trustedJwtDigestStore.setEnabled(entry.id, false)
  expect(await resolveCredential(rawCredential)).toBeNull()
})

test("managed JWT rows override duplicate environment digests until deleted", async () => {
  const rawCredential = "managed-environment-duplicate.jwt.signature"
  const digest = sha256Hex(rawCredential)
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = digest
  const entry = trustedJwtDigestStore.add({
    label: "Managed migration",
    digest,
  })

  expect(
    await resolveCredential(rawCredential, ["user:inference"]),
  ).toMatchObject({
    principalId: `inference-managed:${entry.id}`,
    kind: "inference-client",
  })
  expect(await resolveCredential(digest)).toBeNull()

  trustedJwtDigestStore.setEnabled(entry.id, false)
  expect(await resolveCredential(rawCredential, ["user:inference"])).toBeNull()
  expect(await resolveCredential(digest)).toBeNull()

  trustedJwtDigestStore.remove(entry.id)
  expect(
    await resolveCredential(rawCredential, ["user:inference"]),
  ).toMatchObject({
    principalId: `inference-env:${digest.slice(0, 16)}`,
    kind: "inference-client",
  })
})

test("does not elevate a managed digest through gateway fallback", async () => {
  const rawCredential = "gateway-secret"
  const entry = trustedJwtDigestStore.add({
    label: "Gateway collision",
    digest: sha256Hex(rawCredential),
  })

  expect(
    await resolveCredential(rawCredential, ["user:inference"]),
  ).toMatchObject({ kind: "inference-client" })
  expect(await resolveCredential(rawCredential, ["user:profile"])).toBeNull()
  expect(resolveGatewayCredential(rawCredential)).toBeNull()

  trustedJwtDigestStore.setEnabled(entry.id, false)
  expect(await resolveCredential(rawCredential)).toBeNull()
  expect(resolveGatewayCredential(rawCredential)).toBeNull()

  trustedJwtDigestStore.remove(entry.id)
  expect(resolveGatewayCredential(rawCredential)).toMatchObject({
    kind: "gateway",
  })
})

test("does not elevate a configured inference digest through gateway fallback", async () => {
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = sha256Hex("gateway-secret")

  expect(
    await resolveCredential("gateway-secret", ["user:inference"]),
  ).toMatchObject({ kind: "inference-client" })
  expect(await resolveCredential("gateway-secret", ["user:profile"])).toBeNull()
  expect(resolveGatewayCredential("gateway-secret")).toBeNull()

  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = sha256Hex("gateway-secret")
  expect(resolveGatewayCredential(" gateway-secret ")).toBeNull()

  state.apiKeyAuth = " gateway-secret "
  expect(resolveGatewayCredential("gateway-secret")).toBeNull()

  state.apiKeyAuth = undefined
  setConfigForTest({
    auth: { apiKeys: ["gateway-secret", " gateway-secret "] },
  })
  expect(resolveGatewayCredential("gateway-secret")).toBeNull()

  const digestLiteral = sha256Hex("inference-only-secret")
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = digestLiteral
  state.apiKeyAuth = digestLiteral
  expect(resolveGatewayCredential(digestLiteral)).toBeNull()
  expect(await resolveCredential(digestLiteral)).toBeNull()
})

test("preserves internal bearer whitespace for inference classification", async () => {
  state.apiKeyAuth = "inference secret"
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S =
    sha256Hex("inference  secret")

  expect(
    await resolveRequestCredentialKind(
      bearer("inference  secret"),
      "inference-client",
      { requiredScopes: ["user:inference"] },
    ),
  ).toMatchObject({ kind: "inference-client" })
  expect(
    await resolveRequestCredentialKind(bearer("inference  secret"), "gateway"),
  ).toBeNull()
})

test("does not elevate a configured inference digest through OAuth fallback", async () => {
  const oauthToken = await issueOAuthToken()
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = sha256Hex(oauthToken)

  expect(await resolveCredential(oauthToken, ["user:profile"])).toBeNull()
})

test("does not elevate a managed digest through OAuth fallback", async () => {
  const oauthToken = await issueOAuthToken()
  const entry = trustedJwtDigestStore.add({
    label: "OAuth collision",
    digest: sha256Hex(oauthToken),
  })

  expect(await resolveCredential(oauthToken, ["user:profile"])).toBeNull()

  trustedJwtDigestStore.setEnabled(entry.id, false)
  expect(await resolveCredential(oauthToken, ["user:profile"])).toBeNull()

  trustedJwtDigestStore.remove(entry.id)
  expect(await resolveCredential(oauthToken, ["user:profile"])).toMatchObject({
    kind: "oauth",
  })
})

test("accepts configured digest lists without treating digests as secrets", async () => {
  const firstCredential = "first-codex-desktop-token"
  const secondCredential = "second-codex-desktop-token"
  const firstDigest = sha256Hex(firstCredential)
  const secondDigest = sha256Hex(secondCredential)
  process.env.COPILOT_INFERENCE_CREDENTIAL_SHA256S = [
    "not-a-sha256-digest",
    firstDigest.toUpperCase(),
    secondDigest,
  ].join(",")

  expect(await resolveCredential(firstCredential)).toMatchObject({
    kind: "inference-client",
  })
  expect(await resolveCredential(secondCredential)).toMatchObject({
    kind: "inference-client",
  })
  expect(await resolveCredential(firstDigest)).toBeNull()
  expect(await resolveCredential("unconfigured-token")).toBeNull()
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
