import type { Context } from "hono"

import consola from "consola"

import { resolveRequestCredential } from "./credential-resolver"
import { extractClientIp, isIpAllowedForWhitelistedRoute } from "./ip-blocker"

export interface CodexDesktopAuthResult {
  allowed: boolean
  clientIp: string | null
}

/**
 * Auth for endpoints that Codex Desktop calls without going through the
 * standard `apiKeyGuard` middleware (currently `/transcribe` and
 * `/codex/responses`).
 *
 * Two paths are accepted:
 *
 *   1. **API key auth.** When `CODEX_API_BASE_URL` is spoofed to an
 *      `*.openai.com` host (e.g. `https://voice.openai.com`), Codex Desktop's
 *      main process passes `isDesktopAuthAllowedUrl()` and attaches
 *      `Authorization: Bearer <token>` automatically. We accept the request
 *      if that bearer (or `x-api-key` / `x-goog-api-key`) matches an active
 *      gateway key. Successful authentication never mutates IP policy.
 *
 *   2. **IP whitelist fallback.** Preserves the original behavior for callers
 *      that hit these endpoints without an API key — e.g. a machine where
 *      an IP explicitly added from the dashboard.
 *
 * Returns `{ allowed: false }` with a `consola.warn` log when neither path
 * succeeds; the caller is expected to silently 404 in that case (consistent
 * with the rest of the dictation surface).
 */
export async function authorizeCodexDesktopRequest(
  c: Context,
  routeName: string,
): Promise<CodexDesktopAuthResult> {
  const clientIp = extractClientIp(c)

  // Path 1: any centrally resolved inference credential.
  if (await resolveRequestCredential(c.req.raw, ["user:inference"])) {
    return { allowed: true, clientIp }
  }

  // Path 2: IP whitelist fallback.
  if (clientIp !== null && (await isIpAllowedForWhitelistedRoute(clientIp))) {
    return { allowed: true, clientIp }
  }

  consola.warn(
    `[${routeName}] Rejected: IP ${clientIp ?? "(unknown)"} not whitelisted and no valid API key`,
  )
  return { allowed: false, clientIp }
}
