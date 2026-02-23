import type { Context, Next } from "hono"

import { extractClientIp, isIpBlocked, recordFailedAttempt } from "./ip-blocker"
import { extractRequestApiKey } from "./request-auth"
import { state } from "./state"

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
    // Silent drop: never resolves, client gets no response
    await new Promise(() => {})
    return
  }

  const requestApiKey = extractRequestApiKey(c)

  if (requestApiKey === state.apiKeyAuth) {
    await next()
    return
  }

  if (clientIp !== null) {
    recordFailedAttempt(clientIp)
  }

  // Silent drop: never resolves, client gets no response
  await new Promise(() => {})
}
