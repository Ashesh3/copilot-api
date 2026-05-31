import type { Context, MiddlewareHandler } from "hono"

import { extractClientIp, isIpAllowedForWhitelistedRoute } from "./ip-blocker"

/**
 * Hono middleware that silently 404s any request from an IP that is not in
 * the managed allowlist or session whitelist.
 *
 * Use this on routers whose endpoints are otherwise unauthenticated but
 * shouldn't be exposed to the open internet — e.g. code-session bookkeeping,
 * environment bridge registration, the GrowthBook remote-eval endpoint.
 *
 * Trust model matches the dashboard HTML guard:
 *   - Client IP is resolved by `extractClientIp`, which prefers `X-Real-IP`
 *     (set by nginx to `$remote_addr`) and falls back to the rightmost
 *     `X-Forwarded-For` entry. The leftmost (RFC-canonical "client") is
 *     attacker-supplied and is NOT trusted.
 *   - Returns 404 (not 401) to avoid revealing endpoint existence.
 *   - Does NOT count toward the 3-strikes IP ban — this is a pre-auth
 *     network gate, not an auth attempt.
 */
export const requireIpAllowlist: MiddlewareHandler = async (
  c: Context,
  next,
) => {
  const clientIp = extractClientIp(c)
  if (clientIp === null || !(await isIpAllowedForWhitelistedRoute(clientIp))) {
    return c.notFound()
  }
  await next()
}
