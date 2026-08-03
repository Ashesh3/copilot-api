import type { ModelRoutingAccount } from "./types"

export function formatModelRoutingAccountDetails(
  account: ModelRoutingAccount,
): string {
  const models = `${account.modelsCount} models`
  return account.githubUsername ?
      `@${account.githubUsername} · ${models}`
    : models
}

export function formatModelRoutingAccountSummary(
  account: ModelRoutingAccount,
): string {
  const username = account.githubUsername ? `, @${account.githubUsername}` : ""
  const health = account.healthy ? "Healthy" : "Unhealthy"
  return `Account #${account.id}${username}, ${account.accountType}, ${health}`
}
