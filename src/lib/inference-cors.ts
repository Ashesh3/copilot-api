import type { MiddlewareHandler } from "hono"

import { isGoogleApiCredentialPath } from "./credential-resolver"

type InferenceMethod = "GET" | "POST"

interface InferenceCorsRoute {
  matches(pathname: string): boolean
  method: InferenceMethod
}

function exactPath(...paths: Array<string>): (pathname: string) => boolean {
  const allowed = new Set(paths.flatMap((path) => [path, `${path}/`]))
  return (pathname) => allowed.has(pathname)
}

function isGoogleActionModelPath(pathname: string): boolean {
  return /:(?:generateContent|streamGenerateContent|countTokens)$/.test(
    pathname,
  )
}

const INFERENCE_ROUTES: Array<InferenceCorsRoute> = [
  { method: "GET", matches: exactPath("/models", "/v1/models") },
  {
    method: "GET",
    matches: (pathname) => {
      const normalized =
        pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
      return (
        /^\/(?:v1\/)?models\/[^/]+$/.test(normalized)
        && !isGoogleActionModelPath(normalized)
        && normalized !== "/models/session"
      )
    },
  },
  {
    method: "POST",
    matches: exactPath("/chat/completions", "/v1/chat/completions"),
  },
  {
    method: "POST",
    matches: exactPath("/embeddings", "/v1/embeddings"),
  },
  {
    method: "POST",
    matches: exactPath("/v1/messages", "/v1/messages/count_tokens"),
  },
  {
    method: "POST",
    matches: exactPath(
      "/responses",
      "/responses/compact",
      "/v1/responses",
      "/v1/responses/compact",
    ),
  },
  { method: "POST", matches: isGoogleApiCredentialPath },
  {
    method: "POST",
    matches: exactPath("/alpha/search", "/v1/alpha/search"),
  },
  { method: "POST", matches: exactPath("/codex/responses") },
  {
    method: "POST",
    matches: exactPath("/models/session", "/models/session/intent"),
  },
  { method: "POST", matches: exactPath("/auto") },
]

function allowedOrigins(): Set<string> {
  return new Set(
    (process.env.COPILOT_INFERENCE_CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
}

function isInferenceRoute(
  pathname: string,
  method: string,
): method is InferenceMethod {
  if (method !== "GET" && method !== "POST") return false
  return INFERENCE_ROUTES.some(
    (route) => route.method === method && route.matches(pathname),
  )
}

export const inferenceCors: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin")
  const originAllowed = origin !== undefined && allowedOrigins().has(origin)
  const requestedMethod =
    c.req.method === "OPTIONS" ?
      c.req.header("access-control-request-method")
    : c.req.method
  const allowed =
    originAllowed
    && requestedMethod !== undefined
    && isInferenceRoute(c.req.path, requestedMethod)

  if (c.req.method === "OPTIONS") {
    if (!allowed) return c.json({ error: "Not found" }, 404)
    c.header("Access-Control-Allow-Origin", origin)
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    c.header(
      "Access-Control-Allow-Headers",
      "authorization, content-type, x-api-key, x-goog-api-key",
    )
    c.header("Access-Control-Max-Age", "600")
    c.header("Vary", "Origin")
    return c.body(null, 204)
  }

  await next()
  if (allowed) {
    c.header("Access-Control-Allow-Origin", origin)
    c.header("Vary", "Origin")
  }
}
