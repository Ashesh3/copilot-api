import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_REAUTH_MS,
  ADMIN_SESSION_ABSOLUTE_MS,
  ADMIN_SESSION_IDLE_MS,
  ADMIN_SESSION_COOKIE,
  setAdminAuthTestMode,
  isAdminLoginRateLimited,
  setAdminAuthClockForTest,
} from "../src/lib/admin-auth"
import { state } from "../src/lib/state"
import { server } from "../src/server"

const GATEWAY_KEY = "test-gateway-key-that-is-long-and-random"
const ADMIN_PASSWORD = "correct horse battery staple"
const ORIGIN = "https://ai.ashesh.dev"

interface AdminCookies {
  cookie: string
  csrf: string
}

function readSetCookies(response: Response): Array<string> {
  return response.headers.getSetCookie()
}

function cookiesFrom(response: Response): AdminCookies {
  const values = readSetCookies(response)
  const session = values
    .find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE}=`))
    ?.split(";", 1)[0]
  const csrfCookie = values
    .find((value) => value.startsWith(`${ADMIN_CSRF_COOKIE}=`))
    ?.split(";", 1)[0]
  expect(session).toBeTruthy()
  expect(csrfCookie).toBeTruthy()
  const csrf = csrfCookie?.slice(`${ADMIN_CSRF_COOKIE}=`.length) ?? ""
  return { cookie: `${session}; ${csrfCookie}`, csrf }
}

async function setup(): Promise<AdminCookies> {
  const response = await server.request("/dashboard/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ gatewayKey: GATEWAY_KEY, password: ADMIN_PASSWORD }),
  })
  expect(response.status).toBe(201)
  return cookiesFrom(response)
}

beforeEach(() => {
  setAdminAuthTestMode(true)
  state.apiKeyAuth = GATEWAY_KEY
  process.env.COPILOT_ADMIN_ORIGIN = ORIGIN
})

afterEach(() => {
  setAdminAuthTestMode(false)
  state.apiKeyAuth = undefined
  delete process.env.COPILOT_ADMIN_ORIGIN
  setAdminAuthClockForTest()
})

test("first admin setup requires gateway key and a strong password", async () => {
  const wrongKey = await server.request("/dashboard/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ gatewayKey: "wrong", password: ADMIN_PASSWORD }),
  })
  expect(wrongKey.status).toBe(401)

  const weakPassword = await server.request("/dashboard/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ gatewayKey: GATEWAY_KEY, password: "too-short" }),
  })
  expect(weakPassword.status).toBe(401)

  const cookies = await setup()
  const setCookies = readSetCookies(
    await server.request("/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        gatewayKey: GATEWAY_KEY,
        password: ADMIN_PASSWORD,
      }),
    }),
  )
  expect(
    setCookies.some((cookie) =>
      /^__Host-copilot_admin=.*; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/.test(
        cookie,
      ),
    ),
  ).toBe(true)
  expect(
    setCookies.some((cookie) =>
      /^__Host-copilot_admin_csrf=.*; Max-Age=2592000; Path=\/; Secure; SameSite=Strict$/.test(
        cookie,
      ),
    ),
  ).toBe(true)
  expect(cookies.cookie).toContain(ADMIN_SESSION_COOKIE)
})

test("administrator auth mutations require the configured browser Origin", async () => {
  const missingOrigin = await server.request("/dashboard/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      gatewayKey: GATEWAY_KEY,
      password: ADMIN_PASSWORD,
    }),
  })
  expect(missingOrigin.status).toBe(401)

  const wrongOrigin = await server.request("/dashboard/auth/setup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.invalid",
    },
    body: JSON.stringify({
      gatewayKey: GATEWAY_KEY,
      password: ADMIN_PASSWORD,
    }),
  })
  expect(wrongOrigin.status).toBe(401)
  expect((await server.request("/dashboard/auth/status")).status).toBe(200)
})

test("concurrent first-time setup creates only one administrator", async () => {
  const requests = await Promise.all(
    [ADMIN_PASSWORD, "another secure administrator password"].map((password) =>
      Promise.resolve(
        server.request("/dashboard/auth/setup", {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ gatewayKey: GATEWAY_KEY, password }),
        }),
      ),
    ),
  )
  expect(requests.map((response) => response.status).sort()).toEqual([201, 409])
})

test("gateway key alone cannot access administrator APIs", async () => {
  await setup()
  const response = await server.request("/dashboard/api/overview", {
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
  })
  expect(response.status).toBe(401)
})

test("remote and code launcher pages require the administrator cookie", async () => {
  const cookies = await setup()

  for (const path of ["/remote", "/code", "/code/session_example"]) {
    const unauthenticated = await server.request(path)
    expect(unauthenticated.status).toBe(302)
    expect(unauthenticated.headers.get("location")).toBe("/dashboard")
  }

  const code = await server.request("/code", {
    headers: { cookie: cookies.cookie },
  })
  expect(code.status).toBe(302)
  expect(code.headers.get("location")).toBe("/dashboard#environments")

  const sessionLink = await server.request("/code/session_abc123", {
    headers: { cookie: cookies.cookie },
  })
  expect(sessionLink.status).toBe(302)
  expect(sessionLink.headers.get("location")).toBe("/remote?session=cse_abc123")
})

test("repeated failed admin logins are bounded by a per-peer lockout", async () => {
  await setup()
  const headers = {
    "content-type": "application/json",
    origin: ORIGIN,
    "x-copilot-peer-ip": "198.51.100.77",
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await server.request("/dashboard/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ gatewayKey: GATEWAY_KEY, password: "wrong" }),
    })
    expect(response.status).toBe(401)
  }
  expect(
    isAdminLoginRateLimited(new Request("https://example.test", { headers })),
  ).toBe(true)
  const correctButLocked = await server.request("/dashboard/auth/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ gatewayKey: GATEWAY_KEY, password: ADMIN_PASSWORD }),
  })
  expect(correctButLocked.status).toBe(401)
})

test("admin session accesses reads and mutations require CSRF and Origin", async () => {
  const cookies = await setup()
  const overview = await server.request("/dashboard/api/overview", {
    headers: { cookie: cookies.cookie },
  })
  expect(overview.status).toBe(200)

  const missingCsrf = await server.request(
    "/dashboard/api/settings/codex-cleanup-model",
    {
      method: "POST",
      headers: { cookie: cookies.cookie, "content-type": "application/json" },
      body: JSON.stringify({ model: null }),
    },
  )
  expect(missingCsrf.status).toBe(401)

  const mutation = await server.request(
    "/dashboard/api/settings/codex-cleanup-model",
    {
      method: "POST",
      headers: {
        cookie: cookies.cookie,
        "content-type": "application/json",
        origin: ORIGIN,
        "x-copilot-csrf": cookies.csrf,
      },
      body: JSON.stringify({ model: null }),
    },
  )
  expect(mutation.status).toBe(200)
})

test("privileged routes require recent password reauthentication", async () => {
  const cookies = await setup()
  const denied = await server.request("/dashboard/api/settings/export", {
    headers: { cookie: cookies.cookie },
  })
  expect(denied.status).toBe(403)

  const reauth = await server.request("/dashboard/auth/reauth", {
    method: "POST",
    headers: {
      cookie: cookies.cookie,
      "content-type": "application/json",
      origin: ORIGIN,
      "x-copilot-csrf": cookies.csrf,
    },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })
  expect(reauth.status).toBe(200)

  const allowed = await server.request("/dashboard/api/settings/export", {
    headers: { cookie: cookies.cookie },
  })
  expect(allowed.status).toBe(200)
})

test("admin password change revokes prior sessions", async () => {
  const cookies = await setup()
  const changed = await server.request("/dashboard/auth/password", {
    method: "PUT",
    headers: {
      cookie: cookies.cookie,
      "content-type": "application/json",
      origin: ORIGIN,
      "x-copilot-csrf": cookies.csrf,
    },
    body: JSON.stringify({
      currentPassword: ADMIN_PASSWORD,
      newPassword: "a new administrator password with length",
    }),
  })
  expect(changed.status).toBe(200)

  const oldSession = await server.request("/dashboard/api/overview", {
    headers: { cookie: cookies.cookie },
  })
  expect(oldSession.status).toBe(401)
})

test("logout revokes the current server-side session and expires cookies", async () => {
  const cookies = await setup()
  const logout = await server.request("/dashboard/auth/logout", {
    method: "POST",
    headers: {
      cookie: cookies.cookie,
      origin: ORIGIN,
      "x-copilot-csrf": cookies.csrf,
    },
  })
  expect(logout.status).toBe(200)
  expect(logout.headers.getSetCookie().join(";")).toContain("Max-Age=0")

  const afterLogout = await server.request("/dashboard/api/overview", {
    headers: { cookie: cookies.cookie },
  })
  expect(afterLogout.status).toBe(401)
})

test("administrator sessions enforce idle and absolute expiry", async () => {
  let currentTime = Date.UTC(2026, 6, 12)
  setAdminAuthClockForTest({ now: () => currentTime })
  const idleCookies = await setup()

  currentTime += ADMIN_SESSION_IDLE_MS + 1
  const idleExpired = await server.request("/dashboard/api/overview", {
    headers: { cookie: idleCookies.cookie },
  })
  expect(idleExpired.status).toBe(401)

  setAdminAuthTestMode(true)
  state.apiKeyAuth = GATEWAY_KEY
  // eslint-disable-next-line require-atomic-updates
  currentTime = Date.UTC(2026, 6, 12)
  setAdminAuthClockForTest({ now: () => currentTime })
  const absoluteCookies = await setup()
  for (
    let elapsed = ADMIN_SESSION_IDLE_MS / 2;
    elapsed < ADMIN_SESSION_ABSOLUTE_MS;
    elapsed += ADMIN_SESSION_IDLE_MS / 2
  ) {
    // eslint-disable-next-line require-atomic-updates
    currentTime = Date.UTC(2026, 6, 12) + elapsed
    const active = await server.request("/dashboard/api/overview", {
      headers: { cookie: absoluteCookies.cookie },
    })
    expect(active.status).toBe(200)
  }
  // eslint-disable-next-line require-atomic-updates
  currentTime = Date.UTC(2026, 6, 12) + ADMIN_SESSION_ABSOLUTE_MS + 1
  const absoluteExpired = await server.request("/dashboard/api/overview", {
    headers: { cookie: absoluteCookies.cookie },
  })
  expect(absoluteExpired.status).toBe(401)
})

test("privileged reauthentication expires after five minutes", async () => {
  let currentTime = Date.UTC(2026, 6, 12)
  setAdminAuthClockForTest({ now: () => currentTime })
  const cookies = await setup()
  const reauth = await server.request("/dashboard/auth/reauth", {
    method: "POST",
    headers: {
      cookie: cookies.cookie,
      "content-type": "application/json",
      origin: ORIGIN,
      "x-copilot-csrf": cookies.csrf,
    },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })
  expect(reauth.status).toBe(200)

  currentTime += ADMIN_REAUTH_MS + 1
  const denied = await server.request("/dashboard/api/settings/export", {
    headers: { cookie: cookies.cookie },
  })
  expect(denied.status).toBe(403)
})

test("dashboard responses carry hardening headers and no wildcard CORS", async () => {
  const response = await server.request("/dashboard")
  expect(response.headers.get("content-security-policy")).toContain("nonce-")
  expect(response.headers.get("x-frame-options")).toBe("DENY")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
})
