import * as Sentry from "@sentry/bun"
import consola from "consola"

import {
  createSentryChatSpanOptions,
  setSentryOutputMessages,
} from "~/lib/sentry"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponseInputItem,
  type ResponseOutputContentBlock,
  type ResponseOutputFunctionCall,
  type ResponseOutputItem,
  type ResponseOutputText,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"
import {
  buildWebSearchQuery,
  executeWebSearch,
} from "~/services/copilot/mcp-web-search"

import {
  type AnthropicResponse,
  isAnthropicTextBlock,
  isAnthropicThinkingBlock,
  isAnthropicToolUseBlock,
} from "./anthropic-types"

const stringifyResponsesInput = (input: ResponsesPayload["input"]): string =>
  typeof input === "string" ? input : JSON.stringify(input ?? [])

const findChatWebSearchTool = (payload: ChatCompletionsPayload): unknown =>
  payload.tools?.find(
    (tool) => "function" in tool && tool.function.name === "web_search",
  )

const findResponsesWebSearchTool = (payload: ResponsesPayload): unknown =>
  payload.tools?.find(
    (tool) =>
      (tool as { type?: string; name?: string }).type === "function"
      && (tool as { name?: string }).name === "web_search",
  )

// --- ChatCompletions web search resolution ---

export const extractWebSearchCalls = (
  response: ChatCompletionResponse,
): Array<ToolCall> => {
  const toolCalls = response.choices[0]?.message.tool_calls
  if (!toolCalls) return []
  return toolCalls.filter((tc) => tc.function.name === "web_search")
}

export const resolveWebSearchCalls = async (
  response: ChatCompletionResponse,
  payload: ChatCompletionsPayload,
  options: {
    initiatorOverride?: "agent" | "user"
    abortSignal?: AbortSignal
    copilotSessionToken?: string
    createCompletion?: (
      payload: ChatCompletionsPayload,
    ) => Promise<ChatCompletionResponse>
  } = {},
): Promise<ChatCompletionResponse> => {
  const {
    initiatorOverride,
    abortSignal,
    copilotSessionToken,
    createCompletion,
  } = options
  let current = response
  let currentPayload = payload
  let iteration = 0

  while (true) {
    iteration += 1
    const webSearchCalls = extractWebSearchCalls(current)
    if (webSearchCalls.length === 0) return current

    consola.info(
      `Executing ${webSearchCalls.length} web search(es), iteration ${iteration}`,
    )

    const results = await Promise.all(
      webSearchCalls.map(async (tc) => {
        const query = buildWebSearchQuery(
          tc.function.arguments,
          findChatWebSearchTool(currentPayload),
        )
        const result = await executeWebSearch(query, abortSignal)
        return { callId: tc.id, result }
      }),
    )

    const assistantMessage: Message = {
      role: "assistant",
      content: current.choices[0]?.message.content ?? null,
      tool_calls: webSearchCalls,
    }

    const toolMessages: Array<Message> = results.map((r) => ({
      role: "tool" as const,
      content: r.result,
      tool_call_id: r.callId,
    }))

    currentPayload = {
      ...currentPayload,
      messages: [...currentPayload.messages, assistantMessage, ...toolMessages],
      stream: false,
      // A client may force the first web_search call. Once its result is in
      // context the model must be allowed to answer instead of being forced
      // into an endless search loop.
      tool_choice: "auto",
    }

    current = await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: currentPayload.messages,
        model: currentPayload.model,
      }),
      async (span) => {
        const result =
          createCompletion ?
            await createCompletion(currentPayload)
          : ((await createChatCompletions(currentPayload, {
              copilotSessionToken,
              initiator: initiatorOverride,
              signal: abortSignal,
            })) as ChatCompletionResponse)

        const inputTokens = result.usage?.prompt_tokens ?? 0
        const outputTokens = result.usage?.completion_tokens ?? 0
        span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
        span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
        setSentryOutputMessages(span, result.choices[0]?.message?.content ?? "")

        return result
      },
    )
  }
}

// --- Responses API web search resolution ---

