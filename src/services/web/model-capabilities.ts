import { getActiveAccount, getTurnAccount } from "~/lib/account-lease-context"
import { getSelectedRoutedAccountId } from "~/lib/account-router"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"

export function modelAllowsWebTools(
  model: unknown,
  accountId?: number,
): boolean {
  if (typeof model !== "string") return true
  const account = getTurnAccount(model)?.account ?? getActiveAccount()
  const selectedId = accountId ?? getSelectedRoutedAccountId()
  const selected =
    selectedId === undefined ?
      account?.modelsData.find((entry) => entry.id === model)
    : tokenPool.getModelForAccount(model, selectedId)
  const metadata =
    selected ?? state.models?.data.find((entry) => entry.id === model)
  // Unknown/custom providers keep their existing function-calling contract.
  // Never break a known text-only model by injecting unsupported declarations.
  return metadata?.capabilities.supports.tool_calls !== false
}
