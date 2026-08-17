import { AsyncLocalStorage } from "node:async_hooks"

import { getRoutingAffinity } from "~/lib/routing-affinity"

/**
 * Request-scoped storage for the client session ID.
 *
 * The `X-Claude-Code-Session-Id` header is captured by middleware and stored
 * here so that downstream code (e.g. account-router) can read it without
 * threading it through every function signature.
 */
export const clientSessionStorage = new AsyncLocalStorage<string | undefined>()
export const requestIdStorage = new AsyncLocalStorage<string | undefined>()
export const copilotResponseHeadersStorage = new AsyncLocalStorage<
  Record<string, string>
>()
export const quotaHeadersStorage = copilotResponseHeadersStorage
export const routedAccountStorage = new AsyncLocalStorage<{
  lastUsedAccountId?: number
}>()

export interface RoutingTelemetryRequestState {
  sourceProtocol: string
  dispatched?: boolean
  lastDestination?: string
  lastModel?: string
  lastProvider?: string
  requestRecorded?: boolean
}

export const routingTelemetryStorage =
  new AsyncLocalStorage<RoutingTelemetryRequestState>()

export function createRoutingTelemetryRequestState(
  sourceProtocol: string,
): RoutingTelemetryRequestState {
  return { sourceProtocol }
}

export function getRoutingTelemetryRequestState():
  | RoutingTelemetryRequestState
  | undefined {
  return routingTelemetryStorage.getStore()
}

export function updateRoutingTelemetryRequestState(options: {
  destination: string
  model: string
  provider: string
}): void {
  const telemetryState = getRoutingTelemetryRequestState()
  if (!telemetryState) return
  telemetryState.dispatched = true
  telemetryState.lastDestination = options.destination
  telemetryState.lastModel = options.model
  telemetryState.lastProvider = options.provider
}

export function getClientSessionId(): string | undefined {
  return getRoutingAffinity()?.key ?? clientSessionStorage.getStore()
}

export function getRequestId(): string | undefined {
  return requestIdStorage.getStore()
}

export function getCopilotResponseHeaders(): Record<string, string> {
  return copilotResponseHeadersStorage.getStore() ?? {}
}

export function setCopilotResponseHeader(name: string, value: string): void {
  const headers = copilotResponseHeadersStorage.getStore()
  if (!headers) {
    return
  }
  headers[name] = value
}

export function clearCopilotResponseHeaders(): void {
  const headers = copilotResponseHeadersStorage.getStore()
  if (!headers) {
    return
  }

  for (const key of Object.keys(headers)) {
    Reflect.deleteProperty(headers, key)
  }
}

export const getQuotaHeaders = getCopilotResponseHeaders
export const setQuotaHeader = setCopilotResponseHeader
export const clearQuotaHeaders = clearCopilotResponseHeaders

export function getLastUsedRoutedAccountId(): number | undefined {
  return routedAccountStorage.getStore()?.lastUsedAccountId
}

export function setLastUsedRoutedAccountId(
  accountId: number | undefined,
): void {
  const routingState = routedAccountStorage.getStore()
  if (!routingState) {
    return
  }

  if (accountId === undefined) {
    delete routingState.lastUsedAccountId
    return
  }

  routingState.lastUsedAccountId = accountId
}
