import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import { LocalHTTPError } from "~/lib/error"
import {
  buildWebSearchQuery,
  executeWebSearch,
} from "~/services/copilot/mcp-web-search"
import { isCallerOwnedWebSearch } from "~/services/web/tool-context"
import { mixedWebSearchResponse } from "~/services/web/tool-output"

export const MAX_RESPONSES_WEB_SEARCH_USES = 8

export interface PreparedResponsesChatCompletion {
  readonly accountId?: number
  readonly processedPayload: ChatCompletionsPayload
  readonly response:
    | ChatCompletionResponse
    | AsyncIterable<{
        data?: string
        event?: string
        id?: string | number
        retry?: number
      }>
}

export type ResponsesChatCompletionFactory = (
  payload: ChatCompletionsPayload,
  options: {
    readonly allowCompatibilityRetry?: boolean
    readonly signal?: AbortSignal
  },
) => Promise<PreparedResponsesChatCompletion>

function webSearchCalls(response: ChatCompletionResponse): Array<ToolCall> {
  if (isCallerOwnedWebSearch("web_search")) return []
  return (response.choices[0]?.message.tool_calls ?? []).filter(
    (call) => call.function.name === "web_search",
  )
}

function webSearchTool(payload: ChatCompletionsPayload): unknown {
  return payload.tools?.find((tool) => tool.function.name === "web_search")
}

export async function resolvePreparedResponsesWebSearchCalls(options: {
  readonly completionFactory: ResponsesChatCompletionFactory
  readonly initial: PreparedResponsesChatCompletion
  readonly maxUses?: number
  readonly signal?: AbortSignal
  readonly webSearch?: (query: string, signal?: AbortSignal) => Promise<string>
}): Promise<ChatCompletionResponse> {
  let current = options.initial.response as ChatCompletionResponse
  let currentPayload = options.initial.processedPayload
  let iterations = 0
  let searchUses = 0
  const maxSearchUses =
    Number.isInteger(options.maxUses) && Number(options.maxUses) > 0 ?
      Math.min(Number(options.maxUses), MAX_RESPONSES_WEB_SEARCH_USES)
    : MAX_RESPONSES_WEB_SEARCH_USES

  while (true) {
    const calls = webSearchCalls(current)
    if (calls.length === 0) return current
    if (
      iterations >= maxSearchUses
      || searchUses + calls.length > maxSearchUses
    ) {
      throw createResponsesWebSearchLimitError(maxSearchUses)
    }
    iterations += 1
    searchUses += calls.length
    const results = await Promise.all(
      calls.map(async (call) => ({
        callId: call.id,
        result: await (options.webSearch ?? executeWebSearch)(
          buildWebSearchQuery(
            call.function.arguments,
            webSearchTool(currentPayload),
          ),
          options.signal,
        ),
      })),
    )
    const mixed = mixedWebSearchResponse(
      current as unknown as Record<string, unknown>,
      "chat",
      results.map((r) => ({ id: r.callId, text: r.result })),
    )
    if (mixed) return mixed as unknown as ChatCompletionResponse
    const nextPayload: ChatCompletionsPayload = {
      ...currentPayload,
      messages: [
        ...currentPayload.messages,
        current.choices[0].message,
        ...results.map((result) => ({
          role: "tool" as const,
          content: result.result,
          tool_call_id: result.callId,
        })),
      ],
      stream: false,
      tool_choice: "auto",
    }
    const next = await options.completionFactory(nextPayload, {
      allowCompatibilityRetry: false,
      signal: options.signal,
    })
    current = next.response as ChatCompletionResponse
    // eslint-disable-next-line require-atomic-updates -- the loop intentionally advances from the awaited factory's processed body
    currentPayload = next.processedPayload
  }
}

function createResponsesWebSearchLimitError(limit: number): LocalHTTPError {
  const clientBody = {
    error: {
      type: "invalid_request_error",
      code: "web_search_limit_exceeded",
      message: "The Copilot Responses request was rejected.",
      param: "web_search_limit",
    },
  }
  return new LocalHTTPError(
    `Responses web search exceeded ${limit} uses.`,
    Response.json(clientBody, { status: 400 }),
    clientBody,
  )
}
