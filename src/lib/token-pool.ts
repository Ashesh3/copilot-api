import consola from "consola"
import { createHash, randomUUID } from "node:crypto"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { GITHUB_API_BASE_URL } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  hasModelRoutingOverride,
  isModelEnabledForAccount,
} from "~/lib/model-routing"
import { createCopilotTransportInit } from "~/services/copilot/transport-options"
import { getGitHubUser } from "~/services/github/get-user"

// Inline constants from copilot-client to avoid circular dependencies
const MODELS_API_VERSION = "2026-06-01"
const INTEGRATION_ID = "vscode-chat"

// --- Account ---

export interface Account {
  id: number
  githubToken: string
  githubUsername?: string
  copilotToken?: string
  copilotTokenExpiry?: number
  models: Set<string>
  modelsData: Array<Model>
  accountType: string
  healthy: boolean
}

// --- Copilot Token Response ---

interface CopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}

export function getTokenRefreshIntervalMs(refreshInSeconds: number): number {
  return Math.max((refreshInSeconds - 120) * 1000, 60_000)
}

export function maskTokenForLog(token: string): string {
  if (token.length <= 8) {
    return token
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

// --- TokenPool ---

export class TokenPool {
  private accounts: Map<number, Account> = new Map()
  private modelIndex: Map<string, Array<Account>> = new Map()
  private roundRobinIndex = 0
  private refreshTimers: Map<number, ReturnType<typeof setInterval>> = new Map()
  private sessionId: string = randomUUID()
  private vsCodeVersion = "1.104.3"

  /**
   * Set the VS Code version used in Copilot request headers.
   */
  setVSCodeVersion(version: string): void {
    this.vsCodeVersion = version
  }

  /**
   * Set the session ID used in Copilot request headers.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId
  }

  /**
   * Create and store a new Account.
   */
  addAccount(githubToken: string, accountType: string, id: number): Account {
    const account: Account = {
      id,
      githubToken,
      accountType,
      models: new Set(),
      modelsData: [],
      healthy: false,
    }
    this.accounts.set(id, account)
    return account
  }

  /**
   * Exchange a GitHub token for a Copilot token, fetch available models,
   * and set up an auto-refresh timer.
   */
  async initializeAccount(account: Account, showToken = false): Promise<void> {
    const tokenData = await this.fetchCopilotToken(account)

    // eslint-disable-next-line require-atomic-updates
    account.copilotToken = tokenData.token
    // eslint-disable-next-line require-atomic-updates
    account.copilotTokenExpiry = tokenData.expires_at
    // eslint-disable-next-line require-atomic-updates
    account.healthy = true

    if (showToken) {
      consola.info(
        `Account #${account.id} Copilot token: ${maskTokenForLog(tokenData.token)}`,
      )
    }

    consola.debug(
      `Account #${account.id} Copilot token fetched (expires_at=${tokenData.expires_at})`,
    )

    // Fetch models for this account
    const baseUrl = this.getBaseUrl(account)
    const modelsResponse = await this.fetchModels(account, baseUrl)
    // eslint-disable-next-line require-atomic-updates
    account.modelsData = modelsResponse.data
    // eslint-disable-next-line require-atomic-updates
    account.models = new Set(modelsResponse.data.map((m) => m.id))

    void this.resolveGitHubUsername(account)

    consola.info(
      `Account #${account.id} (${account.accountType}): ${account.models.size} models available`,
    )

    // Rebuild model index now that this account is healthy with models
    this.rebuildModelIndex()

    // Set up auto-refresh timer
    const refreshMs = getTokenRefreshIntervalMs(tokenData.refresh_in)
    this.setupRefreshTimer(account, refreshMs, showToken)
  }

  /**
   * Refresh a single account's Copilot token immediately.
   */
  async refreshAccountToken(
    account: Account,
    showToken = false,
  ): Promise<void> {
    const tokenData = await this.fetchCopilotToken(account)
    // eslint-disable-next-line require-atomic-updates
    account.copilotToken = tokenData.token
    // eslint-disable-next-line require-atomic-updates
    account.copilotTokenExpiry = tokenData.expires_at

    if (showToken) {
      consola.info(
        `Account #${account.id} refreshed Copilot token: ${maskTokenForLog(tokenData.token)}`,
      )
    }

    if (!account.healthy) {
      account.healthy = true
      consola.info(`Account #${account.id} recovered, marking healthy`)
      this.rebuildModelIndex()
    }

    const refreshMs = getTokenRefreshIntervalMs(tokenData.refresh_in)
    this.setupRefreshTimer(account, refreshMs, showToken)
  }

  /**
   * Rebuild the model-to-accounts index from all healthy accounts.
   */
  rebuildModelIndex(): void {
    this.modelIndex.clear()

    for (const account of this.accounts.values()) {
      if (!account.healthy) continue

      for (const modelId of account.models) {
        if (!isModelEnabledForAccount(modelId, account.id)) continue

        let list = this.modelIndex.get(modelId)
        if (!list) {
          list = []
          this.modelIndex.set(modelId, list)
        }
        list.push(account)
      }
    }

    consola.debug(
      `Model index rebuilt: ${this.modelIndex.size} models across ${this.getHealthyCount()} healthy accounts`,
    )
  }

  /**
   * Round-robin selection of an account that has the given model.
   * Returns undefined if no healthy account has the model.
   */
  getAccountForModel(modelId: string): Account | undefined {
    const eligible = this.modelIndex.get(modelId)
    if (!eligible || eligible.length === 0) return undefined

    const index = this.roundRobinIndex % eligible.length
    this.roundRobinIndex++
    return eligible[index]
  }

  /**
   * Session-affinity selection of an account for a given model.
   *
   * When a clientSessionId is provided, rendezvous-hashes it against eligible
   * account IDs to deterministically pick one account. This prevents
   * mid-conversation account switches that break cryptographic signatures
   * on thinking/memory blocks.
   *
   * When no clientSessionId is provided, always returns the first eligible
   * account (stable default).
   */
  getAccountForModelBySession(
    modelId: string,
    clientSessionId?: string,
  ): Account | undefined {
    const eligible = this.modelIndex.get(modelId)
    if (!eligible || eligible.length === 0) return undefined

    if (!clientSessionId) {
      return eligible[0]
    }

    return eligible.reduce((winner, candidate) => {
      const winnerScore = this.rendezvousScore(clientSessionId, winner.id)
      const candidateScore = this.rendezvousScore(clientSessionId, candidate.id)
      return candidateScore > winnerScore ? candidate : winner
    })
  }

  /**
   * Failover: pick the next account for a model, excluding the failed one.
   * Returns undefined if no alternative is available.
   */
  getNextAccountForModel(
    modelId: string,
    exclude: Account,
  ): Account | undefined {
    const eligible = this.modelIndex.get(modelId)
    if (!eligible || eligible.length === 0) return undefined

    const alternatives = eligible.filter((a) => a.id !== exclude.id)
    if (alternatives.length === 0) return undefined

    const index = this.roundRobinIndex % alternatives.length
    this.roundRobinIndex++
    return alternatives[index]
  }

  /**
   * Mark an account as unhealthy and rebuild the model index.
   */
  markUnhealthy(account: Account): void {
    account.healthy = false
    consola.warn(`Account #${account.id} marked unhealthy`)
    this.rebuildModelIndex()
  }

  /**
   * Return a merged, deduplicated ModelsResponse across all healthy accounts.
   * Deduplication is by model ID, keeping the first occurrence.
   */
  getAllModels(): ModelsResponse {
    const seen = new Set<string>()
    const mergedData: Array<Model> = []

    for (const account of this.accounts.values()) {
      if (!account.healthy) continue

      for (const model of account.modelsData) {
        if (!seen.has(model.id)) {
          seen.add(model.id)
          mergedData.push(model)
        }
      }
    }

    return {
      data: mergedData,
      object: "list",
    }
  }

  /**
   * Return the correct Copilot API base URL for an account's type.
   */
  getBaseUrl(account: Account): string {
    return account.accountType === "individual" ?
        "https://api.githubcopilot.com"
      : `https://api.${account.accountType}.githubcopilot.com`
  }

  /**
   * Clear all refresh timers.
   */
  dispose(): void {
    for (const timer of this.refreshTimers.values()) {
      clearInterval(timer)
    }
    this.refreshTimers.clear()
    consola.debug("TokenPool disposed, all refresh timers cleared")
  }

  /**
   * Get the number of registered accounts.
   */
  get size(): number {
    return this.accounts.size
  }

  /**
   * Get all registered accounts.
   */
  getAllAccounts(): Array<Account> {
    return [...this.accounts.values()]
  }

  getEligibleAccountIdsForModel(modelId: string): Array<number> {
    return (this.modelIndex.get(modelId) ?? [])
      .map((account) => account.id)
      .sort((left, right) => left - right)
  }

  getHealthyAccountIds(): Array<number> {
    return this.getAllAccounts()
      .filter((account) => account.healthy)
      .map((account) => account.id)
      .sort((left, right) => left - right)
  }

  getFirstHealthyAccount(): Account | undefined {
    return this.getAllAccounts().find((account) => account.healthy)
  }

  hasKnownModel(modelId: string): boolean {
    for (const account of this.accounts.values()) {
      if (account.models.has(modelId)) return true
    }
    return false
  }

  hasEnabledAccountForKnownModel(modelId: string): boolean | undefined {
    const eligible = this.modelIndex.get(modelId)
    if (eligible && eligible.length > 0) return true
    return this.hasKnownModel(modelId) ? false : undefined
  }

  getModelAccountAvailability(): Array<{
    model: Model
    accounts: Array<{
      accountId: number
      accountType: string
      enabled: boolean
      healthy: boolean
      overridden: boolean
    }>
  }> {
    const models = new Map<
      string,
      {
        model: Model
        accounts: Array<{
          accountId: number
          accountType: string
          enabled: boolean
          healthy: boolean
          overridden: boolean
        }>
      }
    >()

    for (const account of this.accounts.values()) {
      for (const model of account.modelsData) {
        let entry = models.get(model.id)
        if (!entry) {
          entry = { model, accounts: [] }
          models.set(model.id, entry)
        }

        const enabled = isModelEnabledForAccount(model.id, account.id)
        entry.accounts.push({
          accountId: account.id,
          accountType: account.accountType,
          enabled,
          healthy: account.healthy,
          overridden: hasModelRoutingOverride(model.id, account.id),
        })
      }
    }

    return [...models.values()].sort((a, b) =>
      a.model.id.localeCompare(b.model.id),
    )
  }

  // --- Private helpers ---

  private rendezvousScore(affinityKey: string, accountId: number): string {
    return createHash("sha256")
      .update(`${affinityKey}\0${accountId}`)
      .digest("hex")
  }

  private getHealthyCount(): number {
    let count = 0
    for (const account of this.accounts.values()) {
      if (account.healthy) count++
    }
    return count
  }

  private async resolveGitHubUsername(account: Account): Promise<void> {
    try {
      const user = await getGitHubUser(account.githubToken)
      // eslint-disable-next-line require-atomic-updates
      account.githubUsername = user.login
    } catch (error) {
      let detail = "Unknown error"
      if (error instanceof HTTPError) {
        detail = `HTTP ${error.response.status}`
      } else if (error instanceof Error) {
        detail = error.name
      }
      consola.warn(
        `Failed to resolve GitHub username for account #${account.id}: ${detail}`,
      )
    }
  }

  private async fetchCopilotToken(
    account: Account,
  ): Promise<CopilotTokenResponse> {
    const response = await fetch(
      `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
      {
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `token ${account.githubToken}`,
        },
      },
    )

    if (!response.ok) {
      throw new HTTPError(
        `Failed to get Copilot token for account #${account.id}`,
        response,
      )
    }

    return (await response.json()) as CopilotTokenResponse
  }

  private async fetchModels(
    account: Account,
    baseUrl: string,
  ): Promise<ModelsResponse> {
    const response = await fetch(
      `${baseUrl}/models`,
      createCopilotTransportInit({
        headers: this.buildCopilotHeaders(account),
      }),
    )

    if (!response.ok) {
      const errorBody = await response.text()
      consola.error(
        `Failed to fetch models for account #${account.id}: ${response.status} ${response.statusText}\n${errorBody}`,
      )
      throw new HTTPError(
        `Failed to fetch models for account #${account.id}: ${response.status}`,
        response,
      )
    }

    return (await response.json()) as ModelsResponse
  }

  private buildCopilotHeaders(account: Account): Record<string, string> {
    if (!account.copilotToken) {
      throw new Error(
        `Copilot token not set for account #${account.id}. Cannot build request headers.`,
      )
    }

    return {
      "content-type": "application/json",
      accept: "application/json",
      Authorization: `Bearer ${account.copilotToken}`,
      "Copilot-Integration-Id": INTEGRATION_ID,
      "editor-version": `vscode/${this.vsCodeVersion}`,
      "Openai-Intent": "conversation-agent",
      "X-GitHub-Api-Version": MODELS_API_VERSION,
      "X-Request-Id": randomUUID(),
      "X-Interaction-Id": this.sessionId,
      "X-Client-Session-Id": this.sessionId,
      "X-Interaction-Type": "conversation-agent",
    }
  }

  private setupRefreshTimer(
    account: Account,
    intervalMs: number,
    showToken: boolean,
  ): void {
    // Clear any existing timer for this account
    const existing = this.refreshTimers.get(account.id)
    if (existing) {
      clearInterval(existing)
    }

    const timer = setInterval(async () => {
      consola.debug(`Refreshing Copilot token for account #${account.id}`)
      try {
        const tokenData = await this.fetchCopilotToken(account)
        // eslint-disable-next-line require-atomic-updates
        account.copilotToken = tokenData.token
        // eslint-disable-next-line require-atomic-updates
        account.copilotTokenExpiry = tokenData.expires_at

        if (showToken) {
          consola.info(
            `Account #${account.id} refreshed Copilot token: ${maskTokenForLog(tokenData.token)}`,
          )
        }

        consola.debug(`Account #${account.id} Copilot token refreshed`)

        // If the account was unhealthy, mark it healthy and rebuild index
        if (!account.healthy) {
          account.healthy = true
          consola.info(`Account #${account.id} recovered, marking healthy`)
          this.rebuildModelIndex()
        }
      } catch (error) {
        consola.error(
          `Failed to refresh Copilot token for account #${account.id}:`,
          error,
        )
      }
    }, intervalMs)

    this.refreshTimers.set(account.id, timer)
  }
}

// --- Module-level singleton ---

export const tokenPool = new TokenPool()
