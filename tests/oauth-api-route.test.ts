import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { resolveCredential } from "../src/lib/credential-resolver"
import { isIpBlocked, resetIpSecurityForTest } from "../src/lib/ip-blocker"
import {
  createPkceChallenge,
  OAuthStore,
  setOAuthStoreForTest,
} from "../src/lib/oauth-store"
import { state } from "../src/lib/state"
import {
  removeFeatureFlag,
  setFeatureFlag,
} from "../src/routes/feature-flags/store"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth
const originalWarn = consola.warn
const oauthClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const oauthRedirectUri = "https://platform.claude.com/oauth/code/callback"
const oauthScopes =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
const oauthVerifier = "v".repeat(64)
const oauthState = "state-with-enough-entropy-123456789"
let temporaryDirectory: string | undefined
let oauthStorePath: string | undefined

function authorizationQuery(
  redirectUri: string = oauthRedirectUri,
): URLSearchParams {
  return new URLSearchParams({
    client_id: oauthClientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: oauthScopes,
    code_challenge: createPkceChallenge(oauthVerifier),
    code_challenge_method: "S256",
    state: oauthState,
  })
}

beforeEach(async () => {
  state.apiKeyAuth = "test-secret-key"
  resetIpSecurityForTest()
  consola.warn = mock(() => {}) as unknown as typeof consola.warn
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-oauth-"),
  )
  oauthStorePath = path.join(temporaryDirectory, "oauth_tokens.json")
  setOAuthStoreForTest(new OAuthStore(oauthStorePath))
})

afterEach(async () => {
  resetIpSecurityForTest()
  setOAuthStoreForTest(null)
  const directory = temporaryDirectory
  temporaryDirectory = undefined
  oauthStorePath = undefined
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  consola.warn = originalWarn
  removeFeatureFlag("claude_code_penguin_mode")
})

test("accepts versioned telemetry calls without auth", async () => {
  const response = await server.request("/api/event_logging/v2/batch", {
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toBe("")
})

test("denies unknown /api calls instead of acknowledging them pre-auth", async () => {
  const response = await server.request("/api/unknown/noop", {
    method: "POST",
  })

  expect(response.status).toBe(404)
})

test("still requires auth for defined OAuth API routes", async () => {
  const unauthorizedResponse = await server.request("/api/oauth/profile")

  expect(unauthorizedResponse.status).toBe(401)

  const gatewayResponse = await server.request("/api/oauth/profile", {
    headers: { authorization: "Bearer test-secret-key" },
  })

  expect(gatewayResponse.status).toBe(401)
})

test("penguin mode reports fast mode enabled by default", async () => {
  removeFeatureFlag("claude_code_penguin_mode")

  const tokens = await authorizeAndExchange()
  const response = await server.request("/api/claude_code_penguin_mode", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ enabled: true })
})

test("penguin mode honors the claude_code_penguin_mode flag when disabled", async () => {
  setFeatureFlag("claude_code_penguin_mode", false)

  try {
    const tokens = await authorizeAndExchange()
    const response = await server.request("/api/claude_code_penguin_mode", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      enabled: false,
      disabled_reason: "preference",
    })
  } finally {
    removeFeatureFlag("claude_code_penguin_mode")
  }
})

test("manual OAuth callback displays code with state for Claude Code paste", async () => {
  const response = await server.request(
    "/oauth/code/callback?code=copilot-api-auth-code&state=test-state",
  )

  expect(response.status).toBe(200)
  expect(await response.text()).toContain(
    "<pre>copilot-api-auth-code#test-state</pre>",
  )
})

test("manual OAuth callback escapes displayed code", async () => {
  const response = await server.request(
    "/oauth/code/callback?code=%3Ccode%3E&state=a%26b",
  )

  expect(response.status).toBe(200)
  expect(await response.text()).toContain("<pre>&lt;code&gt;#a&amp;b</pre>")
})

test("OAuth authorize page allows the exact local callback origin", async () => {
  const response = await server.request(
    `/oauth/authorize?${authorizationQuery("http://localhost:43123/callback").toString()}`,
  )

  expect(response.status).toBe(200)
  const csp = response.headers.get("content-security-policy")
  expect(csp).toContain("form-action 'self' http://localhost:43123;")
  expect(csp).not.toContain("localhost:*")
  expect(csp).not.toContain("http://localhost;")
})

