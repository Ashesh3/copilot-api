import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  buildWebSearchQuery,
  executeWebSearch,
} from "~/services/copilot/mcp-web-search"

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
  options: { readonly signal?: AbortSignal },
) => Promise<PreparedResponsesChatCompletion>

function webSearchCalls(response: ChatCompletionResponse): Array<ToolCall> {
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
  readonly signal?: AbortSignal
  readonly webSearch?: (query: string, signal?: AbortSignal) => Promise<string>
}): Promise<ChatCompletionResponse> {
  let current = options.initial.response as ChatCompletionResponse
  let currentPayload = options.initial.processedPayload

  while (true) {
    const calls = webSearchCalls(current)
    if (calls.length === 0) return current
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
        {
          role: "assistant",
          content: current.choices[0]?.message.content ?? null,
          tool_calls: calls,
        },
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
      signal: options.signal,
    })
    current = next.response as ChatCompletionResponse
    // eslint-disable-next-line require-atomic-updates -- the loop intentionally advances from the awaited factory's processed body
    currentPayload = next.processedPayload
  }
}
