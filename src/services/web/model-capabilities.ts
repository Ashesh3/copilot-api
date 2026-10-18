import type { Model } from "~/services/copilot/get-models"

import { getActiveAccount, getTurnAccount } from "~/lib/account-lease-context"
import { getSelectedRoutedAccountId } from "~/lib/account-router"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"

function selectedModel(model: unknown, accountId?: number): Model | undefined {
  if (typeof model !== "string") return undefined
  const account = getTurnAccount(model)?.account ?? getActiveAccount()
  const selectedId = accountId ?? getSelectedRoutedAccountId()
  const selected =
    selectedId === undefined ?
      account?.modelsData.find((entry) => entry.id === model)
    : tokenPool.getModelForAccount(model, selectedId)
  // An account-scoped catalog must never inherit another account's capability.
  return selectedId !== undefined || account ?
      selected
    : state.models?.data.find((entry) => entry.id === model)
}

export function modelAllowsWebTools(
  model: unknown,
  accountId?: number,
): boolean {
  const metadata = selectedModel(model, accountId)
  // Unknown/custom providers keep their existing function-calling contract.
  // Never break a known text-only model by injecting unsupported declarations.
  return metadata?.capabilities.supports.tool_calls !== false
}

export function modelAllowsHostedWebSearch(
  model: unknown,
  accountId?: number,
): boolean {
  const metadata = selectedModel(model, accountId)
  if (!metadata || metadata.custom_model) return false
  const supports = metadata.capabilities.supports
  return Boolean(
    metadata.supported_endpoints?.includes("/responses")
      && supports.tool_calls !== false
      && supports.web_search !== false
      && (!metadata.policy || metadata.policy.state === "enabled")
      && (supports.web_search === true
        || metadata.vendor?.toLowerCase() === "openai"
        || /^gpt[-.]/i.test(metadata.id)),
  )
}
