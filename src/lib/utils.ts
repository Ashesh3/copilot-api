import consola from "consola"

import { getModels } from "~/services/copilot/get-models"

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
