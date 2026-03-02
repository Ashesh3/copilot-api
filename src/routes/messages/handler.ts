import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { createHandlerLogger } from "~/lib/logger"
import { normalizeModelName } from "~/lib/model-resolver"
import { parseModelSuffix } from "~/lib/model-suffix"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
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
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import { executeWebSearch } from "~/services/copilot/mcp-web-search"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamState,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Capture the originally requested model before any manipulation
  const requestedModel = anthropicPayload.model

  // Parse model suffix for reasoning effort override (e.g. "claude-sonnet-4.6:high")
  const { baseModel, reasoningEffort: suffixEffort } = parseModelSuffix(
    anthropicPayload.model,
  )
  // Normalize model name (e.g. "claude-opus-4-6[1m]" → "claude-opus-4.6-1m")
  anthropicPayload.model = normalizeModelName(baseModel)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  const initiatorOverride = subagentMarker ? "agent" : undefined
  if (subagentMarker) {
    logger.debug("Detected Subagent marker:", JSON.stringify(subagentMarker))
  }

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)

  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)

  // Route to model variants based on client signals
  applyModelVariantRouting(anthropicPayload, anthropicBeta)

  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
  } else {
    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    // compact requests are excluded from this processing
    mergeToolResultForClaude(anthropicPayload)
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = state.models?.data.find(
    (m) => m.id === anthropicPayload.model,
  )

  // Log the requested vs routed model
  let apiType = "ChatCompletions"
  if (shouldUseResponsesApi(selectedModel)) {
    apiType = "Responses"
  }

  // Determine effective reasoning effort for logging
  // Priority: suffix > body thinking config
  const bodyEffort = getBodyReasoningEffort(anthropicPayload)
  const effectiveEffort = suffixEffort ?? bodyEffort

  setRequestContext(c, {
    requestedModel,
    model: anthropicPayload.model,
    provider: apiType,
    reasoningEffort: effectiveEffort,
  })

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, {
      initiatorOverride,
      effortOverride: suffixEffort,
    })
  }

  return await handleWithChatCompletions(c, anthropicPayload, initiatorOverride)
}

const RESPONSES_ENDPOINT = "/responses"

