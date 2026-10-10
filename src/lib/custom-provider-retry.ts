import {
  abortableSleep,
  PRE_HEADER_MAX_DELAY_SECONDS,
} from "~/services/copilot/transport-retry"

/** Statuses where the provider asks for a later resend of the same request. */
const RETRYABLE_PROVIDER_STATUSES = new Set([429, 503])
const DEFAULT_PROVIDER_RETRY_DELAY_SECONDS = 1

type ProviderRetrySleep = (
  ms: number,
  signal: AbortSignal | null | undefined,
) => Promise<void>

let providerRetrySleep: ProviderRetrySleep = abortableSleep

export function setCustomProviderRetrySleepForTest(
  sleep?: ProviderRetrySleep,
): void {
  providerRetrySleep = sleep ?? abortableSleep
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

/**
 * Like Copilot calls, resend once when a provider is briefly unavailable, such
 * as a model at capacity, and its requested wait fits before response headers.
 */
export function customProviderRetryDelayMs(
  response: Response,
): number | undefined {
  if (response.ok || !RETRYABLE_PROVIDER_STATUSES.has(response.status))
    return undefined
  const seconds =
    parseRetryAfterSeconds(response.headers.get("retry-after"))
    ?? DEFAULT_PROVIDER_RETRY_DELAY_SECONDS
  return seconds <= PRE_HEADER_MAX_DELAY_SECONDS ? seconds * 1000 : undefined
}

/** Wait before the resend; a client disconnect cancels the wait. */
export async function waitForCustomProviderRetry(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  await providerRetrySleep(ms, signal)
}
