import type {
  ResponseInputItem,
  ResponseOutputFunctionCall,
  ResponsesPayload,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import { LocalHTTPError } from "~/lib/error"
import {
  buildWebSearchQuery,
  executeWebSearch,
} from "~/services/copilot/mcp-web-search"

export const MAX_GOOGLE_RESPONSES_WEB_SEARCH_USES = 8

function searchCalls(
  result: ResponsesResult,
): Array<ResponseOutputFunctionCall> {
  return result.output.filter(
    (item): item is ResponseOutputFunctionCall =>
      item.type === "function_call" && item.name === "web_search",
  )
}

function searchTool(payload: ResponsesPayload): unknown {
  return payload.tools?.find(
    (tool) =>
      (tool as { type?: unknown; name?: unknown }).type === "function"
      && (tool as { name?: unknown }).name === "web_search",
  )
}

export async function resolvePreparedGoogleResponsesWebSearch(options: {
  readonly createResponse: (
    payload: ResponsesPayload,
  ) => Promise<ResponsesResult>
  readonly initial: ResponsesResult
  readonly maxUses?: number
  readonly payload: ResponsesPayload
  readonly signal?: AbortSignal
  readonly webSearch?: (query: string, signal?: AbortSignal) => Promise<string>
}): Promise<ResponsesResult> {
  let current = options.initial
  let currentPayload = structuredClone(options.payload)
  let uses = 0
  const maxUses =
    Number.isInteger(options.maxUses) && Number(options.maxUses) > 0 ?
      Math.min(Number(options.maxUses), MAX_GOOGLE_RESPONSES_WEB_SEARCH_USES)
    : MAX_GOOGLE_RESPONSES_WEB_SEARCH_USES

  while (true) {
    const calls = searchCalls(current)
    if (calls.length === 0) return current
    if (uses + calls.length > maxUses) throw searchLimitError(maxUses)
    uses += calls.length
    const results = await Promise.all(
      calls.map(async (call) => ({
        callId: call.call_id,
        output: await (options.webSearch ?? executeWebSearch)(
          buildWebSearchQuery(call.arguments, searchTool(currentPayload)),
          options.signal,
        ),
      })),
    )
    const completedCalls: Array<ResponseInputItem> = calls.map((call) => ({
      type: "function_call",
      call_id: call.call_id,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    }))
    currentPayload = {
      ...currentPayload,
      input: [
        ...(Array.isArray(currentPayload.input) ? currentPayload.input : []),
        ...completedCalls,
        ...results.map((result) => ({
          type: "function_call_output" as const,
          call_id: result.callId,
          output: result.output,
        })),
      ],
      stream: false,
      tool_choice: "auto",
    }
    current = await options.createResponse(currentPayload)
  }
}

function searchLimitError(limit: number): LocalHTTPError {
  const clientBody = {
    error: {
      type: "invalid_request_error",
      code: "web_search_limit_exceeded",
      message: "The Google AI request was rejected.",
      param: "web_search_limit",
    },
  }
  return new LocalHTTPError(
    `Google Responses web search exceeded ${limit} uses.`,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}
