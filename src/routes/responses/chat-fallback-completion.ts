import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import { LocalHTTPError } from "~/lib/error"
import { captureRequestUsageObserver } from "~/lib/request-usage"
import {
  buildWebSearchQuery,
  executeWebSearch,
  isChatWebSearchFunctionTool,
} from "~/services/copilot/mcp-web-search"
import { lastRoundContextUsage } from "~/services/web/context-usage"
import { isCallerOwnedWebSearch } from "~/services/web/tool-context"
import { assertNoClientWebCalls, sumUsage } from "~/services/web/tool-output"
import { ManagedWebUsage } from "~/services/web/tool-usage"

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
  return (response.choices[0]?.message.tool_calls ?? []).filter((call) =>
    isChatWebSearchFunctionTool(call),
  )
}

function webSearchTool(payload: ChatCompletionsPayload): unknown {
  return payload.tools?.find((tool) => isChatWebSearchFunctionTool(tool))
}

/**
 * The usage a client reads after gateway searches. By default it is the last
 * round's prompt with every round's completion, since a Responses client such
 * as Codex sizes its context by the reported input. `final-round` keeps the
 * final round's own usage, for the Google route.
 */
export type ResponsesWebSearchUsage = "last-round-context" | "final-round"

function withSearchUsage(
  response: ChatCompletionResponse,
  total: Record<string, unknown> | undefined,
  usage: ResponsesWebSearchUsage | undefined,
): ChatCompletionResponse {
  if (usage === "final-round") return response
  const reported = lastRoundContextUsage(response.usage, total, "chat")
  return reported ?
      { ...response, usage: reported as ChatCompletionResponse["usage"] }
    : response
}

export async function resolvePreparedResponsesWebSearchCalls(options: {
  readonly completionFactory: ResponsesChatCompletionFactory
  readonly initial: PreparedResponsesChatCompletion
  readonly maxUses?: number
  readonly signal?: AbortSignal
  readonly webSearch?: (query: string, signal?: AbortSignal) => Promise<string>
  readonly usage?: ResponsesWebSearchUsage
}): Promise<ChatCompletionResponse> {
  let current = options.initial.response as ChatCompletionResponse
  let currentPayload = options.initial.processedPayload
  let iterations = 0
  let searchUses = 0
  const maxSearchUses =
    Number.isInteger(options.maxUses) && Number(options.maxUses) > 0 ?
      Math.min(Number(options.maxUses), MAX_RESPONSES_WEB_SEARCH_USES)
    : MAX_RESPONSES_WEB_SEARCH_USES
  // Request accounting counts every round, as in the managed loop.
  const observed = new ManagedWebUsage("chat", captureRequestUsageObserver())
  let total: Record<string, unknown> | undefined

  while (true) {
    const calls = webSearchCalls(current)
    if (calls.length > 0 || searchUses > 0) {
      observed.observe(current.usage, calls.length > 0)
      total = sumUsage(total, current.usage)
      assertNoClientWebCalls(
        current as unknown as Record<string, unknown>,
        "chat",
        new Set(calls.map((call) => call.id)),
      )
    }
    if (calls.length === 0)
      return searchUses > 0 ?
          withSearchUsage(current, total, options.usage)
        : current
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
    observed.nextRound()
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
