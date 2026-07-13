import { Hono } from "hono"
import { deleteCookie, setCookie } from "hono/cookie"

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_ABSOLUTE_MS,
  ADMIN_SESSION_COOKIE,
  authenticateAdminRequest,
  changeAdminPassword,
  getAdminAuthStatus,
  isAllowedAdminOrigin,
  loginAdmin,
  logoutAdmin,
  setupAdminAuth,
  type CreatedAdminSession,
} from "~/lib/admin-auth"
import {
  extractClientIp,
  isIpBlocked,
  recordFailedAttempt,
} from "~/lib/ip-blocker"

export const dashboardAuthRoutes = new Hono()

dashboardAuthRoutes.use("*", async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    await next()
    return
  }
  if (!isAllowedAdminOrigin(c.req.header("origin") ?? null)) {
    noStore(c)
    return c.json({ error: "Authentication failed" }, 401)
  }
  await next()
})

function noStore(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "no-store")
}

function setSessionCookies(
  c: Parameters<typeof setCookie>[0],
  session: CreatedAdminSession,
): void {
  const maxAge = Math.floor(ADMIN_SESSION_ABSOLUTE_MS / 1000)
  setCookie(c, ADMIN_SESSION_COOKIE, session.token, {
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge,
  })
  setCookie(c, ADMIN_CSRF_COOKIE, session.csrfToken, {
    secure: true,
    httpOnly: false,
    sameSite: "Strict",
    path: "/",
    maxAge,
  })
}

function clearSessionCookies(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, ADMIN_SESSION_COOKIE, {
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  })
  deleteCookie(c, ADMIN_CSRF_COOKIE, {
    secure: true,
    httpOnly: false,
    sameSite: "Strict",
    path: "/",
  })
}

function authenticationFailed(c: {
  json(value: unknown, status: 401 | 403): Response
}): Response {
  return c.json({ error: "Authentication failed" }, 401)
}

dashboardAuthRoutes.get("/status", async (c) => {
  noStore(c)
  return c.json(await getAdminAuthStatus())
})

dashboardAuthRoutes.get("/session", async (c) => {
  noStore(c)
  const session = await authenticateAdminRequest(c.req.raw)
  if (!session) return authenticationFailed(c)
  return c.json({
    authenticated: true,
    expiresAt: session.expiresAt,
  })
})

dashboardAuthRoutes.post("/setup", async (c) => {
  noStore(c)
  const clientIp = extractClientIp(c)
  if (clientIp !== null && isIpBlocked(clientIp)) {
    return authenticationFailed(c)
  }
  const body = await c.req
    .json<{ gatewayKey?: unknown; password?: unknown }>()
    .catch(() => null)
  if (
    !body
    || typeof body.gatewayKey !== "string"
    || typeof body.password !== "string"
  ) {
    return c.json({ error: "Invalid request" }, 400)
  }
  const result = await setupAdminAuth(body.gatewayKey, body.password)
  if ("error" in result) {
    if (result.error === "Authentication failed" && clientIp !== null) {
      recordFailedAttempt(clientIp)
    }
    const status = result.error.includes("already configured") ? 409 : 401
    return c.json({ error: result.error }, status)
  }
  setSessionCookies(c, result.session)
  return c.json({ authenticated: true }, 201)
})

dashboardAuthRoutes.post("/login", async (c) => {
  noStore(c)
  const clientIp = extractClientIp(c)
  if (clientIp !== null && isIpBlocked(clientIp)) {
    return authenticationFailed(c)
  }
  const body = await c.req
    .json<{ gatewayKey?: unknown; password?: unknown }>()
    .catch(() => null)
  if (
    !body
    || typeof body.gatewayKey !== "string"
    || typeof body.password !== "string"
  ) {
    return authenticationFailed(c)
  }
  const session = await loginAdmin(body.gatewayKey, body.password)
  if (!session) {
    if (clientIp !== null) recordFailedAttempt(clientIp)
    return authenticationFailed(c)
  }
  setSessionCookies(c, session)
  return c.json({ authenticated: true })
})

dashboardAuthRoutes.post("/logout", async (c) => {
  noStore(c)
  const session = await authenticateAdminRequest(c.req.raw, {
    requireCsrf: true,
  })
  if (!session) return authenticationFailed(c)
  await logoutAdmin(c.req.raw)
  clearSessionCookies(c)
  return c.json({ authenticated: false })
})

dashboardAuthRoutes.put("/password", async (c) => {
  noStore(c)
  const body = await c.req
    .json<{ currentPassword?: unknown; newPassword?: unknown }>()
    .catch(() => null)
  if (
    !body
    || typeof body.currentPassword !== "string"
    || typeof body.newPassword !== "string"
  ) {
    return c.json({ error: "Invalid request" }, 400)
  }
  const result = await changeAdminPassword(
    c.req.raw,
    body.currentPassword,
    body.newPassword,
  )
  if ("error" in result) {
    return c.json({ error: result.error }, 401)
  }
  setSessionCookies(c, result)
  return c.json({ authenticated: true })
})
