import type { MiddlewareHandler } from "hono"

import { isRecord, runWithWebTools } from "./tool-context"

export const webToolsMiddleware: MiddlewareHandler = async (c, next) => {
  const path = new URL(c.req.url).pathname
  const inference =
    /^\/(?:v1\/)?(?:messages|chat\/completions|responses)\/?$/.test(path)
    || /^\/(?:v1\/|v1beta\/)?models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(
      path,
    )
  if (c.req.method !== "POST" || !inference) {
    await next()
    return
  }
  const payload: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!isRecord(payload)) {
    await next()
    return
  }
  await runWithWebTools(payload, next)
}
