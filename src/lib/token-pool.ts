import consola from "consola"
import { createHash, randomUUID } from "node:crypto"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import { GITHUB_USER_AGENT } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  DEFAULT_GITHUB_DOMAIN,
  githubApiBaseUrl,
  isGitHubEnterpriseCloud,
  normalizeGitHubDomain,
  resolveCopilotApiBaseUrl,
} from "~/lib/github-instance"
import {
  hasModelRoutingOverride,
  isModelEnabledForAccount,
} from "~/lib/model-routing"
import { state } from "~/lib/state"
import { COPILOT_API_VERSION } from "~/services/copilot/copilot-contract"
import { createCopilotTransportInit } from "~/services/copilot/transport-options"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getGitHubUser } from "~/services/github/get-user"

// --- Account ---

export interface Account {
  id: number
  githubToken: string
  githubInstanceDomain: string
  githubUsername?: string
  copilotToken?: string
  copilotTokenExpiry?: number
  copilotApiBaseUrl?: string
  models: Set<string>
  modelsData: Array<Model>
  accountType: string
  healthy: boolean
}

interface AddAccountOptions {
  accountType: string
  githubInstanceDomain?: string
  id: number
}

type ModelsSnapshotListener = (models: ModelsResponse) => void

function hasModelId(value: unknown): value is Model {
  return (
    typeof value === "object"
    && value !== null
    && "id" in value
    && typeof value.id === "string"
    && value.id.length > 0
  )
}

// --- Copilot Token Response ---

interface CopilotTokenResponse {
  endpoints?: {
    api?: string
  }
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
  private accountReinitializations: Map<number, Promise<void>> = new Map()
  private accounts: Map<number, Account> = new Map()
  private modelIndex: Map<string, Array<Account>> = new Map()
  private readonly onModelsChanged: ModelsSnapshotListener | undefined
  private roundRobinIndex = 0
  private refreshTimers: Map<number, ReturnType<typeof setInterval>> = new Map()
  private sessionId: string = randomUUID()
  private vsCodeVersion = "1.104.3"

  constructor(onModelsChanged?: ModelsSnapshotListener) {
    this.onModelsChanged = onModelsChanged
  }

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
  addAccount(
    githubToken: string,
    accountTypeOrOptions: string | AddAccountOptions,
    id?: number,
  ): Account {
    const options: AddAccountOptions =
      typeof accountTypeOrOptions === "string" ?
        {
          accountType: accountTypeOrOptions,
          id: id ?? this.accounts.size,
        }
      : accountTypeOrOptions
    const account: Account = {
      id: options.id,
      githubToken,
      githubInstanceDomain: normalizeGitHubDomain(
        options.githubInstanceDomain ?? DEFAULT_GITHUB_DOMAIN,
      ),
      accountType: options.accountType,
      models: new Set(),
      modelsData: [],
      healthy: false,
    }
    this.accounts.set(options.id, account)
    return account
  }

