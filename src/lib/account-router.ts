import consola from "consola"

import type { RoutingAffinitySource } from "~/lib/routing-affinity"
import type { Account } from "~/lib/token-pool"
import type {
  CopilotHeaderOptions,
  CopilotTelemetryOptions,
} from "~/services/copilot/copilot-client"
import type { RetryBudget } from "~/services/copilot/transport-retry"

import { HTTPError, LocalHTTPError } from "~/lib/error"
import {
  getClientSessionId,
  getLastUsedRoutedAccountId,
  setLastUsedRoutedAccountId,
} from "~/lib/request-session"
import { getRoutingAffinity } from "~/lib/routing-affinity"
import {
  recordRoutingSelection,
  type RoutingSelectionMode,
  type UpstreamSendReason,
} from "~/lib/routing-telemetry"
import { state } from "~/lib/state"
import { tokenPool } from "~/lib/token-pool"
import { copilotFetch, copilotHeaders } from "~/services/copilot/copilot-client"
import {
  consumeExtraSend,
  createRetryBudget,
} from "~/services/copilot/transport-retry"

// --- Constants ---

const FAILOVER_STATUSES = new Set([401, 403, 429])

interface AccountFetchOptions {
  account: Account
  headerOptions: CopilotHeaderOptions | undefined
  init: RequestInit | undefined
  path: string
  maxHttpRetryDelaySeconds: number | undefined
  modelId: string
  retryBudget: RetryBudget
  reason: UpstreamSendReason
}

interface RoutedFetchContext {
  affinityKey?: string
  headerOptions: CopilotHeaderOptions | undefined
  init: RequestInit | undefined
  modelId: string
  maxHttpRetryDelaySeconds: number | undefined
  path: string
  reason: UpstreamSendReason
  recordSelection: boolean
  retryBudget: RetryBudget
}

function getEffectiveAffinityKey(): string | undefined {
  return getRoutingAffinity()?.key ?? getClientSessionId()
}

type RoutedFetchResult = {
  account: Account | undefined
  response: Response
}

function destinationForPath(path: string): string {
  switch (path) {
    case "/responses": {
      return "Responses"
    }
    case "/chat/completions": {
      return "Chat Completions"
    }
    case "/embeddings": {
      return "Embeddings"
    }
    case "/v1/messages": {
      return "Anthropic Messages"
    }
    default: {
      return path
    }
  }
}

function copilotTelemetry(options: {
  accountId?: number
  model: string
  path: string
  reason: UpstreamSendReason
}): CopilotTelemetryOptions {
  return {
    ...(options.accountId === undefined ?
      {}
    : { accountId: options.accountId }),
    destination: destinationForPath(options.path),
    model: options.model,
    provider: "GitHub Copilot",
    reason: options.reason,
  }
}

function recordSelection(options: {
  accountId: number
  affinitySource?: RoutingAffinitySource
  eligibleAccountIds: ReadonlyArray<number>
  mode: RoutingSelectionMode
  model: string
}): void {
  recordRoutingSelection(options)
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
  const {
    account,
    headerOptions,
    init,
    maxHttpRetryDelaySeconds,
    path,
    reason,
    retryBudget,
  } = options
  const headers = copilotHeaders({
    ...headerOptions,
    copilotToken: account.copilotToken,
  })
  const baseUrl = tokenPool.getBaseUrl(account)

  return await copilotFetch(
    path,
    { ...init, headers },
    {
      baseUrl,
      maxHttpRetryDelaySeconds,
      retryBudget,
      telemetry: copilotTelemetry({
        accountId: account.id,
        model: options.modelId,
        path,
        reason,
      }),
    },
  )
}

