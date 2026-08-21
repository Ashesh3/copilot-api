import type { Context, Next } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"

import { resolveRequestCredential } from "./credential-resolver"
import {
  extractClientIp,
  isIpAllowedForTransparentProxy,
  isIpBanned,
  isIpBlocked,
  recordFailedAttempt,
  trustAuthenticatedIp,
} from "./ip-blocker"
import { sanitizeRequestDiagnosticReference } from "./request-diagnostics"
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
  const diagnosticPath = sanitizeRequestDiagnosticReference(
    c.req.method,
    c.req.path,
  )
  const credentialSupplied = [
    "authorization",
    "x-api-key",
    "x-goog-api-key",
  ].some((header) => c.req.raw.headers.has(header))

  if (credentialSupplied) {
    const credential = await resolveRequestCredential(c.req.raw, [
      "user:inference",
    ])
    if (credential) {
      if (clientIp !== null) await trustAuthenticatedIp(clientIp)
      await next()
      return
    }

    if (clientIp !== null) {
      const alreadyBanned = isIpBanned(clientIp)
      const attempts = recordFailedAttempt(clientIp)
      consola.warn(
        `[api-key-guard] Failed auth from ${clientIp} → ${c.req.method} ${diagnosticPath} (attempt ${attempts}/3)`,
      )
      if (attempts >= 3 && !alreadyBanned) {
        consola.error(
          `[api-key-guard] IP ${clientIp} banned after ${attempts} failed attempts`,
        )
        Sentry.captureMessage(`IP banned: ${clientIp}`, {
          level: "error",
          extra: { ip: clientIp, attempts, path: diagnosticPath },
        })
      }
    }
    return unauthorizedResponse(c)
  }

  if (
    clientIp !== null
    && (await isIpAllowedForTransparentProxy(clientIp))
    && isAllowedTransparentProxyRequest(c)
  ) {
    await next()
    return
  }

  if (clientIp !== null && isIpBlocked(clientIp)) {
    consola.warn(
      `[api-key-guard] Blocked request from banned IP ${clientIp} → ${c.req.method} ${diagnosticPath}`,
    )
    Sentry.captureMessage(`Blocked banned IP: ${clientIp}`, {
      level: "warning",
      extra: { ip: clientIp, method: c.req.method, path: diagnosticPath },
    })
    return unauthorizedResponse(c)
  }

  if (clientIp !== null) {
    const attempts = recordFailedAttempt(clientIp)
    consola.warn(
      `[api-key-guard] Failed auth from ${clientIp} → ${c.req.method} ${diagnosticPath} (attempt ${attempts}/3)`,
    )
    if (attempts >= 3) {
      consola.error(
        `[api-key-guard] IP ${clientIp} banned after ${attempts} failed attempts`,
      )
      Sentry.captureMessage(`IP banned: ${clientIp}`, {
        level: "error",
        extra: { ip: clientIp, attempts, path: diagnosticPath },
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
