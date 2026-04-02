import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Request-scoped storage for the client session ID.
 *
 * The `X-Claude-Code-Session-Id` header is captured by middleware and stored
 * here so that downstream code (e.g. account-router) can read it without
 * threading it through every function signature.
 */
export const clientSessionStorage = new AsyncLocalStorage<string | undefined>()

export function getClientSessionId(): string | undefined {
  return clientSessionStorage.getStore()
}