export const resolveResponsesWebSearchCalls = async (
  result: ResponsesResult,
  payload: ResponsesPayload,
  requestOptions: {
    vision: boolean
    initiator: "agent" | "user"
    copilotSessionToken?: string
    signal?: AbortSignal
    createResponse?: (payload: ResponsesPayload) => Promise<ResponsesResult>
  },
): Promise<ResponsesResult> => {
  let current = result
  let currentPayload = payload
  let iteration = 0

  while (true) {
    iteration += 1
    const webSearchCalls = current.output.filter(
      (item): item is ResponseOutputFunctionCall =>
        item.type === "function_call" && item.name === "web_search",
    )
    if (webSearchCalls.length === 0) return current

    consola.info(
      `Executing ${webSearchCalls.length} web search(es) via Responses API, iteration ${iteration}`,
    )

    const searchResults = await Promise.all(
      webSearchCalls.map(async (item) => {
        const query = buildWebSearchQuery(
          item.arguments,
          findResponsesWebSearchTool(currentPayload),
        )
        const searchResult = await executeWebSearch(
          query,
          requestOptions.signal,
        )
        return { callId: item.call_id, result: searchResult }
      }),
    )

    const resolvedOutputItems: Array<ResponseInputItem> = []
    for (const item of current.output) {
      if (item.type === "function_call") {
        if (item.name === "web_search") {
          resolvedOutputItems.push({
            type: "function_call",
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments,
            status: "completed",
          })
        }
        continue
      }
      resolvedOutputItems.push(item as ResponseInputItem)
    }

    const newInput: Array<ResponseInputItem> = [
      ...(Array.isArray(currentPayload.input) ? currentPayload.input : []),
      ...resolvedOutputItems,
      ...searchResults.map((r) => ({
        type: "function_call_output" as const,
        call_id: r.callId,
        output: r.result,
      })),
    ]

    currentPayload = {
      ...currentPayload,
      input: newInput,
      stream: false,
      tool_choice: "auto",
    }
    current = await Sentry.startSpan(
      createSentryChatSpanOptions({
        inputMessages: stringifyResponsesInput(currentPayload.input),
        model: currentPayload.model,
      }),
      async (span) => {
        const result =
          requestOptions.createResponse ?
            await requestOptions.createResponse(currentPayload)
          : ((await createResponses(
              currentPayload,
              requestOptions,
            )) as ResponsesResult)

        const inputTokens = result.usage?.input_tokens ?? 0
        const outputTokens = result.usage?.output_tokens ?? 0
        span.setAttribute("gen_ai.usage.input_tokens", inputTokens)
        span.setAttribute("gen_ai.usage.output_tokens", outputTokens)
        setSentryOutputMessages(span, result.output_text)

        return result
      },
    )
  }
}

// --- Stream chunk reconstruction ---

interface ChunkAccumulator {
  id: string
  model: string
  created: number
  content: string
  finishReason: "stop" | "length" | "tool_calls" | "content_filter"
  toolCalls: Map<number, { id: string; name: string; arguments: string }>
  reasoningText: string | null
  reasoningOpaque: string | null
  usage?: ChatCompletionResponse["usage"]
}

const createAccumulator = (): ChunkAccumulator => ({
  id: "",
  model: "",
  created: 0,
  content: "",
  finishReason: "stop",
  toolCalls: new Map(),
  reasoningText: null,
  reasoningOpaque: null,
})

const accumulateChunk = (
  acc: ChunkAccumulator,
  chunk: ChatCompletionChunk,
): void => {
  if (chunk.id) acc.id = chunk.id
  if (chunk.model) acc.model = chunk.model
  if (chunk.created) acc.created = chunk.created
  if (chunk.usage) acc.usage = chunk.usage

  for (const choice of chunk.choices) {
    if (choice.finish_reason) acc.finishReason = choice.finish_reason
    if (choice.delta.content) acc.content += choice.delta.content
    if (choice.delta.reasoning_text) {
      acc.reasoningText =
        (acc.reasoningText ?? "") + choice.delta.reasoning_text
    }
    if (choice.delta.reasoning_opaque) {
      acc.reasoningOpaque = choice.delta.reasoning_opaque
    }
    if (choice.delta.tool_calls) {
      accumulateToolCalls(acc.toolCalls, choice.delta.tool_calls)
    }
  }
}

const accumulateToolCalls = (
  map: Map<number, { id: string; name: string; arguments: string }>,
  toolCalls: NonNullable<
    ChatCompletionChunk["choices"][0]["delta"]["tool_calls"]
  >,
): void => {
  for (const tc of toolCalls) {
    const existing = map.get(tc.index)
    if (!existing) {
      map.set(tc.index, {
        id: tc.id ?? "",
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      })
    } else {
      if (tc.id) existing.id = tc.id
      if (tc.function?.name) existing.name = tc.function.name
      if (tc.function?.arguments) existing.arguments += tc.function.arguments
    }
  }
}

export const reconstructFromChunks = (
  chunks: Array<ChatCompletionChunk>,
): ChatCompletionResponse | null => {
  if (chunks.length === 0) return null

  const acc = createAccumulator()
  for (const chunk of chunks) {
    accumulateChunk(acc, chunk)
  }

  const toolCalls =
    acc.toolCalls.size > 0 ?
      Array.from(acc.toolCalls.values()).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
    : undefined

  return {
    id: acc.id,
    object: "chat.completion",
    created: acc.created,
    model: acc.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: acc.content || null,
          ...(acc.reasoningText ? { reasoning_text: acc.reasoningText } : {}),
          ...(acc.reasoningOpaque ?
            { reasoning_opaque: acc.reasoningOpaque }
          : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: acc.finishReason,
      },
    ],
    usage: acc.usage,
  }
}

