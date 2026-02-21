import type { Context, Next } from "hono"

import { extractRequestApiKey } from "./request-auth"
import { state } from "./state"

/**
 * API key guard middleware that silently drops connections when the API key
 * doesn't match the expected value. Unauthorized requests get NO response.
 *
 * Only active when state.apiKeyAuth is set (via --api-key-auth CLI flag).
 */
export async function apiKeyGuard(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  if (!state.apiKeyAuth) {
    return next()
  }

  const requestApiKey = extractRequestApiKey(c)

  if (requestApiKey === state.apiKeyAuth) {
    return next()
  }

  // Silent drop: never resolves, client gets no response
  return new Promise(() => {})
}
