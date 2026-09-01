import consola from "consola"
import fs from "node:fs/promises"

import { addAccount, getStoredCredentials } from "~/lib/accounts-store"
import {
  DEFAULT_GITHUB_DOMAIN,
  parseGitHubCredential,
} from "~/lib/github-instance"
import { isEnvOnlyTokens, PATHS } from "~/lib/paths"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"
import { resolveCopilotOAuth } from "~/services/github/resolve-copilot-oauth"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

export const setupCopilotToken = async () => {
  if (!state.githubToken) throw new Error("GitHub token is not set")
  const resolved = await resolveCopilotOAuth({
    accountType: state.accountType,
    githubToken: state.githubToken,
    instanceDomain: state.githubInstanceDomain,
  })
  Object.assign(state, {
    copilotApiBaseUrl: resolved.baseUrl,
    copilotToken: resolved.token,
    models: resolved.models,
  })

  consola.debug("GitHub Copilot OAuth token validated")
  if (state.showToken) {
    consola.info("Copilot token:", resolved.token)
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  if (isEnvOnlyTokens()) {
    // Tokens came from env vars; never read or write token files.
    if (state.githubToken) {
      await logUser()
      return
    }
    throw new Error(
      "Env-only token mode set but no token configured in state.githubToken",
    )
  }
  try {
    // Try stored accounts first, then legacy file
    const storedCredentials = await getStoredCredentials()
    const legacyToken = await readGithubToken()
    const existingCredential =
      storedCredentials.at(0)
      ?? (legacyToken ? parseGitHubCredential(legacyToken) : undefined)

    if (existingCredential && !options?.force) {
      state.githubToken = existingCredential.token
      state.githubInstanceDomain = existingCredential.instanceDomain
      if (state.showToken) {
        consola.info("GitHub token:", existingCredential.token)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode(DEFAULT_GITHUB_DOMAIN)
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response, DEFAULT_GITHUB_DOMAIN)
    // Save to both legacy file and accounts store
    await writeGithubToken(token)
    await addAccount(token, undefined, DEFAULT_GITHUB_DOMAIN)
    state.githubToken = token
    state.githubInstanceDomain = DEFAULT_GITHUB_DOMAIN

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