const MAX_WEB_SEARCH_ITERATIONS = 3

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  initiatorOverride?: "agent" | "user",
) => {
  const openAIPayload = translateToOpenAI(anthropicPayload)

  // Add thinking_budget if the client requested thinking with a budget
  if (anthropicPayload.thinking?.budget_tokens) {
    ;(openAIPayload as unknown as Record<string, unknown>).thinking_budget =
      anthropicPayload.thinking.budget_tokens
    // Claude requires temperature=1 when thinking is enabled
    openAIPayload.temperature = 1
  }

  const { payload: replacedPayload, appliedRules } =
    await applyReplacementsToPayload(openAIPayload)
  const finalPayload = {
    ...replacedPayload,
    model: normalizeModelName(replacedPayload.model),
  }

  if (appliedRules.length > 0) {
    setRequestContext(c, { replacements: appliedRules })
  }

  // Calculate token count for the translated payload
  try {
    const selectedModel = state.models?.data.find(
      (m) => m.id === finalPayload.model,
    )
    if (selectedModel) {
      const tokenCount = await getTokenCount(finalPayload, selectedModel)
      setRequestContext(c, { inputTokens: tokenCount.input })
    }
  } catch {
    // Token counting is best-effort, don't fail the request
  }

  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(finalPayload),
  )

  const response = await createChatCompletions(finalPayload, {
    initiator: initiatorOverride,
  })

  if (isNonStreaming(response)) {
    // Check for web_search tool calls and execute them in a loop
    const finalResponse = await resolveWebSearchCalls(
      response,
      finalPayload,
      initiatorOverride,
    )

    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(finalResponse).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(finalResponse)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  // Streaming: buffer first response to check for web_search tool calls
  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    // Collect all chunks first to check for web_search calls
    const bufferedChunks: Array<ChatCompletionChunk> = []
    let hasWebSearchCall = false

    for await (const rawEvent of response) {
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      bufferedChunks.push(chunk)

      // Check if any chunk has a web_search tool call
      for (const choice of chunk.choices) {
        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            if (tc.function?.name === "web_search") {
              hasWebSearchCall = true
            }
          }
        }
      }
    }

    if (hasWebSearchCall) {
      // Reconstruct the full response from buffered chunks
      const reconstructed = reconstructFromChunks(bufferedChunks)
      if (reconstructed) {
        // Execute web search and get final response (non-streaming)
        const resolved = await resolveWebSearchCalls(
          reconstructed,
          finalPayload,
          initiatorOverride,
        )
        // Re-send as a non-streaming response, but translate to stream events
        const anthropicResponse = translateToAnthropic(resolved)
        // Emit all events for the complete response as stream
        await emitAnthropicResponseAsStream(stream, anthropicResponse)
        return
      }
    }

    // No web_search calls — replay buffered chunks as normal stream
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for (const chunk of bufferedChunks) {
      const events = translateChunkToAnthropicEvents(chunk, streamState)
      for (const event of events) {
        logger.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    initiatorOverride?: "agent" | "user"
    effortOverride?: "low" | "medium" | "high" | "xhigh"
  },
) => {
  const { initiatorOverride, effortOverride } = options ?? {}
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    anthropicPayload,
    effortOverride,
  )
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator: initiatorOverride ?? initiator,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      // Buffer all stream events to check for web_search function calls
      const bufferedEvents: Array<ResponseStreamEvent> = []
      let hasWebSearchCall = false
      let completedResult: ResponsesResult | null = null

      for await (const chunk of response) {
        const eventName = chunk.event
        if (eventName === "ping") continue

        const data = chunk.data
        if (!data) continue

        const parsed = JSON.parse(data) as ResponseStreamEvent
        bufferedEvents.push(parsed)

        // Check for web_search function calls
        if (
          parsed.type === "response.output_item.done"
          && "item" in parsed
          && (parsed.item as { type?: string }).type === "function_call"
          && (parsed.item as { name?: string }).name === "web_search"
        ) {
          hasWebSearchCall = true
        }

        // Capture the completed result for web search resolution
        if (
          (parsed.type === "response.completed"
            || parsed.type === "response.incomplete")
          && "response" in parsed
        ) {
          completedResult = parsed.response as ResponsesResult
        }
      }

      if (hasWebSearchCall && completedResult) {
        // Execute web searches and get final response
        const resolved = await resolveResponsesWebSearchCalls(
          completedResult,
          responsesPayload,
          { vision, initiator: initiatorOverride ?? initiator },
        )
        const anthropicResponse = translateResponsesResultToAnthropic(resolved)
        await emitAnthropicResponseAsStream(stream, anthropicResponse)
        return
      }

      // No web_search calls — replay buffered events as normal stream
      const streamState = createResponsesStreamState()
      for (const parsed of bufferedEvents) {
        if (parsed.type === "error") continue

        const events = translateResponsesStreamEvent(parsed, streamState)
        for (const event of events) {
          const eventData = JSON.stringify(event)
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
        }

        if (streamState.messageCompleted) break
      }

      if (!streamState.messageCompleted) {
        logger.warn(
          "Responses stream ended without completion; sending error event",
        )
        const errorEvent = buildErrorEvent(
          "Responses stream ended without completion",
        )
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
    })
  }

  // Non-streaming: check for web_search calls
  const result = response as ResponsesResult
  const resolved = await resolveResponsesWebSearchCalls(
    result,
    responsesPayload,
    { vision, initiator: initiatorOverride ?? initiator },
  )

  logger.debug(
    "Non-streaming Responses result:",
    JSON.stringify(resolved).slice(-400),
  )
  const anthropicResponse = translateResponsesResultToAnthropic(resolved)
  logger.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

/**
 * Route to model variants based on client signals (1m context, fast mode).
 * Mutates the payload in place.
 */
function applyModelVariantRouting(
  payload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
): void {
  // 1M context via beta header → route to -1m model variant
  if (anthropicBeta?.includes("context-1m")) {
    const candidate = `${payload.model}-1m`
    if (state.models?.data.some((m) => m.id === candidate)) {
      payload.model = candidate
    }
  }

  // Fast mode → route to -fast model variant, strip unsupported field
  if (payload.speed === "fast") {
    const candidate = `${payload.model}-fast`
    if (state.models?.data.some((m) => m.id === candidate)) {
      payload.model = candidate
    }
    delete payload.speed
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

/**
 * Extract reasoning effort info from the Anthropic request body for logging.
 * Claude Code sends effort as `output_config.effort` (low/medium/high/max)
 * and thinking mode as `thinking.type` (enabled/adaptive).
 * When effort is "high" (the default), Claude Code omits output_config.effort entirely.
 */
function getBodyReasoningEffort(
  payload: AnthropicMessagesPayload,
): string | undefined {
  // No thinking config at all — no effort to report
  if (!payload.thinking && !payload.output_config?.effort) return undefined

  const parts: Array<string> = []

  // output_config.effort is the actual effort level (low/medium/high/max)
  // Claude Code omits this field when effort is "high" (the API default)
  const effort =
    payload.output_config?.effort ?? (payload.thinking ? "high" : undefined)
  if (effort) {
    parts.push(effort)
  }

  // thinking.type indicates the thinking mode (enabled/adaptive)
  if (payload.thinking) {
    parts.push(payload.thinking.type)
    if (payload.thinking.budget_tokens) {
      parts.push(`${payload.thinking.budget_tokens.toLocaleString()} budget`)
    }
  }

  return parts.length > 0 ? parts.join(", ") : undefined
}

const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}

const mergeContentWithText = (
  tr: AnthropicToolResultBlock,
  textBlock: AnthropicTextBlock,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    return { ...tr, content: `${tr.content}\n\n${textBlock.text}` }
  }
  if (Array.isArray(tr.content)) {
    return {
      ...tr,
      content: [...tr.content, textBlock],
    }
  }
  // content is null/undefined — start fresh with just the text block
  return { ...tr, content: [textBlock] }
}

