import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

import { runWithCopilotContractObservabilityScope } from "~/lib/copilot-contract-observability"
import {
  type CopilotRequestAttribution,
  runWithCopilotRequestAttribution,
} from "~/lib/copilot-request-context"
import { runWithInterceptApprovals } from "~/lib/intercept/approvals"
import {
  copilotResponseHeadersStorage,
  createRoutingTelemetryRequestState,
  requestIdStorage,
  routedAccountStorage,
  routingTelemetryStorage,
  runWithRequestDiagnostics,
} from "~/lib/request-session"
import {
  type RoutingAffinity,
  runWithRoutingAffinity,
} from "~/lib/routing-affinity"

/** Per-request routing state every inbound request starts with. */
export async function runWithRequestRoutingScopes<T>(
  attribution: CopilotRequestAttribution,
  affinity: RoutingAffinity | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const runWithDiagnostics = async () =>
    await runWithRequestDiagnostics(
      async () =>
        await runWithCopilotContractObservabilityScope(
          async () => await runWithInterceptApprovals(callback),
        ),
    )
  return await runWithCopilotRequestAttribution(
    attribution,
    async () =>
      await runWithRoutingAffinity(
        affinity,
        async () =>
          await copilotResponseHeadersStorage.run(
            {},
            async () => await routedAccountStorage.run({}, runWithDiagnostics),
          ),
      ),
  )
}

// Captured while this module loads, before any request runs, so callbacks
// start with every AsyncLocalStorage store unset.
const runOutsideRequestContext = AsyncLocalStorage.snapshot()

/**
 * Run gateway-initiated inference as a request of its own. Nothing is shared
 * with the request that triggered it: account leases and turn affinity,
 * fallback records, telemetry, attribution, and response headers all start
 * fresh, exactly as for a new inbound request without client headers.
 */
export async function runAsIndependentRequest<T>(
  sourceProtocol: string,
  work: () => Promise<T>,
): Promise<T> {
  return await runOutsideRequestContext(
    async () =>
      await requestIdStorage.run(
        randomUUID(),
        async () =>
          await routingTelemetryStorage.run(
            createRoutingTelemetryRequestState(sourceProtocol),
            async () => await runWithRequestRoutingScopes({}, undefined, work),
          ),
      ),
  )
}
