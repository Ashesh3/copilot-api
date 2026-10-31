import { afterEach, beforeEach, expect, test } from "bun:test"

import { mergeConfigWithDefaults } from "../src/lib/config"
import { resolveCredential } from "../src/lib/credential-resolver"
import { resetIpSecurityForTest } from "../src/lib/ip-blocker"
import { state } from "../src/lib/state"
import { insertGatewayCredential } from "../src/lib/storage/credentials-repository"
import { server } from "../src/server"
import { createAuthStorageFixture } from "./helpers/auth-storage"

const origin = "https://desktop-gateway.test"
const gatewayKey = "desktop-gateway-test-key"
const originalApiKeyAuth = state.apiKeyAuth
const originalDebug = state.debug
const originalLog = console.log
const originalPublicBase = process.env.COPILOT_PUBLIC_BASE_URL
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>

interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_token_expires_in: number
  scope: string
  token_type: string
}

beforeEach(async () => {
  fixture = await createAuthStorageFixture()
  await mergeConfigWithDefaults()
  resetIpSecurityForTest()
  delete process.env.COPILOT_PUBLIC_BASE_URL
  state.apiKeyAuth = gatewayKey
  await fixture.storage.transaction((session) =>
    insertGatewayCredential(session, {
      id: "desktop-route-gateway",
      credential: gatewayKey,
      label: "Desktop route test",
      createdAt: 0,
    }),
  )
})

afterEach(async () => {
  console.log = originalLog
  state.debug = originalDebug
  resetIpSecurityForTest()
  state.apiKeyAuth = originalApiKeyAuth
  if (originalPublicBase === undefined)
    delete process.env.COPILOT_PUBLIC_BASE_URL
  else process.env.COPILOT_PUBLIC_BASE_URL = originalPublicBase
  await fixture.close()
})

function postForm(
  path: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return server.request(new URL(path, origin).href, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(body),
  })
}

async function issue(prefix = ""): Promise<DeviceAuthorization> {
  const response = await postForm(`${prefix}/gateway/oauth/device`, {})
  expect(response.status).toBe(200)
  return (await response.json()) as DeviceAuthorization
}

async function verificationPage(device: DeviceAuthorization) {
  const response = await server.request(device.verification_uri_complete)
  expect(response.status).toBe(200)
  const html = await response.text()
  const csrf = /name="csrf_token" value="([\w-]+)"/.exec(html)?.[1]
  expect(csrf).toBeDefined()
  const cookie = response.headers.get("set-cookie")?.split(";")[0]
  expect(cookie).toBeDefined()
  if (!csrf || !cookie)
    throw new Error("Verification page is missing CSRF state")
  return { response, html, csrf, cookie }
}

async function approve(device: DeviceAuthorization, key = gatewayKey) {
  const page = await verificationPage(device)
  return postForm(
    device.verification_uri,
    {
      user_code: device.user_code,
      api_key: key,
      csrf_token: page.csrf,
      action: "approve",
    },
    { origin, cookie: page.cookie },
  )
}