test("OAuth authorize page allows the exact manual callback origin", async () => {
  const response = await server.request(
    `/oauth/authorize?${authorizationQuery().toString()}`,
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-security-policy")).toContain(
    "form-action 'self' https://platform.claude.com;",
  )
})

test("invalid OAuth API key response retains the callback origin", async () => {
  const response = await server.request(
    `/oauth/authorize?${authorizationQuery("http://localhost:43124/callback").toString()}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: "invalid-key" }).toString(),
    },
  )

  expect(response.status).toBe(401)
  expect(response.headers.get("content-security-policy")).toContain(
    "form-action 'self' http://localhost:43124;",
  )
})

test("OAuth gateway and scope failures share the IP tracker", async () => {
  const clientIp = "198.51.100.90"
  const peer = { "x-copilot-peer-ip": clientIp }
  const query = authorizationQuery()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await server.request(
      `/oauth/authorize?${query.toString()}`,
      {
        method: "POST",
        headers: {
          ...peer,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ api_key: "invalid-key" }).toString(),
      },
    )
    expect(response.status).toBe(401)
  }

  const wrongScope = await server.request("/api/oauth/profile", {
    headers: {
      ...peer,
      "x-api-key": "test-secret-key",
    },
  })
  expect(wrongScope.status).toBe(401)
  expect(isIpBlocked(clientIp)).toBe(true)

  const tokens = await authorizeAndExchange()
  const banned = await server.request("/api/oauth/profile", {
    headers: {
      ...peer,
      "x-api-key": tokens.access_token,
    },
  })
  expect(banned.status).toBe(401)
})

async function authorizeAndExchange(): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  token_type: string
}> {
  const query = authorizationQuery()
  const authorizeResponse = await server.request(
    `/oauth/authorize?${query.toString()}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: "test-secret-key" }).toString(),
    },
  )
  expect(authorizeResponse.status).toBe(302)
  const location = authorizeResponse.headers.get("location")
  expect(location).not.toBeNull()
  const code = new URL(location ?? oauthRedirectUri).searchParams.get("code")
  expect(code).toStartWith("cc_code_")

  const tokenResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri,
      client_id: oauthClientId,
      code_verifier: oauthVerifier,
      state: oauthState,
    }),
  })
  expect(tokenResponse.status).toBe(200)
  return (await tokenResponse.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    scope: string
    token_type: string
  }
}

test("rejects arbitrary refresh tokens without disclosing the gateway key", async () => {
  const response = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: "audit-invalid",
      client_id: oauthClientId,
    }),
  })

  expect(response.status).toBe(400)
  const text = await response.text()
  expect(text).toContain("invalid_grant")
  expect(text).not.toContain("test-secret-key")
})

test("rejects oversized or unsupported OAuth token requests before parsing", async () => {
  const oversizedResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: "x".repeat(20_000),
      client_id: oauthClientId,
    }),
  })
  expect(oversizedResponse.status).toBe(400)
  expect(await oversizedResponse.json()).toEqual({ error: "invalid_request" })
  expect(oversizedResponse.headers.get("cache-control")).toBe("no-store")

  const unsupportedResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "grant_type=refresh_token",
  })
  expect(unsupportedResponse.status).toBe(400)
  expect(await unsupportedResponse.json()).toEqual({ error: "invalid_request" })
})

test("rejects conflicting credential headers", async () => {
  const response = await server.request("/api/oauth/profile", {
    headers: {
      authorization: "Bearer test-secret-key",
      "x-api-key": "different-secret-key",
    },
  })
  expect(response.status).toBe(401)
})