function createSessionAccountRejectedError(
  account: Account,
  afterReinitialization: boolean,
): LocalHTTPError {
  const message =
    afterReinitialization ?
      "The bound account rejected this conversation after successful account reinitialization; affinity was preserved and no cross-account retry was attempted."
    : "The bound account rejected this conversation; affinity was preserved and no cross-account retry was attempted."
  const clientBody = {
    error: {
      account_id: account.id,
      code: "session_account_rejected",
      message,
      type: "session_affinity_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 409 }),
    clientBody,
  )
}

function createAccountReinitializationFailedError(
  account: Account,
): LocalHTTPError {
  const clientBody = {
    error: {
      account_id: account.id,
      code: "account_reinitialization_failed",
      message:
        "The bound account could not be reinitialized; affinity was preserved and no cross-account retry was attempted.",
      type: "account_unavailable",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status: 503 }),
    clientBody,
  )
}

async function reinitializeAndRetryAccount(
  options: AccountFetchOptions,
): Promise<Response> {
  const { account, path, retryBudget } = options
  try {
    consola.warn(
      `[Account #${account.id}] HTTP 401 on ${path}, reinitializing account credentials and models`,
    )
    await tokenPool.reinitializeAccount(account, state.showToken)
  } catch (error) {
    consola.warn(
      `[Account #${account.id}] Account reinitialization failed after HTTP 401 on ${path}`,
      error instanceof HTTPError ?
        { status: error.response.status }
      : {
          errorClass: error instanceof Error ? error.name : "Unknown",
        },
    )
    throw createAccountReinitializationFailedError(account)
  }

  // The resend is an extra upstream send and is charged like any other.
  if (!consumeExtraSend(retryBudget)) {
    consola.warn(
      `[Account #${account.id}] Send budget exhausted after 401 on ${path}, not resending`,
    )
    return new Response(null, { status: 401 })
  }

  return await fetchWithAccount({ ...options, reason: "token_refresh" })
}

async function fetchWithFallbackAccount(
  context: RoutedFetchContext,
): Promise<RoutedFetchResult> {
  const { headerOptions, init, maxHttpRetryDelaySeconds, path, retryBudget } =
    context
  const account = tokenPool.getFirstHealthyAccount()
  if (account) {
    consola.warn(
      `Using Account #${account.id} as fallback for model "${context.modelId}"`,
    )
    setLastUsedRoutedAccountId(account.id)
    if (context.recordSelection) {
      recordSelection({
        accountId: account.id,
        eligibleAccountIds: tokenPool.getHealthyAccountIds(),
        mode: getEffectiveAffinityKey() ? "sticky" : "default",
        affinitySource: getRoutingAffinity()?.source,
        model: context.modelId,
      })
    }
    return await fetchWithRoutedAccount(context, account, context.reason)
  }

  const fallbackHeaders =
    state.copilotToken ?
      mergeHeaders(copilotHeaders(headerOptions), init?.headers)
    : init?.headers

  const response = await copilotFetch(
    path,
    {
      ...init,
      ...(fallbackHeaders ? { headers: fallbackHeaders } : {}),
    },
    {
      maxHttpRetryDelaySeconds,
      retryBudget,
      telemetry: copilotTelemetry({
        model: context.modelId,
        path,
        reason: context.reason,
      }),
    },
  )
  return { response, account: undefined }
}

async function failoverToAccount(
  context: RoutedFetchContext,
  currentAccount: Account,
  failedResponse: Response,
): Promise<RoutedFetchResult | undefined> {
  const {
    headerOptions,
    init,
    modelId,
    maxHttpRetryDelaySeconds,
    path,
    retryBudget,
  } = context
  const next = tokenPool.getNextAccountForModel(modelId, currentAccount)
  if (!next) {
    return undefined
  }

  consola.warn(
    `[Account #${currentAccount.id}] HTTP ${failedResponse.status} on ${path}, failing over to Account #${next.id}`,
  )
  // Failing over issues another upstream send, so it draws on the same budget.
  if (!consumeExtraSend(retryBudget)) {
    consola.warn(
      `[Account #${currentAccount.id}] Send budget exhausted on ${path}, not failing over`,
    )
    return undefined
  }

  setLastUsedRoutedAccountId(next.id)

  const response = await fetchWithAccount({
    account: next,
    headerOptions,
    init,
    maxHttpRetryDelaySeconds,
    modelId,
    path,
    reason: "failover",
    retryBudget,
  })
  return { response, account: next }
}

