import consola from "consola"

import type { Account } from "~/lib/token-pool"
import type { CopilotHeaderOptions } from "~/services/copilot/copilot-client"

import {
  getClientSessionId,
  getLastUsedRoutedAccountId,
  setLastUsedRoutedAccountId,
} from "~/lib/request-session"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { copilotFetch, copilotHeaders } from "~/services/copilot/copilot-client"

// --- Constants ---

const FAILOVER_STATUSES = new Set([401, 403, 429])

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  const causeMessage =
    error.cause instanceof Error ? error.cause.message.toLowerCase() : ""

  return (
    error.name === "AbortError"
    || message.includes("aborted")
    || causeMessage.includes("aborted")
  )
}

function mergeHeaders(
  baseHeaders: Record<string, string>,
  overrideHeaders: RequestInit["headers"],
): Record<string, string> {
  const merged = { ...baseHeaders }
  if (!overrideHeaders) {
    return merged
  }

  const overrides = new Headers(overrideHeaders)
  for (const [key, value] of overrides.entries()) {
    merged[key] = value
  }

  return merged
}

function createNoEnabledAccountResponse(modelId: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `No enabled account is available for model "${modelId}"`,
        type: "model_routing_error",
      },
    }),
    {
      status: 403,
      headers: { "content-type": "application/json" },
    },
  )
}

// --- Last used account tracking ---

/**
 * Get the account ID used by the most recent routedFetch call.
 * Useful for logging without changing service return types.
 */
export function getLastUsedAccountId(): number | undefined {
  return getLastUsedRoutedAccountId()
}

// --- Fetch routing with failover ---

export interface RoutedFetchOptions {
  modelId: string
  headerOptions?: CopilotHeaderOptions
}

/**
 * Perform a fetch with account-aware routing and single-attempt failover.
 *
 * In single-token mode, builds headers from headerOptions and delegates
 * to `copilotFetch`.
 * In multi-token mode, selects an account for the requested model,
 * builds headers with that account's token, issues the request, and on
 * 401/403/429 or network error attempts one failover to an alternative
 * account.
 *
 * Callers should NOT pre-build headers — this function handles header
 * construction in all modes to avoid double-advancing the round-robin.
 */
export async function routedFetch(
  path: string,
  init: RequestInit | undefined,
  options: RoutedFetchOptions,
): Promise<{ response: Response; account: Account | undefined }> {
  const { modelId, headerOptions } = options
  setLastUsedRoutedAccountId(undefined)

  if (!state.isMultiToken) {
    const headers = copilotHeaders(headerOptions)
    const response = await copilotFetch(path, { ...init, headers })
    return { response, account: undefined }
  }

  const clientSessionId = getClientSessionId()
  const account = tokenPool.getAccountForModelBySession(
    modelId,
    clientSessionId,
  )
  if (!account) {
    if (tokenPool.hasKnownModel(modelId)) {
      const response = createNoEnabledAccountResponse(modelId)
      return { response, account: undefined }
    }

    consola.warn(
      `No account found for model "${modelId}", falling back to default`,
    )

    const fallbackHeaders =
      state.copilotToken ?
        mergeHeaders(copilotHeaders(headerOptions), init?.headers)
      : init?.headers

    const response = await copilotFetch(path, {
      ...init,
      ...(fallbackHeaders ? { headers: fallbackHeaders } : {}),
    })
    return { response, account: undefined }
  }

  const headers = copilotHeaders({
    ...headerOptions,
    copilotToken: account.copilotToken,
  })
  const baseUrl = tokenPool.getBaseUrl(account)

  consola.debug(
    `[Account #${account.id}] ${path} (model: ${modelId}, session: ${clientSessionId ? "sticky" : "default"})`,
  )
  setLastUsedRoutedAccountId(account.id)

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
        setLastUsedRoutedAccountId(next.id)

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
    if (isAbortError(error)) {
      throw error
    }

    // Network error — attempt failover
    const next = tokenPool.getNextAccountForModel(modelId, account)
    if (next) {
      consola.warn(
        `[Account #${account.id}] Network error on ${path}, failing over to Account #${next.id}: ${(error as Error).message}`,
      )
      setLastUsedRoutedAccountId(next.id)

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
