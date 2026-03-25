import type { Context, Next } from "hono"

import * as Sentry from "@sentry/bun"
import consola from "consola"

import { extractClientIp, isIpBlocked, recordFailedAttempt } from "./ip-blocker"
import { extractRequestApiKey } from "./request-auth"
import { state } from "./state"

/**
 * Paths that proxy to Copilot and should count toward IP banning on auth failure.
 * Failed auth on other endpoints (models, usage, etc.) is still silently dropped
 * but does NOT record a strike against the IP.
 */
const IP_BAN_PATHS = new Set([
  "/chat/completions",
  "/v1/chat/completions",
  "/messages",
  "/v1/messages",
  "/responses",
  "/v1/responses",
])

/**
 * API key guard middleware that silently drops connections when the API key
 * doesn't match the expected value. Unauthorized requests get NO response.
 *
 * Only active when state.apiKeyAuth is set (via --api-key-auth CLI flag).
 */
export async function apiKeyGuard(c: Context, next: Next): Promise<void> {
  if (!state.apiKeyAuth) {
    await next()
    return
  }

  const clientIp = extractClientIp(c)

  if (clientIp !== null && isIpBlocked(clientIp)) {
    consola.warn(
      `[api-key-guard] Blocked request from banned IP ${clientIp} → ${c.req.method} ${c.req.path}`,
    )
    Sentry.captureMessage(`Blocked banned IP: ${clientIp}`, {
      level: "warning",
      extra: { ip: clientIp, method: c.req.method, path: c.req.path },
    })
    // Silent drop: never resolves, client gets no response
    await new Promise(() => {})
    return
  }

  const requestApiKey = extractRequestApiKey(c)

  if (requestApiKey === state.apiKeyAuth) {
    await next()
    return
  }

  // Only count failed attempts on copilot-proxying endpoints
  if (clientIp !== null && IP_BAN_PATHS.has(c.req.path)) {
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

  // Silent drop: never resolves, client gets no response
  await new Promise(() => {})
}