for (const prefix of ["", "/v1"]) {
  test(`Desktop discovery preserves the ${prefix || "root"} gateway base`, async () => {
    const response = await server.request(
      `${origin}${prefix}/.well-known/oauth-authorization-server`,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({
      issuer: `${origin}${prefix}`,
      device_authorization_endpoint: `${origin}${prefix}/gateway/oauth/device`,
      token_endpoint: `${origin}${prefix}/gateway/oauth/token`,
      revocation_endpoint: `${origin}${prefix}/gateway/oauth/revoke`,
      scopes_supported: ["user:inference"],
      token_endpoint_auth_methods_supported: ["none"],
    })
  })

  test(`Desktop empty-form device login, refresh and revoke work without a client ID at ${prefix || "root"}`, async () => {
    const device = await issue(prefix)
    expect(device.expires_in).toBe(300)
    expect(device.interval).toBe(5)
    expect(device.verification_uri).toBe(
      `${origin}${prefix}/gateway/oauth/verify`,
    )
    expect(
      new URL(device.verification_uri_complete).searchParams.get("user_code"),
    ).toBe(device.user_code)
    expect((await approve(device)).status).toBe(200)
    const exchange = await postForm(`${prefix}/gateway/oauth/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
    })
    expect(exchange.status).toBe(200)
    const tokens = (await exchange.json()) as TokenResponse
    expect(tokens.scope).toBe("user:inference")
    expect(tokens.expires_in).toBe(3600)
    expect(tokens.refresh_token_expires_in).toBe(30 * 24 * 60 * 60)
    expect(tokens.token_type).toBe("Bearer")
    expect(
      (await resolveCredential(tokens.access_token, ["user:inference"]))?.kind,
    ).toBe("inference-client")
    expect(
      await resolveCredential(tokens.access_token, ["user:profile"]),
    ).toBeNull()
    const refresh = await postForm(`${prefix}/gateway/oauth/token`, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    })
    expect(refresh.status).toBe(200)
    const refreshed = (await refresh.json()) as TokenResponse
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)
    const replay = await postForm(`${prefix}/gateway/oauth/token`, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    })
    expect(replay.status).toBe(400)
    expect(await replay.json()).toEqual({ error: "invalid_grant" })
    expect(await resolveCredential(refreshed.access_token)).toBeNull()
    expect(await resolveCredential(tokens.access_token)).toBeNull()
    const revoked = await postForm(`${prefix}/gateway/oauth/revoke`, {
      token: refreshed.refresh_token,
      token_type_hint: "refresh_token",
    })
    expect(revoked.status).toBe(200)
    expect(await resolveCredential(refreshed.access_token)).toBeNull()
    expect(await resolveCredential(tokens.access_token)).toBeNull()
  })
}

test("Desktop pending polling uses OAuth errors without granting access", async () => {
  const device = await issue()
  const body = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: device.device_code,
  }
  const pending = await postForm("/gateway/oauth/token", body)
  expect(pending.status).toBe(400)
  expect(await pending.json()).toEqual({ error: "authorization_pending" })
  const fast = await postForm("/gateway/oauth/token", body)
  expect(fast.status).toBe(400)
  expect(await fast.json()).toEqual({ error: "slow_down" })
})

test("Desktop verification requires a valid key, CSRF token and same origin", async () => {
  const device = await issue()
  const page = await verificationPage(device)
  expect(page.response.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  )
  expect(page.response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(page.html).toContain('<meta name="referrer" content="strict-origin">')
  expect(page.response.headers.get("set-cookie")).toContain("HttpOnly")
  expect(page.html).not.toContain(gatewayKey)
  const body = {
    user_code: device.user_code,
    api_key: gatewayKey,
    csrf_token: page.csrf,
    action: "approve",
  }
  expect(
    (await postForm(device.verification_uri, body, { origin })).status,
  ).toBe(403)
  expect(
    (
      await postForm(device.verification_uri, body, {
        origin: "https://other.test",
        cookie: page.cookie,
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await postForm(
        device.verification_uri,
        { ...body, csrf_token: "wrong" },
        { origin, cookie: page.cookie },
      )
    ).status,
  ).toBe(403)
  const wrongKey = await postForm(
    device.verification_uri,
    { ...body, api_key: "wrong" },
    { origin, cookie: page.cookie },
  )
  expect(wrongKey.status).toBe(401)
  expect(await wrongKey.text()).not.toContain("wrong")
  expect(
    (
      await postForm(device.verification_uri, body, {
        origin,
        cookie: page.cookie,
      })
    ).status,
  ).toBe(200)
})

test("Desktop device authorization cannot cross gateway base prefixes", async () => {
  const device = await issue("/v1")
  expect((await approve(device)).status).toBe(200)
  const exchange = await postForm("/gateway/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: device.device_code,
  })
  expect(exchange.status).toBe(400)
  expect(await exchange.json()).toEqual({ error: "invalid_grant" })
})

test("Desktop endpoints reject unsupported grants and malformed forms", async () => {
  const duplicate = await server.request(`${origin}/gateway/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token&grant_type=authorization_code",
  })
  expect(duplicate.status).toBe(400)
  const extended = await postForm("/gateway/oauth/device", {
    extra: "a".repeat(20_000),
  })
  expect(extended.status).toBe(200)
  const unsupported = await postForm("/gateway/oauth/token", {
    grant_type: "password",
  })
  expect(unsupported.status).toBe(400)
  expect(await unsupported.json()).toEqual({ error: "unsupported_grant_type" })
  const json = await server.request(`${origin}/gateway/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  expect(json.status).toBe(400)
})

test("Desktop verification rejects malformed cookie and key bytes without server errors", async () => {
  const device = await issue()
  const page = await verificationPage(device)
  const body = {
    user_code: device.user_code,
    api_key: gatewayKey,
    csrf_token: page.csrf,
    action: "approve",
  }
  const unicodeCookie = await postForm(device.verification_uri, body, {
    origin,
    cookie: `claude_gateway_csrf=${encodeURIComponent("é".repeat(43))}`,
  })
  expect(unicodeCookie.status).toBe(403)
  const unsafeKey = await postForm(
    device.verification_uri,
    {
      ...body,
      api_key: "bad\r\nAuthorization: Bearer injected",
    },
    { origin, cookie: page.cookie },
  )
  expect(unsafeKey.status).toBe(400)
})

test("Desktop metadata preserves an operator's reverse-proxy prefix", async () => {
  process.env.COPILOT_PUBLIC_BASE_URL = "https://public-gateway.test/edge"
  const response = await server.request(
    `${origin}/v1/.well-known/oauth-authorization-server`,
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    issuer: "https://public-gateway.test/edge/v1",
    device_authorization_endpoint:
      "https://public-gateway.test/edge/v1/gateway/oauth/device",
  })
})

test("Desktop verification denial leaves no inference grant", async () => {
  const device = await issue()
  const page = await verificationPage(device)
  const denial = await postForm(
    device.verification_uri,
    {
      user_code: device.user_code,
      api_key: gatewayKey,
      csrf_token: page.csrf,
      action: "deny",
    },
    { origin, cookie: page.cookie },
  )
  expect(denial.status).toBe(200)
  const exchange = await postForm("/gateway/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: device.device_code,
  })
  expect(exchange.status).toBe(400)
  expect(await exchange.json()).toEqual({ error: "access_denied" })
})

test("Desktop consumed-token revocation preserves an explicitly registered client binding", async () => {
  const started = await postForm("/gateway/oauth/device", {
    client_id: "registered-desktop",
  })
  expect(started.status).toBe(200)
  const device = (await started.json()) as DeviceAuthorization
  expect((await approve(device)).status).toBe(200)
  const exchanged = await postForm("/gateway/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: device.device_code,
    client_id: "registered-desktop",
  })
  expect(exchanged.status).toBe(200)
  const original = (await exchanged.json()) as TokenResponse
  const refreshed = await postForm("/gateway/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: original.refresh_token,
    client_id: "registered-desktop",
  })
  expect(refreshed.status).toBe(200)
  const current = (await refreshed.json()) as TokenResponse
  expect(
    (
      await postForm("/gateway/oauth/revoke", {
        token: original.refresh_token,
        client_id: "different-client",
      })
    ).status,
  ).toBe(200)
  expect(await resolveCredential(current.access_token)).not.toBeNull()
  expect(
    (
      await postForm("/gateway/oauth/revoke", {
        token: original.refresh_token,
        client_id: "registered-desktop",
      })
    ).status,
  ).toBe(200)
  expect(await resolveCredential(current.access_token)).toBeNull()
})

test("Desktop debug diagnostics do not clone credential forms or expose socket tickets", async () => {
  const output: Array<string> = []
  state.debug = true
  console.log = (...values: Array<unknown>) => {
    output.push(values.map(String).join(" "))
  }
  let clones = 0
  const request = new Request(`${origin}/gateway/oauth/device`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-websocket-protocol":
        "claude.dictation.v1, ticket.private-dictation-ticket",
    },
    body: "",
  })
  Object.defineProperty(request, "clone", {
    value() {
      clones++
      throw new Error("Credential forms must not be cloned for diagnostics")
    },
  })
  expect((await server.fetch(request)).status).toBe(200)
  expect(clones).toBe(0)
  expect(output.join("\n")).not.toContain("private-dictation-ticket")
})
