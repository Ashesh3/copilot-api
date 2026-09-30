import type { Context } from "hono"

import { ZodError } from "zod"

import {
  getModelFallbackConfig,
  getCapturedModelFallbackConfigRevision,
  getModelFallbackConfigRevision,
  setModelFallbackConfig,
  validateModelFallbackConfig,
} from "~/lib/model-fallback-config"
import { getModelRoutingSafety } from "~/lib/model-routing-safety"

export async function handleGetFallbacks(c: Context) {
  return c.json({
    config: await getModelFallbackConfig(),
    revision: getCapturedModelFallbackConfigRevision(),
    safety: getModelRoutingSafety(),
  })
}

export async function handleSetFallbacks(c: Context) {
  const match = c.req.header("If-Match")
  const revision = match?.replace(/^"(\d+)"$/, "$1")
  if (
    revision !== undefined
    && (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)))
  )
    return c.json({ error: "Invalid fallback configuration revision" }, 400)
  let body: unknown
  try {
    body = await c.req.json<unknown>()
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400)
  }

  let config: ReturnType<typeof validateModelFallbackConfig>
  try {
    config = validateModelFallbackConfig(body)
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => {
        const field = issue.path.join(".")
        return field ? `${field}: ${issue.message}` : issue.message
      })
      return c.json({ error: details.join("; ") }, 400)
    }
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid fallback settings",
      },
      400,
    )
  }

  const committed = await setModelFallbackConfig(
    config,
    revision === undefined ? undefined : Number(revision),
  )
  return c.json({
    config: committed,
    revision: getModelFallbackConfigRevision(),
    safety: getModelRoutingSafety(committed),
  })
}
