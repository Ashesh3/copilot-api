import { GITHUB_USER_AGENT } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { githubApiBaseUrl } from "~/lib/github-instance"
import { state } from "~/lib/state"

interface GetCopilotTokenOptions {
  githubToken?: string
  instanceDomain?: string
}

export const getCopilotToken = async (options?: GetCopilotTokenOptions) => {
  const githubToken = options?.githubToken ?? state.githubToken
  const instanceDomain = options?.instanceDomain ?? state.githubInstanceDomain
  const response = await fetch(
    `${githubApiBaseUrl(instanceDomain)}/copilot_internal/v2/token`,
    {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `token ${githubToken}`,
        "user-agent": GITHUB_USER_AGENT,
      },
    },
  )

  if (!response.ok) {
    throw new HTTPError(
      `Failed to get Copilot token (HTTP ${response.status})`,
      response,
    )
  }

  return (await response.json()) as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
export interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: {
    api?: string
  }
}
