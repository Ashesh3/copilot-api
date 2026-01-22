import consola from "consola"

import {
  getAzureOpenAIDeployments,
  loadAzureOpenAIConfig,
  promptAzureOpenAISetup,
} from "~/services/azure-openai"
import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  try {
    const models = await getModels()
    state.models = models
  } catch (error) {
    consola.error("Failed to fetch and cache models. This could be due to:")
    consola.error("  - Invalid or expired Copilot token")
    consola.error("  - Network connectivity issues")
    consola.error("  - GitHub Copilot service unavailable")
    consola.error(
      "  - Account type mismatch (try --account-type=individual or --account-type=business)",
    )
    throw error
  }
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}

export async function setupAzureOpenAI(): Promise<void> {
  // Try to load existing config
  let config = await loadAzureOpenAIConfig()

  // If no config exists, prompt user on first run
  if (!config) {
    config = await promptAzureOpenAISetup()
  }

  if (!config) {
    consola.info("Azure OpenAI not configured")
    return
  }

  state.azureOpenAIConfig = config
  consola.info("Azure OpenAI configuration loaded")

  // Fetch and cache Azure OpenAI deployments
  try {
    const deployments = await getAzureOpenAIDeployments(config)
    state.azureOpenAIDeployments = deployments
    if (deployments.length > 0) {
      consola.info(
        `Loaded ${deployments.length} Azure OpenAI deployment(s):\n${deployments.map((d) => `- ${d.id} (${d.model})`).join("\n")}`,
      )
    } else {
      consola.warn("No Azure OpenAI deployments found")
    }
  } catch (error) {
    consola.warn("Failed to fetch Azure OpenAI deployments:", error)
  }
}
