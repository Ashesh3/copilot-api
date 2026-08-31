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
 * standard `apiKeyGuard` middleware.
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
 * Credential-aware authorization for Codex Desktop dictation.
 *
 * Current Desktop builds attach the active ChatGPT-shaped bearer when the
 * configured URL passes their trusted-host check. Accepting that credential
 * makes the Cloudflare/public-host path independent of a changing client IP.
 * Older builds that omit credentials retain the enabled managed allowlist or
 * active session-lease fallback. A supplied invalid credential fails closed
 * instead of falling through to IP authorization.
 */
export async function authorizeCodexDesktopTranscriptionRequest(
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

  if (clientIp !== null && (await isIpAllowedForTranscription(clientIp))) {
    return { allowed: true, banned: false, clientIp }
  }

  if (clientIp !== null && isIpBanned(clientIp)) {
    return { allowed: false, banned: true, clientIp }
  }

  if (clientIp !== null) recordFailedAttempt(clientIp)
  consola.warn(
    `[${routeName}] Rejected: IP ${clientIp ?? "(unknown)"} not whitelisted and no valid credential`,
  )
  return { allowed: false, banned: false, clientIp }
}