  /**
   * Exchange a GitHub token for a Copilot token, fetch available models,
   * and set up an auto-refresh timer.
   */
  async initializeAccount(account: Account, showToken = false): Promise<void> {
    if (isGitHubEnterpriseCloud(account.githubInstanceDomain)) {
      await this.initializeEnterpriseAccount(account)
      return
    }

    const tokenData = this.validateCopilotTokenResponse(
      await this.fetchCopilotToken(account),
    )
    const copilotApiBaseUrl = this.resolveCopilotApiBaseUrl(account, tokenData)

    const modelsResponse = await this.fetchModels(
      account,
      copilotApiBaseUrl,
      tokenData.token,
    )
    const modelsData = this.validateModelsResponse(modelsResponse)

    // Commit only after both control-plane requests succeed.
    // eslint-disable-next-line require-atomic-updates
    account.copilotToken = tokenData.token
    // eslint-disable-next-line require-atomic-updates
    account.copilotTokenExpiry = tokenData.expires_at
    // eslint-disable-next-line require-atomic-updates
    account.copilotApiBaseUrl = copilotApiBaseUrl
    // eslint-disable-next-line require-atomic-updates
    account.modelsData = modelsData
    // eslint-disable-next-line require-atomic-updates
    account.models = new Set(modelsData.map((model) => model.id))
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
    if (isGitHubEnterpriseCloud(account.githubInstanceDomain)) {
      await this.reinitializeAccount(account, showToken)
      return
    }

    const tokenData = this.validateCopilotTokenResponse(
      await this.fetchCopilotToken(account),
    )
    const copilotApiBaseUrl = this.resolveCopilotApiBaseUrl(account, tokenData)

    account.copilotToken = tokenData.token

    account.copilotTokenExpiry = tokenData.expires_at

    account.copilotApiBaseUrl = copilotApiBaseUrl

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
   * Re-exchange credentials and refresh model eligibility as one atomic update.
   * Concurrent callers for the same account share the same control-plane work.
   */
  async reinitializeAccount(
    account: Account,
    showToken = false,
  ): Promise<void> {
    const existing = this.accountReinitializations.get(account.id)
    if (existing) {
      await existing
      return
    }

    const current = this.performAccountReinitialization(account, showToken)
    this.accountReinitializations.set(account.id, current)
    try {
      await current
    } finally {
      if (this.accountReinitializations.get(account.id) === current) {
        this.accountReinitializations.delete(account.id)
      }
    }
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

    return this.selectAccountBySession(eligible, clientSessionId)
  }

  /** Return a detached view of the healthy, enabled accounts for a model. */
  getEligibleAccountsForModel(modelId: string): Array<Account> {
    return [...(this.modelIndex.get(modelId) ?? [])]
  }

  /** Select deterministically from an explicit request-local candidate set. */
  selectAccountBySession(
    accounts: ReadonlyArray<Account>,
    clientSessionId?: string,
  ): Account | undefined {
    const first = accounts.at(0)
    if (!first || !clientSessionId) return first

    let winner = first
    let winnerScore = this.rendezvousScore(clientSessionId, winner.id)
    for (const candidate of accounts.slice(1)) {
      const candidateScore = this.rendezvousScore(clientSessionId, candidate.id)
      if (candidateScore > winnerScore) {
        winner = candidate
        winnerScore = candidateScore
      }
    }
    return winner
  }

  /**
   * Select a healthy account for a control-plane request.
   *
   * This is deterministic for identified sessions and does not retain a
   * session-to-account mapping.
   */
  getHealthyAccountBySession(clientSessionId?: string): Account | undefined {
    const healthy = this.getAllAccounts().filter((account) => account.healthy)
    return this.selectAccountBySession(healthy, clientSessionId)
  }

  /**
   * Select a healthy account whose raw catalog advertises the model.
   *
   * Policy calls deliberately ignore inference routing overrides and the
   * derived model index because they are used to enable catalog models.
   */
  getAccountAdvertisingModelBySession(
    modelId: string,
    clientSessionId?: string,
  ): Account | undefined {
    const advertising = this.getAllAccounts().filter(
      (account) => account.healthy && account.models.has(modelId),
    )
    return this.selectAccountBySession(advertising, clientSessionId)
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
   * Fail over only to an account whose raw catalog advertises the endpoint
   * chosen for this request. Missing endpoint metadata retains the documented
   * legacy Chat Completions assumption.
   */
  getNextAccountForModelEndpoint(
    modelId: string,
    endpoint: string,
    exclude: Account,
  ): Account | undefined {
    const eligible = this.modelIndex.get(modelId)
    if (!eligible || eligible.length === 0) return undefined

    const alternatives = eligible.filter(
      (account) =>
        account.id !== exclude.id
        && this.accountAdvertisesModelEndpoint(account, modelId, endpoint),
    )
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
    return resolveCopilotApiBaseUrl(
      account.githubInstanceDomain,
      account.copilotApiBaseUrl,
      account.accountType,
    )
  }

  /**
   * Clear all refresh timers.
   */
  dispose(): void {
    for (const timer of this.refreshTimers.values()) {
      clearInterval(timer)
    }
    this.refreshTimers.clear()
    this.accountReinitializations.clear()
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

  removeAccountForTest(accountId: number): void {
    const timer = this.refreshTimers.get(accountId)
    if (timer) clearInterval(timer)
    this.refreshTimers.delete(accountId)
    this.accounts.delete(accountId)
    this.rebuildModelIndex()
  }

  getEligibleAccountIdsForModel(modelId: string): Array<number> {
    return (this.modelIndex.get(modelId) ?? [])
      .map((account) => account.id)
      .sort((left, right) => left - right)
  }

  getEligibleAccountForModel(
    modelId: string,
    accountId: number,
  ): Account | undefined {
    return (this.modelIndex.get(modelId) ?? []).find(
      (account) => account.id === accountId,
    )
  }

  getModelForAccount(modelId: string, accountId: number): Model | undefined {
    return this.accounts
      .get(accountId)
      ?.modelsData.find((model) => model.id === modelId)
  }

  accountAdvertisesModelEndpoint(
    account: Account,
    modelId: string,
    endpoint: string,
  ): boolean {
    const model = account.modelsData.find(
      (candidate) => candidate.id === modelId,
    )
    if (!model) return false
    return model.supported_endpoints ?
        model.supported_endpoints.includes(endpoint)
      : endpoint === "/chat/completions"
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
      const user = await getGitHubUser(
        account.githubToken,
        account.githubInstanceDomain,
      )
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

  private async performAccountReinitialization(
    account: Account,
    showToken: boolean,
  ): Promise<void> {
    if (isGitHubEnterpriseCloud(account.githubInstanceDomain)) {
      await this.initializeEnterpriseAccount(account, true)
      return
    }

    const tokenData = this.validateCopilotTokenResponse(
      await this.fetchCopilotToken(account),
    )
    const copilotApiBaseUrl = this.resolveCopilotApiBaseUrl(account, tokenData)
    const modelsResponse = await this.fetchModels(
      account,
      copilotApiBaseUrl,
      tokenData.token,
    )
    const modelsData = this.validateModelsResponse(modelsResponse)
    const models = new Set(modelsData.map((model) => model.id))

    // Commit only after both control-plane requests succeed.
    // eslint-disable-next-line require-atomic-updates
    account.copilotToken = tokenData.token
    // eslint-disable-next-line require-atomic-updates
    account.copilotTokenExpiry = tokenData.expires_at
    // eslint-disable-next-line require-atomic-updates
    account.copilotApiBaseUrl = copilotApiBaseUrl
    // eslint-disable-next-line require-atomic-updates
    account.modelsData = modelsData
    // eslint-disable-next-line require-atomic-updates
    account.models = models
    // eslint-disable-next-line require-atomic-updates
    account.healthy = true

    if (showToken) {
      consola.info(
        `Account #${account.id} reinitialized Copilot token: ${maskTokenForLog(tokenData.token)}`,
      )
    }

    this.rebuildModelIndex()
    this.onModelsChanged?.(this.getAllModels())
    this.setupRefreshTimer(
      account,
      getTokenRefreshIntervalMs(tokenData.refresh_in),
      showToken,
    )
  }

  private validateCopilotTokenResponse(
    response: unknown,
  ): CopilotTokenResponse {
    if (
      typeof response !== "object"
      || response === null
      || !("token" in response)
      || typeof response.token !== "string"
      || response.token.length === 0
      || !("expires_at" in response)
      || typeof response.expires_at !== "number"
      || !Number.isFinite(response.expires_at)
      || !("refresh_in" in response)
      || typeof response.refresh_in !== "number"
      || !Number.isFinite(response.refresh_in)
    ) {
      throw new TypeError("Invalid Copilot token response")
    }
    return response as CopilotTokenResponse
  }

  private resolveCopilotApiBaseUrl(
    account: Account,
    response: CopilotTokenResponse,
  ): string {
    return resolveCopilotApiBaseUrl(
      account.githubInstanceDomain,
      response.endpoints?.api,
      account.accountType,
    )
  }

  private async initializeEnterpriseAccount(
    account: Account,
    publishModels = false,
  ): Promise<void> {
    const copilotUser = await getCopilotUsage(
      account.githubToken,
      account.githubInstanceDomain,
    )
    const copilotApiBaseUrl = resolveCopilotApiBaseUrl(
      account.githubInstanceDomain,
      copilotUser.endpoints?.api,
      "enterprise",
    )
    const modelsResponse = await this.fetchModels(
      account,
      copilotApiBaseUrl,
      account.githubToken,
    )
    const modelsData = this.validateModelsResponse(modelsResponse)

    // Commit only after both control-plane requests succeed.

    account.copilotToken = account.githubToken

    account.copilotTokenExpiry = undefined

    account.copilotApiBaseUrl = copilotApiBaseUrl

    account.modelsData = modelsData

    account.models = new Set(modelsData.map((model) => model.id))

    account.healthy = true

    account.githubUsername = copilotUser.login ?? account.githubUsername

    this.clearRefreshTimer(account.id)
    this.rebuildModelIndex()
    if (publishModels) this.onModelsChanged?.(this.getAllModels())
    consola.info(
      `Account #${account.id} (${account.accountType}): ${account.models.size} models available`,
    )
  }

  private validateModelsResponse(response: unknown): Array<Model> {
    if (
      typeof response !== "object"
      || response === null
      || !("object" in response)
      || response.object !== "list"
      || !("data" in response)
      || !Array.isArray(response.data)
      || !response.data.every((model: unknown) => hasModelId(model))
    ) {
      throw new TypeError("Invalid Copilot models response")
    }
    return response.data
  }

  private async fetchCopilotToken(
    account: Account,
  ): Promise<CopilotTokenResponse> {
    const response = await fetch(
      `${githubApiBaseUrl(account.githubInstanceDomain)}/copilot_internal/v2/token`,
      {
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `token ${account.githubToken}`,
          "user-agent": GITHUB_USER_AGENT,
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
    copilotToken = account.copilotToken,
  ): Promise<ModelsResponse> {
    const response = await fetch(
      `${baseUrl}/models`,
      createCopilotTransportInit({
        headers: this.buildCopilotHeaders(account, copilotToken),
      }),
    )

    if (!response.ok) {
      consola.error(
        `Failed to fetch models for account #${account.id}: ${response.status} ${response.statusText}`,
      )
      throw new HTTPError(
        `Failed to fetch models for account #${account.id}: ${response.status}`,
        response,
      )
    }

    return (await response.json()) as ModelsResponse
  }

  private buildCopilotHeaders(
    account: Account,
    copilotToken = account.copilotToken,
  ): Record<string, string> {
    if (!copilotToken) {
      throw new Error(
        `Copilot token not set for account #${account.id}. Cannot build request headers.`,
      )
    }

    return {
      "content-type": "application/json",
      accept: "application/json",
      Authorization: `Bearer ${copilotToken}`,
      "Copilot-Integration-Id": state.copilotIntegrationId,
      "Copilot-Harness-Id": "copilot-sdk",
      "editor-version": `vscode/${this.vsCodeVersion}`,
      "Openai-Intent": "conversation-agent",
      "X-GitHub-Api-Version": COPILOT_API_VERSION,
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
    this.clearRefreshTimer(account.id)

    const timer = setInterval(() => {
      consola.debug(`Reinitializing account #${account.id}`)
      void this.reinitializeAccount(account, showToken).catch(
        (error: unknown) => {
          consola.error(`Failed to reinitialize account #${account.id}`, {
            errorClass: error instanceof Error ? error.name : "Unknown",
          })
        },
      )
    }, intervalMs)

    this.refreshTimers.set(account.id, timer)
  }

  private clearRefreshTimer(accountId: number): void {
    const existing = this.refreshTimers.get(accountId)
    if (existing) clearInterval(existing)
    this.refreshTimers.delete(accountId)
  }
}

// --- Module-level singleton ---

export const tokenPool = new TokenPool((models) => {
  state.models = models
})
