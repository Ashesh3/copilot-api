import type {
  AccountAllocation,
  AccountDistribution,
} from "./account-distribution"

import { api, get } from "./api"

export const accountDistributionPath = "/dashboard/api/accounts/distribution"

export function loadAccountDistribution(): Promise<AccountDistribution> {
  return get<AccountDistribution>(accountDistributionPath)
}

export function saveAccountDistribution(
  allocations: Array<AccountAllocation>,
  expectedRevision: number,
): Promise<AccountDistribution> {
  return api<AccountDistribution>(
    "PUT",
    accountDistributionPath,
    { allocations },
    { expectedRevision },
  )
}