const mergeContentWithTexts = (
  tr: AnthropicToolResultBlock,
  textBlocks: Array<AnthropicTextBlock>,
): AnthropicToolResultBlock => {
  if (typeof tr.content === "string") {
    const appendedTexts = textBlocks.map((tb) => tb.text).join("\n\n")
    return { ...tr, content: `${tr.content}\n\n${appendedTexts}` }
  }
  if (Array.isArray(tr.content)) {
    return { ...tr, content: [...tr.content, ...textBlocks] }
  }
  // content is null/undefined
  return { ...tr, content: [...textBlocks] }
}

const mergeToolResultForClaude = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const toolResults: Array<AnthropicToolResultBlock> = []
    const textBlocks: Array<AnthropicTextBlock> = []
    let valid = true

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        toolResults.push(block)
      } else if (block.type === "text") {
        textBlocks.push(block)
      } else {
        valid = false
        break
      }
    }

    if (!valid || toolResults.length === 0 || textBlocks.length === 0) continue

    msg.content = mergeToolResult(toolResults, textBlocks)
  }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  // equal lengths -> pairwise merge
  if (toolResults.length === textBlocks.length) {
    return toolResults.map((tr, i) => mergeContentWithText(tr, textBlocks[i]))
  }

  // lengths differ -> append all textBlocks to the last tool_result
  const lastIndex = toolResults.length - 1
  return toolResults.map((tr, i) =>
    i === lastIndex ? mergeContentWithTexts(tr, textBlocks) : tr,
  )
}

// --- Web search tool execution helpers ---

/**
 * Check if a ChatCompletion response contains web_search tool calls.
 * If so, execute the searches via MCP and re-send to get a final response.
 */
const resolveWebSearchCalls = async (
  response: ChatCompletionResponse,
  payload: ChatCompletionsPayload,
  initiatorOverride?: "agent" | "user",
): Promise<ChatCompletionResponse> => {
  let current = response
  let currentPayload = payload

  for (let i = 0; i < MAX_WEB_SEARCH_ITERATIONS; i++) {
    const webSearchCalls = extractWebSearchCalls(current)
    if (webSearchCalls.length === 0) {
      return current
    }

    logger.info(
      `Executing ${webSearchCalls.length} web search(es), iteration ${i + 1}`,
    )

    // Execute all web searches in parallel
    const results = await Promise.all(
      webSearchCalls.map(async (tc) => {
        const args = JSON.parse(tc.function.arguments) as { query?: string }
        const query = args.query ?? ""
        logger.debug("Web search query:", query)
        const result = await executeWebSearch(query)
        return { callId: tc.id, result }
      }),
    )

    // Build new messages: append assistant message with tool_calls + tool results
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

const extractWebSearchCalls = (
  response: ChatCompletionResponse,
): Array<ToolCall> => {
  const calls: Array<ToolCall> = []
  for (const choice of response.choices) {
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.function.name === "web_search") {
          calls.push(tc)
        }
      }
    }
  }
  return calls
}

/**
 * Reconstruct a full ChatCompletionResponse from buffered streaming chunks.
 */
