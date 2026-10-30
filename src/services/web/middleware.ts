import type { MiddlewareHandler } from "hono"

import { isDroidRequest } from "~/lib/droid-client"
import { readResponsesRequestJson } from "~/routes/responses/request-json"

import type { WebProtocol } from "./tool-context"

import { isRecord, runWithWebTools } from "./tool-context"

function clientProtocol(path: string): WebProtocol | undefined {
  if (/^\/(?:v1\/)?responses\/?$/.test(path)) return "responses"
  if (/^\/(?:v1\/)?messages\/?$/.test(path)) return "messages"
  return /^\/(?:v1\/)?chat\/completions\/?$/.test(path) ? "chat" : undefined
}

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
  const request = c.req.raw.clone() as Request
  // Decode the same bytes as the route; leave body and parse errors to its handler.
  const payload: unknown = await (
    /^\/(?:v1\/)?responses\/?$/.test(path) ?
      readResponsesRequestJson(request)
    : request.json()).catch(() => undefined)
  if (!isRecord(payload)) {
    await next()
    return
  }
  await runWithWebTools(payload, next, {
    droid: isDroidRequest(c.req.raw.headers),
    protocol: clientProtocol(path),
  })
}
