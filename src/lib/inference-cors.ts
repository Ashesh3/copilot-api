import type { MiddlewareHandler } from "hono"

const INFERENCE_PATHS = [
  /^\/(?:v1\/)?models\/?$/,
  /^\/(?:v1\/)?chat\/completions\/?$/,
  /^\/(?:v1\/)?embeddings\/?$/,
  /^\/v1\/messages(?:\/count_tokens)?\/?$/,
  /^\/(?:v1\/)?responses(?:\/compact)?\/?$/,
]

function allowedOrigins(): Set<string> {
  return new Set(
    (process.env.COPILOT_INFERENCE_CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
}

function isInferencePath(path: string): boolean {
  return INFERENCE_PATHS.some((pattern) => pattern.test(path))
}

export const inferenceCors: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin")
  const origins = allowedOrigins()
  const allowed =
    origin !== undefined && origins.has(origin) && isInferencePath(c.req.path)

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