async function fetchWithRoutedAccount(
  context: RoutedFetchContext,
  account: Account,
  reason: UpstreamSendReason = "initial",
): Promise<RoutedFetchResult> {
  const { headerOptions, init, maxHttpRetryDelaySeconds, path, retryBudget } =
    context

  let response = await fetchWithAccount({
    account,
    headerOptions,
    init,
    maxHttpRetryDelaySeconds,
    modelId: context.modelId,
    path,
    reason,
    retryBudget,
  })

  if (response.status === 401) {
    response = await reinitializeAndRetryAccount({
      account,
      headerOptions,
      init,
      maxHttpRetryDelaySeconds,
      modelId: context.modelId,
      path,
      reason: "token_refresh",
      retryBudget,
    })
  }

  if (
    context.affinityKey
    && (response.status === 401 || response.status === 403)
  ) {
    throw createSessionAccountRejectedError(account, response.status === 401)
  }
  if (context.affinityKey) {
    return { response, account }
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
  maxHttpRetryDelaySeconds?: number
  reason?: UpstreamSendReason
  recordSelection?: boolean
}

/**
 * Perform a fetch with account-aware routing and single-attempt failover.
 *
 * In single-token mode, builds headers from headerOptions and delegates
 * to `copilotFetch`.
 * In multi-token mode, selects an account for the requested model,
 * builds headers with that account's token, issues the request, and on
 * unidentified 401/403/429 attempts one failover to an alternative account.
 * Identified conversations never move away from their hash-selected account.
 *
 * Transport failures are NOT failed over. `copilotFetch` retries them in
 * place; every account resolves to the same Copilot host, so switching
 * accounts reuses the same connection pool and only duplicates the send.
 *
 * Callers should NOT pre-build headers — this function handles header
 * construction in all modes to avoid double-advancing the round-robin.
 */
export async function routedFetch(
  path: string,
  init: RequestInit | undefined,
  options: RoutedFetchOptions,
): Promise<{ response: Response; account: Account | undefined }> {
  const {
    modelId,
    headerOptions,
    maxHttpRetryDelaySeconds,
    reason = "initial",
    recordSelection: shouldRecordSelection = true,
  } = options
  // Two extra sends for the whole routed call (a three-send ceiling) so sends
  // cannot multiply across the initial account, a 401 refresh-and-retry, and a
  // 401/403/429 failover.
  const retryBudget = createRetryBudget()
  const context: RoutedFetchContext = {
    affinityKey: getEffectiveAffinityKey(),
    headerOptions,
    init,
    modelId,
    maxHttpRetryDelaySeconds,
    path,
    reason,
    recordSelection: shouldRecordSelection,
    retryBudget,
  }
  setLastUsedRoutedAccountId(undefined)

  if (!state.isMultiToken) {
    const headers = copilotHeaders(headerOptions)
    if (shouldRecordSelection) {
      recordRoutingSelection({
        eligibleAccountIds: [],
        mode: "single",
        model: modelId,
      })
    }
    const response = await copilotFetch(
      path,
      { ...init, headers },
      {
        maxHttpRetryDelaySeconds,
        retryBudget,
        telemetry: copilotTelemetry({
          model: modelId,
          path,
          reason,
        }),
      },
    )
    return { response, account: undefined }
  }

  const affinityKey = getEffectiveAffinityKey()
  const account = tokenPool.getAccountForModelBySession(modelId, affinityKey)
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
    `[Account #${account.id}] ${path} (model: ${modelId}, session: ${affinityKey ? "sticky" : "default"})`,
  )
  setLastUsedRoutedAccountId(account.id)
  if (shouldRecordSelection) {
    recordSelection({
      accountId: account.id,
      affinitySource: getRoutingAffinity()?.source,
      eligibleAccountIds: tokenPool.getEligibleAccountIdsForModel(modelId),
      mode: affinityKey ? "sticky" : "default",
      model: modelId,
    })
  }

  return await fetchWithRoutedAccount(context, account, reason)
}
