import type { Context, Next } from "hono"

import consola from "consola"
import { Hono } from "hono"

import { getConfig } from "~/lib/config"
import {
  extractClientIp,
  isIpBlocked,
  recordFailedAttempt,
} from "~/lib/ip-blocker"
import { extractRequestApiKey } from "~/lib/request-auth"
import { state } from "~/lib/state"
import { getUsageResponse } from "~/lib/usage-tracker"

const SCOPES =
  "user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload org:create_api_key"

function getAccessToken(): string {
  // Use the --api-key-auth value if set (the key users authenticate with)
  if (state.apiKeyAuth) return state.apiKeyAuth
  const config = getConfig()
  const keys = config.auth?.apiKeys ?? []
  if (keys.length > 0) return keys[0]
  return "copilot-api-token"
}

/**
 * Auth guard for OAuth API routes.
 * Checks Bearer token or x-api-key against state.apiKeyAuth.
 * Applies IP banning on failures (same as apiKeyGuard).
 */
async function oauthAuthGuard(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  if (!state.apiKeyAuth) {
    await next()
    return
  }

  const clientIp = extractClientIp(c)

  if (clientIp !== null && isIpBlocked(clientIp)) {
    await new Promise(() => {})
    return
  }

  const requestApiKey = extractRequestApiKey(c)

  if (requestApiKey === state.apiKeyAuth) {
    await next()
    return
  }

  const maskedGot = requestApiKey ? `...${requestApiKey.slice(-10)}` : "(none)"
  const maskedExpected = `...${state.apiKeyAuth.slice(-10)}`
  consola.warn(
    `[oauth-guard] Auth failed: ${c.req.method} ${c.req.path} — got ${maskedGot}, expected ${maskedExpected}`,
  )

  if (clientIp !== null) {
    recordFailedAttempt(clientIp)
  }

  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
}

// --- Browser routes: mounted at /oauth ---

export const oauthBrowserRoutes = new Hono()

// GET /oauth/authorize — show login form requiring API key
oauthBrowserRoutes.get("/authorize", (c) => {
  const redirectUri = c.req.query("redirect_uri")
  const queryString = new URL(c.req.url).search

  if (!redirectUri) {
    return c.text("Missing redirect_uri", 400)
  }

  // If no apiKeyAuth is configured, auto-redirect
  if (!state.apiKeyAuth) {
    const stateParam = c.req.query("state")
    const url = new URL(redirectUri)
    url.searchParams.set("code", "copilot-api-auth-code")
    if (stateParam) url.searchParams.set("state", stateParam)
    return c.redirect(url.toString(), 302)
  }

  return c.html(getAuthorizePage(queryString))
})

// POST /oauth/authorize — validate API key, then redirect
oauthBrowserRoutes.post("/authorize", async (c) => {
  const redirectUri = c.req.query("redirect_uri")
  const stateParam = c.req.query("state")

  if (!redirectUri) {
    return c.text("Missing redirect_uri", 400)
  }

  const clientIp = extractClientIp(c)

  if (clientIp !== null && isIpBlocked(clientIp)) {
    await new Promise(() => {})
    return
  }

  const body = await c.req.parseBody()
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : ""

  if (!state.apiKeyAuth || apiKey === state.apiKeyAuth) {
    const url = new URL(redirectUri)
    url.searchParams.set("code", "copilot-api-auth-code")
    if (stateParam) url.searchParams.set("state", stateParam)
    return c.redirect(url.toString(), 302)
  }

  if (clientIp !== null) {
    recordFailedAttempt(clientIp)
  }

  const queryString = new URL(c.req.url).search
  return c.html(getAuthorizePage(queryString, "Invalid API key"), 401)
})

// GET /oauth/code/success — success page
oauthBrowserRoutes.get("/code/success", (c) => {
  return c.html(
    "<html><body><h1>Login successful</h1><p>You can close this tab.</p></body></html>",
  )
})

// GET /oauth/code/callback — manual callback fallback
oauthBrowserRoutes.get("/code/callback", (c) => {
  return c.html(
    "<html><body><h1>Authorization Code</h1><p>Copy this code into Claude Code:</p><pre>copilot-api-auth-code</pre></body></html>",
  )
})

// --- Token routes: mounted at /v1/oauth ---

export const oauthTokenRoutes = new Hono()

// GET /v1/oauth/hello — connectivity check
oauthTokenRoutes.get("/hello", (c) => c.json({ status: "ok" }))

