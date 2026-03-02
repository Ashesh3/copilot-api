import consola from "consola"

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
import { executeWebSearch } from "~/services/copilot/mcp-web-search"

import type { AnthropicResponse } from "./anthropic-types"

const MAX_WEB_SEARCH_ITERATIONS = 3

// --- Safe argument parsing ---

export const parseWebSearchQuery = (rawArguments: string): string => {
  try {
    const args = JSON.parse(rawArguments) as { query?: string }
    return args.query ?? rawArguments
  } catch {
    return rawArguments
  }
}

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
  initiatorOverride?: "agent" | "user",
): Promise<ChatCompletionResponse> => {
  let current = response
  let currentPayload = payload

  for (let i = 0; i < MAX_WEB_SEARCH_ITERATIONS; i++) {
    const webSearchCalls = extractWebSearchCalls(current)
    if (webSearchCalls.length === 0) return current

    consola.info(
      `Executing ${webSearchCalls.length} web search(es), iteration ${i + 1}`,
    )

    const results = await Promise.all(
      webSearchCalls.map(async (tc) => {
        const query = parseWebSearchQuery(tc.function.arguments)
        const result = await executeWebSearch(query)
        return { callId: tc.id, result }
      }),
    )

    const assistantMessage: Message = {
      role: "assistant",
      content: current.choices[0]?.message.content ?? null,
      tool_calls: current.choices[0]?.message.tool_calls,
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
    }

    current = (await createChatCompletions(currentPayload, {
      initiator: initiatorOverride,
    })) as ChatCompletionResponse
  }

  return current
}

// --- Responses API web search resolution ---

export const resolveResponsesWebSearchCalls = async (
  result: ResponsesResult,
  payload: ResponsesPayload,
  requestOptions: { vision: boolean; initiator: "agent" | "user" },
): Promise<ResponsesResult> => {
  let current = result
  let currentPayload = payload

  for (let i = 0; i < MAX_WEB_SEARCH_ITERATIONS; i++) {
    const webSearchCalls = current.output.filter(
      (item): item is ResponseOutputFunctionCall =>
        item.type === "function_call" && item.name === "web_search",
    )
    if (webSearchCalls.length === 0) return current

    consola.info(
      `Executing ${webSearchCalls.length} web search(es) via Responses API, iteration ${i + 1}`,
    )

    const searchResults = await Promise.all(
      webSearchCalls.map(async (item) => {
        const query = parseWebSearchQuery(item.arguments)
        const searchResult = await executeWebSearch(query)
        return { callId: item.call_id, result: searchResult }
      }),
    )

    const newInput: Array<ResponseInputItem> = [
      ...(Array.isArray(currentPayload.input) ? currentPayload.input : []),
      ...current.output.map((item) =>
        item.type === "function_call" ?
          {
            type: "function_call" as const,
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments,
            status: "completed" as const,
          }
        : (item as ResponseInputItem),
      ),
      ...searchResults.map((r) => ({
        type: "function_call_output" as const,
        call_id: r.callId,
        output: r.result,
      })),
    ]

    currentPayload = { ...currentPayload, input: newInput, stream: false }
    const response = await createResponses(currentPayload, requestOptions)
    current = response as ResponsesResult
  }

  return current
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
      acc.reasoningText = (acc.reasoningText ?? "") + choice.delta.reasoning_text
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
  toolCalls: NonNullable<ChatCompletionChunk["choices"][0]["delta"]["tool_calls"]>,
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
          ...(acc.reasoningOpaque ? { reasoning_opaque: acc.reasoningOpaque } : {}),
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
  if (block.type === "text") {
    await emitTextBlock(stream, block.text, index)
  } else if (block.type === "thinking") {
    await emitThinkingBlock(stream, block, index)
  } else if (block.type === "tool_use") {
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
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    }),
  })
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
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
      delta: { stop_reason: response.stop_reason, stop_sequence: response.stop_sequence },
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
  stream: { writeSSE: (data: { event?: string; data: string }) => Promise<void> },
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
    seqNum = await emitResponsesOutputItem(stream, result.output[i], i, seqNum)
  }

  await stream.writeSSE({
    event: "response.completed",
    data: JSON.stringify({
      type: "response.completed",
      response: result,
      sequence_number: seqNum,
    }),
  })
}

const emitResponsesOutputItem = async (
  stream: { writeSSE: (data: { event?: string; data: string }) => Promise<void> },
  item: ResponseOutputItem,
  outputIndex: number,
  seqNum: number,
): Promise<number> => {
  let seq = seqNum
  const itemId =
    item.id ?? (item.type === "function_call" ? `fc_${item.call_id}` : `item_${outputIndex}`)
  const itemWithId = { ...item, id: itemId }

  await stream.writeSSE({
    event: "response.output_item.added",
    data: JSON.stringify({
      type: "response.output_item.added",
      item: { ...itemWithId, status: "in_progress" },
      output_index: outputIndex,
      sequence_number: seq++,
    }),
  })

  if (item.type === "message" && item.content) {
    seq = await emitResponsesMessageContent(stream, item.content, itemId, outputIndex, seq)
  }

  if (item.type === "function_call") {
    await stream.writeSSE({
      event: "response.function_call_arguments.done",
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id: itemId,
        output_index: outputIndex,
        arguments: item.arguments,
        name: item.name,
        sequence_number: seq++,
      }),
    })
  }

  await stream.writeSSE({
    event: "response.output_item.done",
    data: JSON.stringify({
      type: "response.output_item.done",
      item: itemWithId,
      output_index: outputIndex,
      sequence_number: seq++,
    }),
  })

  return seq
}

const emitResponsesMessageContent = async (
  stream: { writeSSE: (data: { event?: string; data: string }) => Promise<void> },
  content: Array<ResponseOutputContentBlock>,
  itemId: string,
  outputIndex: number,
  seqNum: number,
): Promise<number> => {
  let seq = seqNum

  for (let ci = 0; ci < content.length; ci++) {
    const block = content[ci]
    if (!("type" in block) || (block as { type: string }).type !== "output_text") continue

    const text = (block as unknown as ResponseOutputText).text
    await stream.writeSSE({
      event: "response.output_text.delta",
      data: JSON.stringify({
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: outputIndex,
        content_index: ci,
        delta: text,
        sequence_number: seq++,
      }),
    })
    await stream.writeSSE({
      event: "response.output_text.done",
      data: JSON.stringify({
        type: "response.output_text.done",
        item_id: itemId,
        output_index: outputIndex,
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
  for (const chunk of chunks) {
    for (const choice of chunk.choices) {
      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.function?.name === "web_search") return true
        }
      }
    }
  }
  return false
}
