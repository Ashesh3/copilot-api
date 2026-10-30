import { usesPooledAccounts } from "~/lib/account-router"

/**
 * The scope of what one Copilot account refuses. In a pool another account
 * may accept what one refuses; a single account is one scope.
 */
export function copilotAccountScope(accountId: number | undefined): string {
  if (!usesPooledAccounts()) return "single"
  return accountId === undefined ? "unrouted" : `account:${accountId}`
}
