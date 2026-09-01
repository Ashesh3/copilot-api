import consola from "consola"
import { createHash } from "node:crypto"

import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import {
  DEFAULT_GITHUB_DOMAIN,
  normalizeGitHubDomain,
  resolveCopilotApiBaseUrl,
} from "~/lib/github-instance"
import {
  hasModelRoutingOverride,
  isModelEnabledForAccount,
} from "~/lib/model-routing"
import { state } from "~/lib/state"
import { resolveCopilotOAuth } from "~/services/github/resolve-copilot-oauth"

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

  constructor(onModelsChanged?: ModelsSnapshotListener) {
    this.onModelsChanged = onModelsChanged
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

  /** Resolve a GitHub OAuth credential and fetch its available models. */
  async initializeAccount(account: Account, showToken = false): Promise<void> {
    await this.initializeOAuthAccount(account, false, showToken)
  }

  /**
   * Re-resolve credentials and refresh model eligibility as one atomic update.
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

  /** Clear pending account reinitializations. */
  dispose(): void {
    this.accountReinitializations.clear()
    consola.debug("TokenPool disposed")
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

  private async performAccountReinitialization(
    account: Account,
    showToken: boolean,
  ): Promise<void> {
    await this.initializeOAuthAccount(account, true, showToken)
  }

  private async initializeOAuthAccount(
    account: Account,
    publishModels = false,
    showToken = false,
  ): Promise<void> {
    const resolved = await resolveCopilotOAuth({
      accountType: account.accountType,
      githubToken: account.githubToken,
      instanceDomain: account.githubInstanceDomain,
    })
    const modelsData = resolved.models.data

    // Commit only after both control-plane requests succeed.

    Object.assign(account, {
      copilotApiBaseUrl: resolved.baseUrl,
      copilotToken: resolved.token,
      copilotTokenExpiry: undefined,
      githubUsername: resolved.login ?? account.githubUsername,
      healthy: true,
      models: new Set(modelsData.map((model) => model.id)),
      modelsData,
    })

    this.rebuildModelIndex()
    if (publishModels) this.onModelsChanged?.(this.getAllModels())
    if (showToken) {
      consola.info(
        `Account #${account.id} Copilot token: ${maskTokenForLog(resolved.token)}`,
      )
    }
    consola.info(
      `Account #${account.id} (${account.accountType}): ${account.models.size} models available`,
    )
  }
}

// --- Module-level singleton ---

export const tokenPool = new TokenPool((models) => {
  state.models = models
})