// Auth guard — Claude Code sends the code + code_verifier, no API key.
// Validate the auth code matches what we issued.
oauthTokenRoutes.post("/token", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, string>
  const grantType = body.grant_type

  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return c.json({ error: "unsupported_grant_type" }, 400)
  }

  // For authorization_code, verify the code matches what we issued
  if (
    grantType === "authorization_code"
    && body.code !== "copilot-api-auth-code"
  ) {
    return c.json({ error: "invalid_grant" }, 400)
  }

  return c.json({
    access_token: getAccessToken(),
    refresh_token: "ref-copilot-api",
    expires_in: 86400,
    scope: SCOPES,
    token_type: "bearer",
  })
})

// --- API routes: mounted at /api ---

export const oauthApiRoutes = new Hono()

// GET /api/hello — connectivity check (no auth)
oauthApiRoutes.get("/hello", (c) => c.json({ status: "ok" }))

// POST /api/event_logging/batch — silently accept telemetry (no auth)
oauthApiRoutes.post("/event_logging/batch", (c) => c.json({ success: true }))

// GET /api/web/domain_info — domain safety check, allow all (no auth)
oauthApiRoutes.get("/web/domain_info", (c) => {
  const domain = c.req.query("domain") ?? ""
  return c.json({ domain, can_fetch: true })
})

// All remaining API routes require valid Bearer token / x-api-key
oauthApiRoutes.use("*", oauthAuthGuard)

// GET /api/oauth/profile — fake profile
oauthApiRoutes.get("/oauth/profile", (c) => {
  return c.json({
    account: {
      uuid: "00000000-0000-4000-8000-000000000001",
      display_name: "Copilot API User",
      created_at: "2025-01-01T00:00:00Z",
    },
    organization: {
      uuid: "00000000-0000-4000-8000-000000000002",
      organization_type: "claude_max",
      rate_limit_tier: "max",
      billing_type: "self-serve",
      has_extra_usage_enabled: true,
      subscription_created_at: "2025-01-01T00:00:00Z",
    },
  })
})

// GET /api/oauth/claude_cli/roles
oauthApiRoutes.get("/oauth/claude_cli/roles", (c) => c.json([]))

// GET /api/claude_code_penguin_mode
oauthApiRoutes.get("/claude_code_penguin_mode", (c) => c.json({}))

// GET /api/claude_cli_profile
oauthApiRoutes.get("/claude_cli_profile", (c) => c.json({}))

// GET /api/oauth/usage — usage data for settings panel
oauthApiRoutes.get("/oauth/usage", (c) => c.json(getUsageResponse()))

// GET /api/oauth/claude_cli/client_data
oauthApiRoutes.get("/oauth/claude_cli/client_data", (c) => c.json({}))

// POST /api/oauth/claude_cli/create_api_key
oauthApiRoutes.post("/oauth/claude_cli/create_api_key", (c) =>
  c.json({ api_key: getAccessToken() }),
)

// POST /api/claude_cli_feedback
oauthApiRoutes.post("/claude_cli_feedback", (c) => c.json({ success: true }))

// POST /api/claude_code/metrics
oauthApiRoutes.post("/claude_code/metrics", (c) => c.json({ success: true }))

// GET /api/claude_code/organizations/metrics_enabled
oauthApiRoutes.get("/claude_code/organizations/metrics_enabled", (c) =>
  c.json({ enabled: false }),
)

// POST /api/claude_code/link_vcs_account
oauthApiRoutes.post("/claude_code/link_vcs_account", (c) =>
  c.json({ success: true }),
)

// GET /api/claude_code/user_settings
oauthApiRoutes.get("/claude_code/user_settings", (c) => c.json({}))

// PUT /api/claude_code/user_settings
oauthApiRoutes.put("/claude_code/user_settings", (c) =>
  c.json({ success: true }),
)

// GET /api/organization
oauthApiRoutes.get("/organization/:id", (c) =>
  c.json({
    uuid: c.req.param("id"),
    name: "Copilot API",
    settings: {},
  }),
)

// --- Authorize page HTML ---

function getAuthorizePage(queryString: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize — Copilot API</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2rem; width: 100%; max-width: 380px; }
  h1 { font-size: 1.2rem; color: #e6edf3; margin-bottom: 0.5rem; }
  p { font-size: 0.85rem; color: #8b949e; margin-bottom: 1.5rem; }
  input[type="password"] { width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 0.6rem 0.75rem; border-radius: 6px; font-size: 0.9rem; outline: none; margin-bottom: 1rem; }
  input[type="password"]:focus { border-color: #58a6ff; }
  button { width: 100%; padding: 0.6rem; border-radius: 6px; border: none; background: #238636; color: #fff; font-size: 0.9rem; cursor: pointer; }
  button:hover { background: #2ea043; }
  .error { color: #f85149; font-size: 0.85rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorize Claude Code</h1>
  <p>Enter your API key to continue.</p>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/oauth/authorize${queryString}">
    <input type="password" name="api_key" placeholder="API key" autofocus required>
    <button type="submit">Authorize</button>
  </form>
</div>
</body>
</html>`
}
