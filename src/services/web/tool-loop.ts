import { captureRequestUsageObserver } from "~/lib/request-usage"

import type {
  ManagedWebTool,
  PreparedManagedWebTools,
  WebProtocol,
  WebToolsContext,
} from "./tool-context"
import type { ManagedToolResult, WebToolCall } from "./tool-executor"
import type { CompletedWebCall } from "./tool-output"

import {
  modelAllowsHostedWebSearch,
  modelAllowsWebTools,
} from "./model-capabilities"
import { prepareManagedWebTools, webToolError } from "./tool-context"
import { executeManagedWebCall } from "./tool-executor"
import {
  checkWebContinuationLimit,
  MAX_MANAGED_WEB_ROUNDS,
} from "./tool-limits"
import {
  assertNoClientWebCalls,
  continuationPayload,
  isUnsuccessfulWebResponse,
  responseCalls,
  sumUsage,
  withoutUnexecutedManagedCalls,
} from "./tool-output"
import { streamManagedWebRequest } from "./tool-stream"
import { ManagedWebUsage } from "./tool-usage"

export interface WebEvent {
  event?: string
  data?: string
  id?: string | number
  retry?: number
}
export type WebResponse = Record<string, unknown> | AsyncIterable<WebEvent>
export interface ManagedWebRequest {
  protocol: WebProtocol
  payload: Record<string, unknown>
  signal?: AbortSignal
  disabled?: boolean
  nativeResponses?: boolean
  accountId?: number
  send: (
    payload: Record<string, unknown>,
    managed: ReadonlyMap<string, ManagedWebTool>,
    reportProcessedPayload: (payload: Record<string, unknown>) => void,
  ) => Promise<WebResponse>
  execute?: (
    call: WebToolCall,
    tool: ManagedWebTool,
    options: { context: WebToolsContext; signal?: AbortSignal },
  ) => Promise<ManagedToolResult>
}
export const isWebStream = (
  value: WebResponse,
): value is AsyncIterable<WebEvent> => Symbol.asyncIterator in value

export interface ManagedWebDispatch {
  send: (payload: Record<string, unknown>) => Promise<WebResponse>
  processedPayload: () => Record<string, unknown>
}

/** Retain the successful transport body, including compatibility recovery. */
function createManagedDispatch(
  options: ManagedWebRequest,
  managed: ReadonlyMap<string, ManagedWebTool>,
): ManagedWebDispatch {
  let processedPayload = options.payload
  return {
    async send(payload) {
      processedPayload = payload
      return await options.send(payload, managed, (body) => {
        processedPayload = structuredClone(body)
      })
    },
    processedPayload: () => processedPayload,
  }
}

export async function completeWebCalls(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  response: Record<string, unknown>,
): Promise<Array<CompletedWebCall>> {
  if (isUnsuccessfulWebResponse(response, options.protocol)) return []
  const calls = responseCalls(response, options.protocol)
  const owned = calls.filter(
    (call) => !call.clientOwned && prepared.managed.has(call.name),
  )
  assertNoClientWebCalls(
    response,
    options.protocol,
    new Set(owned.map((call) => call.id)),
  )
  const completed: Array<CompletedWebCall> = []
  for (const call of owned) {
    options.signal?.throwIfAborted()
    const tool = prepared.managed.get(call.name)
    if (!tool || !prepared.context)
      throw new TypeError("Managed tool context is missing")
    const result = await (options.execute ?? executeManagedWebCall)(
      call,
      tool,
      { context: prepared.context, signal: options.signal },
    )
    options.signal?.throwIfAborted()
    completed.push({ call, result })
  }
  return completed
}

function transparentBufferedRound(
  response: Record<string, unknown>,
  protocol: WebProtocol,
  state: { round: number; intercepted: boolean },
): boolean {
  return (
    state.round === 0
    && !state.intercepted
    && !isUnsuccessfulWebResponse(response, protocol)
  )
}

function chargeableUsage(
  response: Record<string, unknown>,
  protocol: WebProtocol,
): unknown {
  return protocol === "responses" && response.status === "failed" ?
      undefined
    : response.usage
}

export async function runManagedWebRequest(
  options: ManagedWebRequest,
): Promise<WebResponse> {
  const prepared = prepareManagedWebTools(options.payload, options.protocol, {
    nativeResponses: options.nativeResponses,
    disabled:
      options.disabled
      || !modelAllowsWebTools(options.payload.model, options.accountId),
    hostedDefault: shouldUseHostedDefault(options),
  })
  if (prepared.managed.size === 0)
    return await options.send(prepared.payload, prepared.managed, () => {})
  const dispatch = createManagedDispatch(options, prepared.managed)
  const observedUsage = new ManagedWebUsage(
    options.protocol,
    captureRequestUsageObserver(),
  )
  let response = await dispatch.send(prepared.payload)
  if (isWebStream(response))
    return streamManagedWebRequest(options, prepared, {
      first: response,
      observedUsage,
      dispatch,
    })
  let usage: Record<string, unknown> | undefined
  for (let round = 0; round < MAX_MANAGED_WEB_ROUNDS; round++) {
    const intercepted = responseCalls(response, options.protocol).some(
      (call) => !call.clientOwned && prepared.managed.has(call.name),
    )
    // Like streaming, do not rewrite a native result when no managed round ran.
    if (
      transparentBufferedRound(response, options.protocol, {
        round,
        intercepted,
      })
    ) {
      options.signal?.throwIfAborted()
      return response
    }
    observedUsage.observe(
      chargeableUsage(response, options.protocol),
      intercepted,
    )
    options.signal?.throwIfAborted()
    usage = sumUsage(usage, response.usage)
    if (round > 0)
      assertPrivateContinuation(response, prepared, options.protocol)
    if (isUnsuccessfulWebResponse(response, options.protocol))
      return {
        ...withoutUnexecutedManagedCalls(response, prepared.managed, {
          protocol: options.protocol,
          callerNames: prepared.context?.callerNames,
        }),
        ...(usage ? { usage } : {}),
      }
    const completed = await completeWebCalls(options, prepared, response)
    if (completed.length === 0)
      return { ...response, ...(usage ? { usage } : {}) }
    checkWebContinuationLimit(round)
    const payload = continuationPayload(dispatch.processedPayload(), response, {
      completed,
      protocol: options.protocol,
    })
    observedUsage.nextRound()
    const next = await dispatch.send(payload)
    if (isWebStream(next))
      throw webToolError(
        "web_tool_protocol_error",
        "Unexpected streaming tool continuation.",
      )
    response = next
  }
  throw webToolError(
    "web_tool_limit_exceeded",
    "Web tool continuation limit exceeded.",
  )
}

function shouldUseHostedDefault(options: ManagedWebRequest): boolean {
  return (
    options.nativeResponses === true
    && options.protocol === "responses"
    && modelAllowsHostedWebSearch(options.payload.model, options.accountId)
  )
}

function assertPrivateContinuation(
  response: Record<string, unknown>,
  prepared: PreparedManagedWebTools,
  protocol: WebProtocol,
): void {
  assertNoClientWebCalls(
    withoutUnexecutedManagedCalls(response, prepared.managed, {
      protocol,
      callerNames:
        isUnsuccessfulWebResponse(response, protocol) ?
          prepared.context?.callerNames
        : undefined,
    }),
    protocol,
    new Set(),
  )
}
