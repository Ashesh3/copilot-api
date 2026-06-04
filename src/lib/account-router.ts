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

interface AccountFetchOptions {
  account: Account
  headerOptions: CopilotHeaderOptions | undefined
  init: RequestInit | undefined
  path: string
}

interface RoutedFetchContext {
  headerOptions: CopilotHeaderOptions | undefined
  init: RequestInit | undefined
  modelId: string
  path: string
}

type RoutedFetchResult = {
  account: Account | undefined
  response: Response
}

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

async function fetchWithAccount(
  options: AccountFetchOptions,
): Promise<Response> {
  const { account, headerOptions, init, path } = options
  const headers = copilotHeaders({
    ...headerOptions,
    copilotToken: account.copilotToken,
  })
  const baseUrl = tokenPool.getBaseUrl(account)

  return await copilotFetch(path, { ...init, headers }, { baseUrl })
}

async function refreshAndRetryAccount(
  options: AccountFetchOptions,
): Promise<Response | undefined> {
  const { account, path } = options
  try {
    consola.warn(
      `[Account #${account.id}] HTTP 401 on ${path}, refreshing Copilot token`,
    )
    await tokenPool.refreshAccountToken(account, state.showToken)
  } catch (error) {
    consola.warn(
      `[Account #${account.id}] Failed to refresh Copilot token after 401 on ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }

  return await fetchWithAccount(options)
}

async function fetchWithFallbackAccount(
  context: RoutedFetchContext,
): Promise<RoutedFetchResult> {
  const { headerOptions, init, path } = context
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

async function failoverToAccount(
  context: RoutedFetchContext,
  currentAccount: Account,
  failedResponse: Response,
): Promise<RoutedFetchResult | undefined> {
  const { headerOptions, init, modelId, path } = context
  const next = tokenPool.getNextAccountForModel(modelId, currentAccount)
  if (!next) {
    return undefined
  }

  consola.warn(
    `[Account #${currentAccount.id}] HTTP ${failedResponse.status} on ${path}, failing over to Account #${next.id}`,
  )
  if (failedResponse.status === 401 || failedResponse.status === 403) {
    tokenPool.markUnhealthy(currentAccount)
  }
  setLastUsedRoutedAccountId(next.id)

  const response = await fetchWithAccount({
    account: next,
    headerOptions,
    init,
    path,
  })
  return { response, account: next }
}

async function fetchWithRoutedAccount(
  context: RoutedFetchContext,
  account: Account,
): Promise<RoutedFetchResult> {
  const { headerOptions, init, path } = context

  let response = await fetchWithAccount({
    account,
    headerOptions,
    init,
    path,
  })

  if (response.status === 401) {
    response =
      (await refreshAndRetryAccount({ account, headerOptions, init, path }))
      ?? response
  }

  if (!FAILOVER_STATUSES.has(response.status)) {
    return { response, account }
  }

  return (
    (await failoverToAccount(context, account, response)) ?? {
      response,
      account,
    }
  )
}

async function failoverAfterNetworkError(
  context: RoutedFetchContext,
  account: Account,
  error: unknown,
): Promise<RoutedFetchResult | undefined> {
  const { headerOptions, init, modelId, path } = context
  const next = tokenPool.getNextAccountForModel(modelId, account)
  if (!next) {
    return undefined
  }

  consola.warn(
    `[Account #${account.id}] Network error on ${path}, failing over to Account #${next.id}: ${(error as Error).message}`,
  )
  setLastUsedRoutedAccountId(next.id)

  const response = await fetchWithAccount({
    account: next,
    headerOptions,
    init,
    path,
  })
  return { response, account: next }
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
  const context: RoutedFetchContext = { headerOptions, init, modelId, path }
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

    return await fetchWithFallbackAccount(context)
  }

  consola.debug(
    `[Account #${account.id}] ${path} (model: ${modelId}, session: ${clientSessionId ? "sticky" : "default"})`,
  )
  setLastUsedRoutedAccountId(account.id)

  try {
    return await fetchWithRoutedAccount(context, account)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }

    const result = await failoverAfterNetworkError(context, account, error)
    if (result) return result

    // No alternative — re-throw the original error
    throw error
  }
}
