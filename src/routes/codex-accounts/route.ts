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

type AccountClaims = z.infer<typeof accountClaimsSchema>[typeof AUTH_CLAIMS_KEY]

// Authentication is the enabled managed digest, not this unsigned metadata.
// Keep expiry/revocation semantics aligned with the existing refresh endpoint.
function readAccountClaims(credential: string): AccountClaims | null {
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

// Returns the enabled managed identity's claims, or the response that ends the
// request. Both account contracts share these method, credential, and
// account-selector checks.
async function authenticateAccountRequest(
  c: Context,
): Promise<AccountClaims | Response> {
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
  const requestedAccountId = c.req.header("chatgpt-account-id")
  if (
    requestedAccountId !== undefined
    && requestedAccountId !== claims.chatgpt_account_id
  ) {
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
  return claims
}

// Both contracts describe the same personal membership. Personal structure
// keeps Desktop out of workspace-only policy checks, and the routing sentinels
// preserve the client's configured HTTPS backend instead of deriving routing
// from untrusted Host headers or redirecting its bearer.
function personalMembership(claims: AccountClaims) {
  return {
    account_user_id: claims.chatgpt_user_id,
    account_user_role: "standard-user",
    structure: "personal",
    plan_type: claims.chatgpt_plan_type,
    is_zdr: false,
    is_openai_internal: false,
    workspace_backend_origin: "NO_CONSTRAINT",
    account_routing_override: "NO_CONSTRAINT",
  }
}

async function accountDirectory(c: Context): Promise<Response> {
  const claims = await authenticateAccountRequest(c)
  if (claims instanceof Response) return claims
  const accountId = claims.chatgpt_account_id
  return c.json({
    accounts: [{ id: accountId, ...personalMembership(claims) }],
    default_account_id: accountId,
    account_ordering: [accountId],
  })
}

// ChatGPT's versioned account check, keyed by account ID. Desktop 26.1002
// reads the account structure from it before Codex Home may send; when the
// read fails, the workspace-policy gate reports "Couldn't load workspace
// settings" and blocks the composer.
async function accountInventory(c: Context): Promise<Response> {
  const claims = await authenticateAccountRequest(c)
  if (claims instanceof Response) return claims
  const accountId = claims.chatgpt_account_id
  return c.json({
    accounts: {
      [accountId]: {
        account: {
          account_id: accountId,
          ...personalMembership(claims),
          is_deactivated: false,
        },
        features: [],
        can_access_with_session: true,
        sso_connection_name: null,
      },
    },
    account_ordering: [accountId],
  })
}

export const codexAccountRoutes = new Hono()

for (const path of [
  "/api/codex/accounts/check",
  "/wham/accounts/check",
  "/backend-api/wham/accounts/check",
]) {
  codexAccountRoutes.all(path, accountDirectory)
}

for (const path of [
  "/accounts/check/v4-2023-04-27",
  "/backend-api/accounts/check/v4-2023-04-27",
]) {
  codexAccountRoutes.all(path, accountInventory)
}
