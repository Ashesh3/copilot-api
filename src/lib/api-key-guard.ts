import type { Context, Next } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"

import { resolveRequestCredential } from "./credential-resolver"
import {
  extractClientIp,
  isIpBlocked,
  isIpAllowedForWhitelistedRoute,
  recordFailedAttempt,
} from "./ip-blocker"
import { state } from "./state"
import { isAllowedTransparentProxyRequest } from "./transparent-proxy"

/**
 * API key guard middleware. Invalid credentials receive a small, bounded and
 * uniform authentication response.
 *
 * Only active when state.apiKeyAuth is set (via --api-key-auth CLI flag).
 */
export async function apiKeyGuard(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  if (!state.apiKeyAuth) {
    await next()
    return
  }

  const clientIp = extractClientIp(c)

  if (
    clientIp !== null
    && (await isIpAllowedForWhitelistedRoute(clientIp))
    && isAllowedTransparentProxyRequest(c)
  ) {
    await next()
    return
  }

  if (clientIp !== null && isIpBlocked(clientIp)) {
    consola.warn(
      `[api-key-guard] Blocked request from banned IP ${clientIp} → ${c.req.method} ${c.req.path}`,
    )
    Sentry.captureMessage(`Blocked banned IP: ${clientIp}`, {
      level: "warning",
      extra: { ip: clientIp, method: c.req.method, path: c.req.path },
    })
    return unauthorizedResponse(c)
  }

  const credential = await resolveRequestCredential(c.req.raw, [
    "user:inference",
  ])
  if (credential) {
    await next()
    return
  }

  if (clientIp !== null) {
    const attempts = recordFailedAttempt(clientIp)
    consola.warn(
      `[api-key-guard] Failed auth from ${clientIp} → ${c.req.method} ${c.req.path} (attempt ${attempts}/3)`,
    )
    if (attempts >= 3) {
      consola.error(
        `[api-key-guard] IP ${clientIp} banned after ${attempts} failed attempts`,
      )
      Sentry.captureMessage(`IP banned: ${clientIp}`, {
        level: "error",
        extra: { ip: clientIp, attempts, path: c.req.path },
      })
    }
  }

  return unauthorizedResponse(c)
}

function unauthorizedResponse(c: Context): Response {
  c.header("Cache-Control", "no-store")
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
}
