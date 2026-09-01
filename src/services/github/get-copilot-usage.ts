import { GITHUB_USER_AGENT } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { githubApiBaseUrl } from "~/lib/github-instance"
import { state } from "~/lib/state"

export const getCopilotUsage = async (
  githubToken = state.githubToken,
  instanceDomain = state.githubInstanceDomain,
): Promise<CopilotUsageResponse> => {
  const response = await fetch(
    `${githubApiBaseUrl(instanceDomain)}/copilot_internal/user`,
    {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${githubToken}`,
        "user-agent": GITHUB_USER_AGENT,
      },
    },
  )

  if (!response.ok) {
    throw new HTTPError(
      `Failed to get Copilot user information (HTTP ${response.status})`,
      response,
    )
  }

  return (await response.json()) as CopilotUsageResponse
}

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
}

interface QuotaSnapshots {
  chat: QuotaDetail
  completions: QuotaDetail
  premium_interactions: QuotaDetail
}

export interface CopilotUsageResponse {
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan: string
  endpoints?: {
    api?: string
  }
  login?: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date: string
  quota_snapshots: QuotaSnapshots
}
