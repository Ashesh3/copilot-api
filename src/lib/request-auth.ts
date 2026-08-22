import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"
import { createHash, timingSafeEqual } from "node:crypto"

import { getConfig } from "./config"
import {
  extractRequestCredential,
  resolveRequestCredential,
} from "./credential-resolver"
import { resolveProtectedCredential } from "./protected-credential"
import { state } from "./state"

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<string>
  allowUnauthenticatedPaths?: Array<string>
  allowOptionsBypass?: boolean
}

export function normalizeApiKeys(apiKeys: unknown): Array<string> {
  if (!Array.isArray(apiKeys)) {
    if (apiKeys !== undefined) {
      consola.warn("Invalid auth.apiKeys config. Expected an array of strings.")
    }
    return []
  }

  const normalizedKeys = apiKeys
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)

  if (normalizedKeys.length !== apiKeys.length) {
    consola.warn(
      "Invalid auth.apiKeys entries found. Only non-empty strings are allowed.",
    )
  }

  return [...new Set(normalizedKeys)]
}

export function getConfiguredApiKeys(): Array<string> {
  const config = getConfig()
  return normalizeApiKeys(config.auth?.apiKeys)
}

export function getActiveApiKeys(): Array<string> {
  if (state.apiKeyAuth) return [state.apiKeyAuth]
  return getConfiguredApiKeys()
}

export function extractRequestApiKey(c: Context): string | null {
  return extractRequestCredential(c.req.raw)
}

function createUnauthorizedResponse(c: Context): Response {
  c.header("Cache-Control", "no-store")
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    {
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    },
    401,
  )
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler {
  const getApiKeys = options.getApiKeys ?? getConfiguredApiKeys
  const allowUnauthenticatedPaths = options.allowUnauthenticatedPaths ?? ["/"]
  const allowOptionsBypass = options.allowOptionsBypass ?? false

  return async (c, next) => {
    if (allowOptionsBypass && c.req.method === "OPTIONS") {
      return next()
    }

    if (allowUnauthenticatedPaths.includes(c.req.path)) {
      return next()
    }

    const apiKeys = getApiKeys()
    if (apiKeys.length === 0) {
      return next()
    }

    const auth = await resolveProtectedCredential<unknown>(
      c.req.raw,
      async () => {
        const credential =
          options.getApiKeys ?
            resolveCustomApiKeys(c, apiKeys)
          : await resolveRequestCredential(c.req.raw, ["user:inference"])
        return credential || null
      },
      { trustClientIp: true },
    )
    if (auth.status !== "authorized") {
      return createUnauthorizedResponse(c)
    }

    return next()
  }
}

function resolveCustomApiKeys(c: Context, apiKeys: Array<string>): boolean {
  const requestApiKey = extractRequestApiKey(c)
  if (!requestApiKey) return false
  const requestDigest = createHash("sha256").update(requestApiKey).digest()
  return apiKeys.some((apiKey) =>
    timingSafeEqual(
      requestDigest,
      createHash("sha256").update(apiKey).digest(),
    ),
  )
}
