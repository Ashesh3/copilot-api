import type { Context, MiddlewareHandler } from "hono"

import { Hono } from "hono"

import { resolveRequestCredentialKind } from "~/lib/credential-resolver"
import { resolveProtectedCredential } from "~/lib/protected-credential"

type OAuthScope = "user:mcp_servers" | "user:sessions:claude_code"

export const claudeCompatibilityRoutes = new Hono()

function unauthorized(c: Context): Response {
  c.header("Cache-Control", "no-store")
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
}

// Compatibility stubs: deny without an OAuth scope, but never record a
// credential failure. Clients poll these unprompted, so a wrong-kind or
// stale credential must not ban the caller (see protected-credential).
function requireScopedOAuth(scope: OAuthScope): MiddlewareHandler {
  return async (c, next) => {
    const auth = await resolveProtectedCredential(
      c.req.raw,
      async () =>
        await resolveRequestCredentialKind(c.req.raw, "oauth", {
          requiredScopes: [scope],
        }),
      { recordFailures: false },
    )
    if (auth.status !== "authorized") return unauthorized(c)
    await next()
  }
}

const requireSessionOAuth = requireScopedOAuth("user:sessions:claude_code")
const requireMcpOAuth = requireScopedOAuth("user:mcp_servers")

// Register both the collection path and descendants so unimplemented
// compatibility methods cannot fall through to gateway/inference auth.
claudeCompatibilityRoutes.use("/code/triggers", requireSessionOAuth)
claudeCompatibilityRoutes.use("/code/triggers/*", requireSessionOAuth)
claudeCompatibilityRoutes.get("/code/triggers", (c) => c.json({ triggers: [] }))
claudeCompatibilityRoutes.post("/code/triggers", (c) =>
  c.json({ triggers: [] }),
)
claudeCompatibilityRoutes.all("/code/triggers/*", (c) => c.notFound())

claudeCompatibilityRoutes.post(
  "/code/github/import-token",
  requireSessionOAuth,
  (c) => c.json({ github_username: "copilot-api-user" }),
)

claudeCompatibilityRoutes.get(
  "/environment_providers",
  requireSessionOAuth,
  (c) => c.json({ environments: [] }),
)
claudeCompatibilityRoutes.post(
  "/environment_providers/cloud/create",
  requireSessionOAuth,
  (c) => c.json({ environment: { id: "env_stub", status: "created" } }),
)

claudeCompatibilityRoutes.get("/mcp_servers", requireMcpOAuth, (c) =>
  c.json({ data: [] }),
)

claudeCompatibilityRoutes.get(
  "/session_ingress/session/:id",
  requireSessionOAuth,
  (c) => c.json({ session_id: c.req.param("id"), status: "active" }),
)

claudeCompatibilityRoutes.get("/ultrareview/quota", requireSessionOAuth, (c) =>
  c.json({ remaining: 0, total: 0 }),
)