// --- Emit Anthropic response as SSE stream ---

type SSEWriter = {
  writeSSE: (data: { event: string; data: string }) => Promise<void>
}

export const emitAnthropicResponseAsStream = async (
  stream: SSEWriter,
  response: AnthropicResponse,
): Promise<void> => {
  await emitMessageStart(stream, response)

  for (let i = 0; i < response.content.length; i++) {
    await emitContentBlock(stream, response.content[i], i)
  }

  await emitMessageEnd(stream, response)
}

export const emitChatCompletionResponseAsStream = async (
  stream: {
    writeSSE: (data: { event?: string; data: string }) => Promise<void>
  },
  response: ChatCompletionResponse,
): Promise<void> => {
  for (const choice of response.choices) {
    await stream.writeSSE({
      data: JSON.stringify({
        id: response.id,
        object: "chat.completion.chunk",
        created: response.created,
        model: response.model,
        choices: [
          {
            index: choice.index,
            delta: {
              role: "assistant",
              ...(choice.message.content ?
                { content: choice.message.content }
              : {}),
              ...(choice.message.reasoning_text ?
                { reasoning_text: choice.message.reasoning_text }
              : {}),
              ...(choice.message.reasoning_opaque ?
                { reasoning_opaque: choice.message.reasoning_opaque }
              : {}),
              ...(choice.message.tool_calls ?
                {
                  tool_calls: choice.message.tool_calls.map(
                    (toolCall, index) => ({
                      ...toolCall,
                      index,
                    }),
                  ),
                }
              : {}),
            },
            finish_reason: choice.finish_reason,
            logprobs: choice.logprobs,
          },
        ],
      }),
    })
  }

  if (response.usage) {
    await stream.writeSSE({
      data: JSON.stringify({
        id: response.id,
        object: "chat.completion.chunk",
        created: response.created,
        model: response.model,
        choices: [],
        usage: response.usage,
      }),
    })
  }
  await stream.writeSSE({ data: "[DONE]" })
}

const emitMessageStart = async (
  stream: SSEWriter,
  response: AnthropicResponse,
): Promise<void> => {
  await stream.writeSSE({
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id: response.id,
        type: "message",
        role: "assistant",
        model: response.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: response.usage,
      },
    }),
  })
}

const emitContentBlock = async (
  stream: SSEWriter,
  block: AnthropicResponse["content"][0],
  index: number,
): Promise<void> => {
  if (isAnthropicTextBlock(block)) {
    await emitTextBlock(stream, block.text, index)
  } else if (isAnthropicThinkingBlock(block)) {
    await emitThinkingBlock(stream, block, index)
  } else if (isAnthropicToolUseBlock(block)) {
    await emitToolUseBlock(stream, block, index)
  }

  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index }),
  })
}

const emitTextBlock = async (
  stream: SSEWriter,
  text: string,
  index: number,
): Promise<void> => {
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }),
  })
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    }),
  })
}

const emitThinkingBlock = async (
  stream: SSEWriter,
  block: { thinking: string; signature?: string },
  index: number,
): Promise<void> => {
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    }),
  })
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: block.thinking },
    }),
  })
  if (block.signature) {
    await stream.writeSSE({
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature },
      }),
    })
  }
}

const emitToolUseBlock = async (
  stream: SSEWriter,
  block: { id: string; name: string; input: Record<string, unknown> },
  index: number,
): Promise<void> => {
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: {},
      },
    }),
  })
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(block.input),
      },
    }),
  })
}

const emitMessageEnd = async (
  stream: SSEWriter,
  response: AnthropicResponse,
): Promise<void> => {
  await stream.writeSSE({
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: response.stop_reason,
        stop_sequence: response.stop_sequence,
      },
      usage: { output_tokens: response.usage.output_tokens },
    }),
  })
  await stream.writeSSE({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  })
}

// --- Emit Responses result as SSE stream ---

export const emitResponsesResultAsStream = async (
  stream: {
    writeSSE: (data: { event?: string; data: string }) => Promise<void>
  },
  result: ResponsesResult,
): Promise<void> => {
  let seqNum = 0

  await stream.writeSSE({
    event: "response.created",
    data: JSON.stringify({
      type: "response.created",
      response: { ...result, output: [], status: "in_progress" },
      sequence_number: seqNum++,
    }),
  })

  for (let i = 0; i < result.output.length; i++) {
    seqNum = await emitResponsesOutputItem(result.output[i], {
      stream,
      outputIndex: i,
      seqNum,
    })
  }

  const terminalEvent = getResponsesTerminalEvent(result.status)
  await stream.writeSSE({
    event: terminalEvent,
    data: JSON.stringify({
      type: terminalEvent,
      response: result,
      sequence_number: seqNum,
    }),
  })
}

