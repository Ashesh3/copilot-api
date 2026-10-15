import type {
  ManagedWebTool,
  PreparedManagedWebTools,
  WebProtocol,
  WebToolsContext,
} from "./tool-context"
import type { ManagedToolResult, WebToolCall } from "./tool-executor"
import type { CompletedWebCall } from "./tool-output"

import { modelAllowsWebTools } from "./model-capabilities"
import { prepareManagedWebTools, webToolError } from "./tool-context"
import { executeManagedWebCall } from "./tool-executor"
import {
  continuationPayload,
  responseCalls,
  sumUsage,
  withoutManagedCalls,
} from "./tool-output"
import { streamManagedWebRequest } from "./tool-stream"

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
  accountId?: number
  send: (
    payload: Record<string, unknown>,
    managed: ReadonlyMap<string, ManagedWebTool>,
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

export async function completeWebCalls(
  options: ManagedWebRequest,
  prepared: PreparedManagedWebTools,
  response: Record<string, unknown>,
): Promise<{ completed: Array<CompletedWebCall>; mixed: boolean }> {
  const calls = responseCalls(response, options.protocol)
  const owned = calls.filter(
    (call) => !call.clientOwned && prepared.managed.has(call.name),
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
    completed.push({ call, result })
  }
  return { completed, mixed: calls.length > owned.length }
}

export async function runManagedWebRequest(
  options: ManagedWebRequest,
): Promise<WebResponse> {
  const prepared = prepareManagedWebTools(
    options.payload,
    options.protocol,
    options.disabled
      || !modelAllowsWebTools(options.payload.model, options.accountId),
  )
  if (prepared.managed.size === 0)
    return await options.send(options.payload, prepared.managed)
  let payload = prepared.payload
  let response = await options.send(payload, prepared.managed)
  if (isWebStream(response))
    return streamManagedWebRequest(options, prepared, response)
  let usage: Record<string, unknown> | undefined
  for (let round = 0; round < 18; round++) {
    options.signal?.throwIfAborted()
    usage = sumUsage(usage, response.usage)
    const { completed, mixed } = await completeWebCalls(
      options,
      prepared,
      response,
    )
    if (completed.length === 0)
      return { ...response, ...(usage ? { usage } : {}) }
    if (mixed)
      return {
        ...withoutManagedCalls(response, completed, options.protocol),
        ...(usage ? { usage } : {}),
      }
    payload = continuationPayload(payload, response, {
      completed,
      protocol: options.protocol,
    })
    const next = await options.send(payload, prepared.managed)
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
