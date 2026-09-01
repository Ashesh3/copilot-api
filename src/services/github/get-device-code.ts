import {
  GITHUB_APP_SCOPES,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { DEFAULT_GITHUB_DOMAIN, githubBaseUrl } from "~/lib/github-instance"

export async function getDeviceCode(
  instanceDomain = DEFAULT_GITHUB_DOMAIN,
): Promise<DeviceCodeResponse> {
  const response = await fetch(
    `${githubBaseUrl(instanceDomain)}/login/device/code`,
    {
      method: "POST",
      headers: {
        ...standardHeaders(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        scope: GITHUB_APP_SCOPES.replaceAll(" ", ","),
      }),
    },
  )

  if (!response.ok) throw new HTTPError("Failed to get device code", response)

  return (await response.json()) as DeviceCodeResponse
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}