test("binds one-use authorization codes to client, redirect, state, and S256 PKCE", async () => {
  const query = authorizationQuery()
  const authorizeResponse = await server.request(
    `/oauth/authorize?${query.toString()}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: "test-secret-key" }).toString(),
    },
  )
  const location = authorizeResponse.headers.get("location")
  const code = new URL(location ?? oauthRedirectUri).searchParams.get("code")

  const wrongVerifierResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri,
      client_id: oauthClientId,
      code_verifier: "x".repeat(64),
      state: oauthState,
    }),
  })
  expect(wrongVerifierResponse.status).toBe(400)

  const validRequest = {
    grant_type: "authorization_code",
    code,
    redirect_uri: oauthRedirectUri,
    client_id: oauthClientId,
    code_verifier: oauthVerifier,
    state: oauthState,
  }
  const validResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validRequest),
  })
  expect(validResponse.status).toBe(200)

  const replayResponse = await server.request("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validRequest),
  })
  expect(replayResponse.status).toBe(400)
  expect(await replayResponse.json()).toEqual({ error: "invalid_grant" })
})

test("issues scoped opaque tokens and a distinct inference-only API key", async () => {
  const tokens = await authorizeAndExchange()

  expect(tokens.access_token).toStartWith("cc_at_")
  expect(tokens.refresh_token).toStartWith("cc_rt_")
  expect(tokens.access_token).not.toBe("test-secret-key")
  expect(tokens.refresh_token).not.toBe("test-secret-key")
  expect(tokens.expires_in).toBe(3600)
  expect(tokens.token_type).toBe("bearer")

  const profileResponse = await server.request("/api/oauth/profile", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
  expect(profileResponse.status).toBe(200)

  const apiKeyResponse = await server.request(
    "/api/oauth/claude_cli/create_api_key",
    {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    },
  )
  expect(apiKeyResponse.status).toBe(200)
  const { raw_key: rawKey } = (await apiKeyResponse.json()) as {
    raw_key: string
  }
  expect(rawKey).toStartWith("sk-copilot-")
  expect(rawKey).not.toBe(tokens.access_token)
  expect(rawKey).not.toBe("test-secret-key")
  expect(await resolveCredential(rawKey, ["user:inference"])).not.toBeNull()
  expect(await resolveCredential(rawKey, ["user:profile"])).toBeNull()
  const inferenceProfileResponse = await server.request("/api/oauth/profile", {
    headers: { authorization: `Bearer ${rawKey}` },
  })
  expect(inferenceProfileResponse.status).toBe(401)
  const inferenceCreateKeyResponse = await server.request(
    "/api/oauth/claude_cli/create_api_key",
    {
      method: "POST",
      headers: { authorization: `Bearer ${rawKey}` },
    },
  )
  expect(inferenceCreateKeyResponse.status).toBe(401)
  const oauthAdminResponse = await server.request("/dashboard/api/overview", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
  expect(oauthAdminResponse.status).toBe(401)

  const persisted = await fs.readFile(oauthStorePath ?? "", "utf8")
  expect(persisted).not.toContain(tokens.access_token)
  expect(persisted).not.toContain(tokens.refresh_token)
  expect(persisted).not.toContain(rawKey)
  expect(persisted).not.toContain("test-secret-key")
})

test("gateway credentials cannot impersonate OAuth or mint inference keys", async () => {
  const profileResponse = await server.request("/api/oauth/profile", {
    headers: { authorization: "Bearer test-secret-key" },
  })
  expect(profileResponse.status).toBe(401)

  const createKeyResponse = await server.request(
    "/api/oauth/claude_cli/create_api_key",
    {
      method: "POST",
      headers: { authorization: "Bearer test-secret-key" },
    },
  )
  expect(createKeyResponse.status).toBe(401)
})

test("rotates refresh tokens and revokes the family when an old token is reused", async () => {
  const initial = await authorizeAndExchange()

  const rotatedResponse = await refreshOauthToken(initial.refresh_token)
  expect(rotatedResponse.status).toBe(200)
  const rotated = (await rotatedResponse.json()) as {
    access_token: string
    refresh_token: string
  }
  expect(rotated.refresh_token).not.toBe(initial.refresh_token)

  const replayResponse = await refreshOauthToken(initial.refresh_token)
  expect(replayResponse.status).toBe(400)
  expect(await replayResponse.json()).toEqual({ error: "invalid_grant" })

  expect((await refreshOauthToken(rotated.refresh_token)).status).toBe(400)
  expect(await resolveCredential(rotated.access_token)).toBeNull()
  expect(await resolveCredential(initial.access_token)).toBeNull()
})

function refreshOauthToken(refreshToken: string): Promise<Response> {
  return Promise.resolve(
    server.request("/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: oauthClientId,
        scope: "user:profile user:inference",
      }),
    }),
  )
}

test("revokes an OAuth token family", async () => {
  const tokens = await authorizeAndExchange()
  const revokeResponse = await server.request("/v1/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: tokens.access_token,
      client_id: oauthClientId,
    }).toString(),
  })
  expect(revokeResponse.status).toBe(200)
  expect(await resolveCredential(tokens.access_token)).toBeNull()
  expect(await resolveCredential(tokens.refresh_token)).toBeNull()
})
