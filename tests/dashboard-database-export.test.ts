import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  issueAdminSetupCode,
  setupAdminAuth,
} from "~/lib/admin-auth"
import { forwardError } from "~/lib/error"
import { OAuthStore } from "~/lib/oauth-store"
import { dashboardRoutes } from "~/routes/dashboard/route"

import { createAuthStorageFixture } from "./helpers/auth-storage"

const origin = "https://gateway.example.com"
const adminPassword = "fixture-database-export-password"
const originalOrigin = process.env.COPILOT_ADMIN_ORIGIN
let fixture: Awaited<ReturnType<typeof createAuthStorageFixture>>
let app: Hono
let cookie: string
let csrf: string

beforeEach(async () => {
  process.env.COPILOT_ADMIN_ORIGIN = origin
  fixture = await createAuthStorageFixture()
  const setup = await setupAdminAuth(
    "fixture-export-gateway",
    adminPassword,
    (await issueAdminSetupCode()).code,
  )
  if (!("session" in setup)) throw new Error(setup.error)
  csrf = setup.session.csrfToken
  cookie = `${ADMIN_SESSION_COOKIE}=${setup.session.token}; ${ADMIN_CSRF_COOKIE}=${csrf}`
  app = new Hono()
    .onError((error, c) => forwardError(c, error))
    .route("/dashboard", dashboardRoutes)
})

afterEach(async () => {
  await fixture.close()
  if (originalOrigin === undefined) delete process.env.COPILOT_ADMIN_ORIGIN
  else process.env.COPILOT_ADMIN_ORIGIN = originalOrigin
})

function exportDatabase(
  options: {
    headers?: Record<string, string>
    body?: string
  } = {},
) {
  return app.request(`${origin}/dashboard/api/database/export`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "x-copilot-csrf": csrf,
      "content-type": "application/json",
      ...options.headers,
    },
    body: options.body ?? JSON.stringify({ currentPassword: adminPassword }),
  })
}

test("administrator database export returns a SQLite attachment with no-store", async () => {
  const response = await exportDatabase()
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("content-disposition")).toMatch(
    /^attachment; filename="copilot-api-.*\.sqlite"$/,
  )
  const bytes = await response.arrayBuffer()
  expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe("SQLite format 3\0")
})

test("database export requires an administrator session and matching same-origin CSRF", async () => {
  const invalidHeaders: Array<Record<string, string>> = [
    { cookie: "" },
    { "x-copilot-csrf": "" },
    { "x-copilot-csrf": "wrong" },
    { origin: "" },
    { origin: "https://untrusted.example" },
    { cookie: `${ADMIN_SESSION_COOKIE}=invalid; ${ADMIN_CSRF_COOKIE}=${csrf}` },
  ]
  for (const headers of invalidHeaders) {
    const response = await exportDatabase({ headers })
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-disposition")).toBeNull()
  }
})

test("gateway and inference credentials cannot download the database", async () => {
  const inference = await new OAuthStore({
    storage: fixture.storage,
  }).mintInferenceCredential()
  for (const credential of ["fixture-export-gateway", inference]) {
    const response = await exportDatabase({
      headers: { cookie: "", authorization: `Bearer ${credential}` },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("content-disposition")).toBeNull()
  }
})

test("database export verifies the current administrator password", async () => {
  const response = await exportDatabase({
    body: JSON.stringify({ currentPassword: "wrong-password" }),
  })
  expect(response.status).toBe(401)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("content-disposition")).toBeNull()
  expect(await response.json()).toEqual({ error: "Authentication failed" })
})

test("database export rejects missing, empty and malformed password input", async () => {
  for (const body of [
    "{",
    "null",
    "[]",
    "{}",
    '{"currentPassword":null}',
    '{"currentPassword":42}',
    '{"currentPassword":""}',
  ]) {
    const response = await exportDatabase({ body })
    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-disposition")).toBeNull()
  }
})

test("retired configuration ZIP and encrypted dashboard backup routes are unavailable", async () => {
  for (const [path, method] of [
    ["/api/settings/export", "GET"],
    ["/api/settings/backup", "POST"],
    ["/api/database/export", "GET"],
  ]) {
    const response = await app.request(`${origin}/dashboard${path}`, {
      method,
      headers: { cookie, origin, "x-copilot-csrf": csrf },
    })
    expect(response.status).toBe(404)
    await response.body?.cancel()
  }
})
