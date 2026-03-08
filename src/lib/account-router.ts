import consola from "consola"

import type { Account } from "~/lib/token-pool"
import type { CopilotHeaderOptions } from "~/services/copilot/copilot-client"

import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { copilotFetch, copilotHeaders } from "~/services/copilot/copilot-client"

// --- Constants ---

const FAILOVER_STATUSES = new Set([401, 403, 429])

// --- Header routing ---

/**
 * Build Copilot headers, optionally routing through a specific account
 * when multi-token mode is active.
 */
export function getHeadersForModel(
  modelId: string,
  headerOptions?: CopilotHeaderOptions,
): { headers: Record<string, string>; account: Account | undefined } {
  if (!state.isMultiToken) {
    return { headers: copilotHeaders(headerOptions), account: undefined }
  }

  const account = tokenPool.getAccountForModel(modelId)
  if (!account) {
    // No account has this model — fall back to default
    return { headers: copilotHeaders(headerOptions), account: undefined }
  }

  const headers = copilotHeaders({
    ...headerOptions,
    copilotToken: account.copilotToken,
  })

  return { headers, account }
}

// --- Fetch routing with failover ---

export interface RoutedFetchOptions {
  modelId: string
  headerOptions?: CopilotHeaderOptions
}

/**
 * Perform a fetch with account-aware routing and single-attempt failover.
 *
 * In single-token mode, delegates directly to `copilotFetch`.
 * In multi-token mode, selects an account for the requested model,
 * issues the request, and on 401/403/429 or network error attempts
 * one failover to an alternative account.
 */
export async function routedFetch(
  path: string,
  init: RequestInit | undefined,
  options: RoutedFetchOptions,
): Promise<{ response: Response; account: Account | undefined }> {
  const { modelId, headerOptions } = options
  if (!state.isMultiToken) {
    const response = await copilotFetch(path, init)
    return { response, account: undefined }
  }

  const account = tokenPool.getAccountForModel(modelId)
  if (!account) {
    consola.warn(
      `No account found for model "${modelId}", falling back to default`,
    )
    const response = await copilotFetch(path, init)
    return { response, account: undefined }
  }

  const headers = copilotHeaders({
    ...headerOptions,
    copilotToken: account.copilotToken,
  })
  const baseUrl = tokenPool.getBaseUrl(account)

  consola.debug(`[Account #${account.id}] ${path} (model: ${modelId})`)

  try {
    const response = await copilotFetch(path, { ...init, headers }, { baseUrl })

    if (FAILOVER_STATUSES.has(response.status)) {
      const next = tokenPool.getNextAccountForModel(modelId, account)
      if (next) {
        consola.warn(
          `[Account #${account.id}] HTTP ${response.status} on ${path}, failing over to Account #${next.id}`,
        )
        if (response.status === 401 || response.status === 403) {
          tokenPool.markUnhealthy(account)
        }

        const retryHeaders = copilotHeaders({
          ...headerOptions,
          copilotToken: next.copilotToken,
        })
        const retryBaseUrl = tokenPool.getBaseUrl(next)
        const retryResponse = await copilotFetch(
          path,
          { ...init, headers: retryHeaders },
          { baseUrl: retryBaseUrl },
        )
        return { response: retryResponse, account: next }
      }

      // No alternative account available — return original response
      return { response, account }
    }

    return { response, account }
  } catch (error) {
    // Network error — attempt failover
    const next = tokenPool.getNextAccountForModel(modelId, account)
    if (next) {
      consola.warn(
        `[Account #${account.id}] Network error on ${path}, failing over to Account #${next.id}: ${(error as Error).message}`,
      )

      const retryHeaders = copilotHeaders({
        ...headerOptions,
        copilotToken: next.copilotToken,
      })
      const retryBaseUrl = tokenPool.getBaseUrl(next)
      const retryResponse = await copilotFetch(
        path,
        { ...init, headers: retryHeaders },
        { baseUrl: retryBaseUrl },
      )
      return { response: retryResponse, account: next }
    }

    // No alternative — re-throw the original error
    throw error
  }
}
