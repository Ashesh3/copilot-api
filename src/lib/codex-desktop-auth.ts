import type { Context } from "hono"

import consola from "consola"

import { resolveRequestCredential } from "./credential-resolver"
import {
  extractClientIp,
  isIpAllowedForTransparentProxy,
  isIpAllowedForTranscription,
  isIpBanned,
  recordFailedAttempt,
  trustAuthenticatedIp,
} from "./ip-blocker"

export interface CodexDesktopAuthResult {
  allowed: boolean
  banned: boolean
  clientIp: string | null
}

/**
 * Credential-aware auth for Codex Desktop endpoints that do not go through the
 * standard `apiKeyGuard` middleware (currently `/codex/responses`).
 *
 * Two paths are accepted:
 *
 *   1. **API key auth.** When `CODEX_API_BASE_URL` is spoofed to an
 *      `*.openai.com` host (e.g. `https://voice.openai.com`), Codex Desktop's
 *      main process passes `isDesktopAuthAllowedUrl()` and attaches
 *      `Authorization: Bearer <token>` automatically. We accept the request
 *      if that bearer (or `x-api-key` / `x-goog-api-key`) matches an active
 *      gateway key. Successful authentication creates the standard
 *      data-plane IP trust and `/transcribe` persistence entry.
 *
 *   2. **IP whitelist fallback.** Preserves the original behavior for callers
 *      that hit these endpoints without an API key — e.g. a machine where
 *      an IP explicitly added from the dashboard. Automatic authenticated
 *      entries are deliberately excluded from this inference fallback.
 *
 * Returns `{ allowed: false }` with a `consola.warn` log when neither path
 * succeeds. Active bans are identified separately for logging and policy.
 */
export async function authorizeCodexDesktopRequest(
  c: Context,
  routeName: string,
): Promise<CodexDesktopAuthResult> {
  const clientIp = extractClientIp(c)
  const credentialSupplied = [
    "authorization",
    "x-api-key",
    "x-goog-api-key",
  ].some((header) => c.req.raw.headers.has(header))

  if (credentialSupplied) {
    if (await resolveRequestCredential(c.req.raw, ["user:inference"])) {
      if (clientIp !== null) await trustAuthenticatedIp(clientIp)
      return { allowed: true, banned: false, clientIp }
    }

    if (clientIp !== null) recordFailedAttempt(clientIp)
    consola.warn(
      `[${routeName}] Rejected: invalid credential from IP ${clientIp ?? "(unknown)"}`,
    )
    return { allowed: false, banned: false, clientIp }
  }

  if (clientIp !== null && (await isIpAllowedForTransparentProxy(clientIp))) {
    return { allowed: true, banned: false, clientIp }
  }

  if (clientIp !== null && isIpBanned(clientIp)) {
    return { allowed: false, banned: true, clientIp }
  }

  if (clientIp !== null) recordFailedAttempt(clientIp)
  consola.warn(
    `[${routeName}] Rejected: IP ${clientIp ?? "(unknown)"} not whitelisted and no valid API key`,
  )
  return { allowed: false, banned: false, clientIp }
}

/**
 * IP-only authorization for Codex Desktop dictation.
 *
 * `/transcribe` deliberately ignores credentials because current Desktop
 * builds do not attach the API-key credential to this request reliably. Only
 * an enabled managed allowlist entry or an active session lease can authorize
 * the resolved client IP. Forwarding headers remain trusted only when the
 * actual socket peer is configured as a trusted proxy.
 */
export async function authorizeCodexDesktopIpRequest(
  c: Context,
  routeName: string,
): Promise<CodexDesktopAuthResult> {
  const clientIp = extractClientIp(c)

  if (clientIp !== null && (await isIpAllowedForTranscription(clientIp))) {
    return { allowed: true, banned: false, clientIp }
  }

  if (clientIp !== null && isIpBanned(clientIp)) {
    return { allowed: false, banned: true, clientIp }
  }

  if (clientIp !== null) recordFailedAttempt(clientIp)
  consola.warn(
    `[${routeName}] Rejected: IP ${clientIp ?? "(unknown)"} not whitelisted`,
  )
  return { allowed: false, banned: false, clientIp }
}