function getResponsesTerminalEvent(
  status: ResponsesResult["status"],
): "response.completed" | "response.failed" | "response.incomplete" {
  if (status === "failed") return "response.failed"
  if (status === "incomplete") return "response.incomplete"
  return "response.completed"
}

type ResponsesSSEWriter = {
  writeSSE: (data: { event?: string; data: string }) => Promise<void>
}

interface ResponsesEmitContext {
  stream: ResponsesSSEWriter
  outputIndex: number
  seqNum: number
}

const emitResponsesOutputItem = async (
  item: ResponseOutputItem,
  ctx: ResponsesEmitContext,
): Promise<number> => {
  let seq = ctx.seqNum
  const itemId =
    item.id
    ?? (item.type === "function_call" ?
      `fc_${item.call_id}`
    : `item_${ctx.outputIndex}`)
  const itemWithId = { ...item, id: itemId }

  await ctx.stream.writeSSE({
    event: "response.output_item.added",
    data: JSON.stringify({
      type: "response.output_item.added",
      item: { ...itemWithId, status: "in_progress" },
      output_index: ctx.outputIndex,
      sequence_number: seq++,
    }),
  })

  if (item.type === "message" && item.content) {
    seq = await emitResponsesMessageContent(item.content, {
      stream: ctx.stream,
      itemId,
      outputIndex: ctx.outputIndex,
      seqNum: seq,
    })
  }

  if (item.type === "reasoning" && item.summary) {
    seq = await emitResponsesReasoningSummary(item.summary, {
      stream: ctx.stream,
      itemId,
      outputIndex: ctx.outputIndex,
      seqNum: seq,
    })
  }

  if (item.type === "function_call") {
    await ctx.stream.writeSSE({
      event: "response.function_call_arguments.done",
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id: itemId,
        output_index: ctx.outputIndex,
        arguments: item.arguments,
        name: item.name,
        sequence_number: seq++,
      }),
    })
  }

  await ctx.stream.writeSSE({
    event: "response.output_item.done",
    data: JSON.stringify({
      type: "response.output_item.done",
      item: itemWithId,
      output_index: ctx.outputIndex,
      sequence_number: seq++,
    }),
  })

  return seq
}

const emitResponsesReasoningSummary = async (
  summary: NonNullable<
    Extract<ResponseOutputItem, { type: "reasoning" }>["summary"]
  >,
  ctx: MessageContentEmitContext,
): Promise<number> => {
  let seq = ctx.seqNum
  for (const [summaryIndex, block] of summary.entries()) {
    if (typeof block.text !== "string") continue
    await ctx.stream.writeSSE({
      event: "response.reasoning_summary_text.delta",
      data: JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        item_id: ctx.itemId,
        output_index: ctx.outputIndex,
        summary_index: summaryIndex,
        delta: block.text,
        sequence_number: seq++,
      }),
    })
    await ctx.stream.writeSSE({
      event: "response.reasoning_summary_text.done",
      data: JSON.stringify({
        type: "response.reasoning_summary_text.done",
        item_id: ctx.itemId,
        output_index: ctx.outputIndex,
        summary_index: summaryIndex,
        text: block.text,
        sequence_number: seq++,
      }),
    })
  }
  return seq
}

interface MessageContentEmitContext {
  stream: ResponsesSSEWriter
  itemId: string
  outputIndex: number
  seqNum: number
}

const emitResponsesMessageContent = async (
  content: Array<ResponseOutputContentBlock>,
  ctx: MessageContentEmitContext,
): Promise<number> => {
  let seq = ctx.seqNum

  for (const [ci, block] of content.entries()) {
    if (
      !("type" in block)
      || (block as { type: string }).type !== "output_text"
    )
      continue

    const text = (block as unknown as ResponseOutputText).text
    await ctx.stream.writeSSE({
      event: "response.output_text.delta",
      data: JSON.stringify({
        type: "response.output_text.delta",
        item_id: ctx.itemId,
        output_index: ctx.outputIndex,
        content_index: ci,
        delta: text,
        sequence_number: seq++,
      }),
    })
    await ctx.stream.writeSSE({
      event: "response.output_text.done",
      data: JSON.stringify({
        type: "response.output_text.done",
        item_id: ctx.itemId,
        output_index: ctx.outputIndex,
        content_index: ci,
        text,
        sequence_number: seq++,
      }),
    })
  }

  return seq
}

// --- Detect web_search in stream events ---

export const hasWebSearchInChunks = (
  chunks: Array<ChatCompletionChunk>,
): boolean => {
  return chunks.some((chunk) =>
    chunk.choices.some((choice) =>
      choice.delta.tool_calls?.some((tc) => tc.function?.name === "web_search"),
    ),
  )
}
