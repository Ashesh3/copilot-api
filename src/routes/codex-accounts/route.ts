import type { Context } from "hono"

import { Hono } from "hono"
import { z } from "zod"

import { extractRequestCredential } from "~/lib/credential-resolver"
import { trustedJwtDigestStore } from "~/lib/trusted-jwt-digests"

const AUTH_CLAIMS_KEY = "https://api.openai.com/auth"
const JWT_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]+$/
const accountClaimsSchema = z.object({
  [AUTH_CLAIMS_KEY]: z.object({
    chatgpt_account_id: z.string().min(1),
    chatgpt_user_id: z.string().min(1),
    chatgpt_plan_type: z.string().min(1),
  }),
})

// Authentication is the enabled managed digest, not this unsigned metadata.
// Keep expiry/revocation semantics aligned with the existing refresh endpoint.
function readAccountClaims(credential: string) {
  if (!JWT_PATTERN.test(credential)) return null
  const payload = credential.split(".")[1]
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    )
    const parsed = accountClaimsSchema.safeParse(decoded)
    return parsed.success ? parsed.data[AUTH_CLAIMS_KEY] : null
  } catch {
    return null
  }
}

function unauthorized(c: Context): Response {
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    { error: { message: "Unauthorized", type: "authentication_error" } },
    401,
  )
}

async function accountDiscovery(c: Context): Promise<Response> {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
  // Hono dispatches HEAD through GET handlers, so check the original method.
  if (c.req.method !== "GET") return c.json({ error: "Not found" }, 404)

  const authorization = c.req.header("authorization")?.trim()
  const credential = extractRequestCredential(c.req.raw)
  if (
    !authorization
    || !/^Bearer\s+\S+$/i.test(authorization)
    || credential === null
    || (await trustedJwtDigestStore.findEnabledCredential(credential)) === null
  ) {
    return unauthorized(c)
  }

  const claims = readAccountClaims(credential)
  if (claims === null) return unauthorized(c)
  const accountId = claims.chatgpt_account_id
  const requestedAccountId = c.req.header("chatgpt-account-id")
  if (requestedAccountId !== undefined && requestedAccountId !== accountId) {
    return c.json(
      {
        error: {
          message: "Account does not match the authenticated identity",
          type: "permission_error",
        },
      },
      403,
    )
  }

  return c.json({
    accounts: [
      {
        id: accountId,
        account_user_id: claims.chatgpt_user_id,
        account_user_role: "standard-user",
        structure: "personal",
        plan_type: claims.chatgpt_plan_type,
        is_zdr: false,
        is_openai_internal: false,
        // Preserve the client's configured HTTPS backend instead of deriving
        // routing from untrusted Host headers or redirecting its bearer.
        workspace_backend_origin: "NO_CONSTRAINT",
        account_routing_override: "NO_CONSTRAINT",
      },
    ],
    default_account_id: accountId,
    account_ordering: [accountId],
  })
}

export const codexAccountRoutes = new Hono()

for (const path of [
  "/api/codex/accounts/check",
  "/wham/accounts/check",
  "/backend-api/wham/accounts/check",
]) {
  codexAccountRoutes.all(path, accountDiscovery)
}
