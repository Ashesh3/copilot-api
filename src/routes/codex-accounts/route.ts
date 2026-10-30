import type { Context } from "hono"

import { Hono } from "hono"

import type { AccountClaims } from "~/lib/codex-account-identity"

import { authenticateCodexAccountRequest } from "~/lib/codex-account-identity"

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
  const claims = await authenticateCodexAccountRequest(c)
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
  const claims = await authenticateCodexAccountRequest(c)
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
        // Desktop's startup trial and renewal readers dereference these
        // objects even when the managed identity has no hosted subscription.
        entitlement: {
          subscription_id: null,
          subscription_plan: null,
          expires_at: null,
          has_active_subscription: false,
        },
        last_active_subscription: {
          subscription_id: null,
          purchase_origin_platform: null,
          will_renew: false,
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
