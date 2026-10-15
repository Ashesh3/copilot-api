import type { MiddlewareHandler } from "hono"

import { extractRequestCredential } from "~/lib/credential-resolver"
import {
  getRoutingAffinity,
  resolveClaudeRoutingAffinity,
  resolveResponsesRequestRoutingAffinity,
} from "~/lib/routing-affinity"

import { isRecord, runWithWebTools, webScopeKey } from "./tool-context"

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
  const headerAffinity = getRoutingAffinity()
  const affinity =
    resolveResponsesRequestRoutingAffinity(
      payload.client_metadata,
      headerAffinity,
    ) ?? resolveClaudeRoutingAffinity(payload.metadata)
  const thread = affinity?.threadKey ?? affinity?.key ?? "http"
  await runWithWebTools(
    payload,
    webScopeKey(extractRequestCredential(c.req.raw) ?? "", thread),
    next,
  )
}
