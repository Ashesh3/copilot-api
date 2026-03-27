import type { Context, MiddlewareHandler, Next } from "hono"

import { getCookie, setCookie } from "hono/cookie"

import { state } from "./state"

const COOKIE_NAME = "traces_session"

function getConfiguredApiKey(): string | undefined {
  return state.apiKeyAuth || process.env.COPILOT_API_KEY_AUTH
}

export const tracesAuthMiddleware: MiddlewareHandler = async (
  c: Context,
  next: Next,
) => {
  const configuredKey = getConfiguredApiKey()

  // If no API key is configured, allow all access
  if (!configuredKey) {
    await next()
    return
  }

  // Check for key in query param (first visit)
  const queryKey = c.req.query("key")
  if (queryKey === configuredKey) {
    setCookie(c, COOKIE_NAME, configuredKey, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/traces",
      maxAge: 60 * 60 * 24 * 30,
    })
    const url = new URL(c.req.url)
    url.searchParams.delete("key")
    return c.redirect(url.toString())
  }

  // Check for key in cookie
  const cookieKey = getCookie(c, COOKIE_NAME)
  if (cookieKey === configuredKey) {
    await next()
    return
  }

  // Check for key in header (tRPC client fallback)
  const headerKey =
    c.req.header("x-api-key")
    || c.req.header("authorization")?.replace("Bearer ", "")
  if (headerKey === configuredKey) {
    await next()
    return
  }

  return c.html(
    `<!DOCTYPE html>
    <html><head><title>Traces - Auth Required</title></head>
    <body style="font-family:system-ui;max-width:400px;margin:100px auto;text-align:center">
      <h2>Authentication Required</h2>
      <p>Append <code>?key=YOUR_API_KEY</code> to the URL to access traces.</p>
    </body></html>`,
    401,
  )
}