const reconstructFromChunks = (
  chunks: Array<ChatCompletionChunk>,
): ChatCompletionResponse | null => {
  if (chunks.length === 0) return null

  let id = ""
  let model = ""
  let created = 0
  let content = ""
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" =
    "stop"
  const toolCallsMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()
  let reasoningText: string | null = null
  let reasoningOpaque: string | null = null
  let usage:
    | {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
        prompt_tokens_details?: { cached_tokens: number }
      }
    | undefined

  for (const chunk of chunks) {
    if (chunk.id) id = chunk.id
    if (chunk.model) model = chunk.model
    if (chunk.created) created = chunk.created
    if (chunk.usage) usage = chunk.usage

    for (const choice of chunk.choices) {
      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }

      if (choice.delta.content) {
        content += choice.delta.content
      }

      if (choice.delta.reasoning_text) {
        reasoningText = (reasoningText ?? "") + choice.delta.reasoning_text
      }

      if (choice.delta.reasoning_opaque) {
        reasoningOpaque = choice.delta.reasoning_opaque
      }

      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const existing = toolCallsMap.get(tc.index)
          if (!existing) {
            toolCallsMap.set(tc.index, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            })
          } else {
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.name = tc.function.name
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments
            }
          }
        }
      }
    }
  }

  const toolCalls =
    toolCallsMap.size > 0 ?
      Array.from(toolCallsMap.values()).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
    : undefined

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(reasoningText ? { reasoning_text: reasoningText } : {}),
          ...(reasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage,
  }
}

/**
 * Emit a complete AnthropicResponse as a series of SSE stream events.
 */
const emitAnthropicResponseAsStream = async (
  stream: { writeSSE: (data: { event: string; data: string }) => Promise<void> },
  response: AnthropicResponse,
): Promise<void> => {
  // message_start
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

  // Content blocks
  for (let i = 0; i < response.content.length; i++) {
    const block = response.content[i]

    // content_block_start
    if (block.type === "text") {
      await stream.writeSSE({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: i,
          content_block: { type: "text", text: "" },
        }),
      })
      // content_block_delta
      await stream.writeSSE({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: i,
          delta: { type: "text_delta", text: block.text },
        }),
      })
    } else if (block.type === "thinking") {
      await stream.writeSSE({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: i,
          content_block: { type: "thinking", thinking: "" },
        }),
      })
      await stream.writeSSE({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: i,
          delta: { type: "thinking_delta", thinking: block.thinking },
        }),
      })
      if (block.signature) {
        await stream.writeSSE({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: i,
            delta: { type: "signature_delta", signature: block.signature },
          }),
        })
      }
    } else if (block.type === "tool_use") {
      await stream.writeSSE({
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: i,
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
          index: i,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        }),
      })
    }

    // content_block_stop
    await stream.writeSSE({
      event: "content_block_stop",
      data: JSON.stringify({
        type: "content_block_stop",
        index: i,
      }),
    })
  }

  // message_delta
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

  // message_stop
  await stream.writeSSE({
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  })
}

/**
 * Check if a Responses API result contains web_search function calls.
 * If so, execute searches via MCP and re-send to get a final response.
 */
const resolveResponsesWebSearchCalls = async (
  result: ResponsesResult,
  payload: ResponsesPayload,
  requestOptions: { vision: boolean; initiator: "agent" | "user" },
): Promise<ResponsesResult> => {
  let current = result
  let currentPayload = payload

  for (let i = 0; i < MAX_WEB_SEARCH_ITERATIONS; i++) {
    const webSearchCalls = current.output.filter(
      (item) => item.type === "function_call" && item.name === "web_search",
    )

    if (webSearchCalls.length === 0) {
      return current
    }

    logger.info(
      `Executing ${webSearchCalls.length} web search(es) via Responses API, iteration ${i + 1}`,
    )

    // Execute all web searches in parallel
    const searchResults = await Promise.all(
      webSearchCalls.map(async (item) => {
        if (item.type !== "function_call") return null
        const args = JSON.parse(item.arguments) as { query?: string }
        const query = args.query ?? ""
        logger.debug("Web search query:", query)
        const searchResult = await executeWebSearch(query)
        return { callId: item.call_id, result: searchResult }
      }),
    )

    // Build new input: original input + all output items + tool results
    const newInput: Array<ResponseInputItem> = [
      ...(Array.isArray(currentPayload.input) ? currentPayload.input : []),
      ...current.output.map((item) => {
        if (item.type === "function_call") {
          return {
            type: "function_call" as const,
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments,
            status: "completed" as const,
          }
        }
        return item as ResponseInputItem
      }),
      ...searchResults
        .filter(
          (r): r is { callId: string; result: string } => r !== null,
        )
        .map((r) => ({
          type: "function_call_output" as const,
          call_id: r.callId,
          output: r.result,
        })),
    ]

    currentPayload = {
      ...currentPayload,
      input: newInput,
      stream: false,
    }

    const response = await createResponses(currentPayload, requestOptions)
    current = response as ResponsesResult
  }

  return current
}
