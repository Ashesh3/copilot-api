/* eslint-disable max-lines, max-lines-per-function */
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { getLastUsedAccountId } from "~/lib/account-router"
import { awaitApproval } from "~/lib/approval"
import { applyReplacementsToPayload } from "~/lib/auto-replace"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { normalizeModelName } from "~/lib/model-resolver"
import { parseModelSuffix } from "~/lib/model-suffix"
import { calculateCost } from "~/lib/pricing-cache"
import { checkRateLimit } from "~/lib/rate-limit"
import { setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { traceRecorder } from "~/lib/trace-recorder"
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
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import { isWebSearchToolType } from "~/services/copilot/mcp-web-search"

import {
  type AnthropicMessagesPayload,
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
import {
  emitAnthropicResponseAsStream,
  hasWebSearchInChunks,
  reconstructFromChunks,
  resolveResponsesWebSearchCalls,
  resolveWebSearchCalls,
} from "./web-search-helpers"

// ─── Trace helpers ───

function traceSpanId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16)
}
function newTraceId(): string {
  return crypto.randomUUID().replaceAll("-", "")
}
function traceNow(): string {
  return new Date().toISOString()
}

/** Safe wrapper - tracing never breaks the proxy */
const safeTrace = (fn: () => void): void => {
  try {
    fn()
  } catch {
    // Tracing is best-effort
  }
}

/**
 * Strip thinking blocks from all assistant messages in the payload.
 * Returns true if any thinking blocks were removed.
 * Used to recover from "Invalid signature in thinking block" errors
 * when models are switched mid-conversation.
 */
export function stripThinkingBlocks(
  payload: AnthropicMessagesPayload,
): boolean {
  let stripped = false
  for (const msg of payload.messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    const before = msg.content.length
    msg.content = msg.content.filter((block) => block.type !== "thinking")
    if (msg.content.length < before) stripped = true
  }
  return stripped
}

/**
 * Strip thinking blocks from assistant messages in multi-token mode.
 *
 * Thinking block signatures (reasoning_opaque / signature) are cryptographically
 * tied to the specific Copilot token that generated them. In multi-token mode,
 * round-robin may route the next request to a different account, making
 * previous signatures invalid. Stripping them avoids the wasted 400 round-trip.
 *
 * In single-token mode, signatures stay valid and thinking context is preserved.
 */
function stripThinkingBlocksForMultiToken(
  payload: AnthropicMessagesPayload,
): void {
  if (!state.isMultiToken) return

  for (const msg of payload.messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    msg.content = msg.content.filter((block) => block.type !== "thinking")
  }
}

const logger = createHandlerLogger("messages-handler")

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"

const hasWebSearchToolInPayload = (
  tools: AnthropicMessagesPayload["tools"],
): boolean => {
  if (!tools) return false
  return tools.some((tool) => isWebSearchToolType(tool))
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const currentTraceId = newTraceId()
  const rootSpanId = traceSpanId()

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  safeTrace(() =>
    traceRecorder.startTrace({
      id: currentTraceId,
      name: `POST ${c.req.path}`,
      input: JSON.stringify(anthropicPayload).slice(0, 500000),
      meta: { environment: process.env.NODE_ENV },
    }),
  )

  // Record parse-request span
  const parseStart = traceNow()

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
    mergeToolResultForClaude(anthropicPayload)
  }

  safeTrace(() =>
    traceRecorder.recordSpan({
      id: traceSpanId(),
      traceId: currentTraceId,
      parentSpanId: rootSpanId,
      name: "parse-request",
      type: "step",
      startTime: parseStart,
      endTime: traceNow(),
      input: JSON.stringify({ model: requestedModel }).slice(0, 500000),
      output: JSON.stringify({
        model: anthropicPayload.model,
        isCompact,
      }).slice(0, 500000),
    }),
  )

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
  const bodyEffort = getBodyReasoningEffort(anthropicPayload)
  const effectiveEffort = suffixEffort ?? bodyEffort

  setRequestContext(c, {
    requestedModel,
    model: anthropicPayload.model,
    provider: apiType,
    reasoningEffort: effectiveEffort,
  })

  const traceCtx = { traceId: currentTraceId, rootSpanId }

  try {
    const result =
      shouldUseResponsesApi(selectedModel) ?
        await handleWithResponsesApi(c, anthropicPayload, {
          initiatorOverride,
          effortOverride: suffixEffort,
          requestedModel,
          ...traceCtx,
        })
      : await handleWithChatCompletions(c, anthropicPayload, {
          initiatorOverride,
          requestedModel,
          ...traceCtx,
        })

    safeTrace(() =>
      traceRecorder.endTrace({ id: currentTraceId, status: "ok" }),
    )
    return result
  } catch (error) {
    safeTrace(() =>
      traceRecorder.endTrace({
        id: currentTraceId,
        status: "error",
        statusMessage: error instanceof Error ? error.message : String(error),
      }),
    )
    throw error
  }
}

const RESPONSES_ENDPOINT = "/responses"

interface ChatCompletionsStreamContext {
  finalPayload: ReturnType<typeof translateToOpenAI> & { model: string }
  initiatorOverride?: "agent" | "user"
  requestedModel?: string
}

const streamChatCompletionsWithWebSearch = async (
  stream: {
    writeSSE: (data: { event: string; data: string }) => Promise<void>
  },
  response: AsyncIterable<{ data?: string }>,
  ctx: ChatCompletionsStreamContext,
): Promise<void> => {
  const bufferedChunks: Array<ChatCompletionChunk> = []

  for await (const rawEvent of response) {
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue
    bufferedChunks.push(JSON.parse(rawEvent.data) as ChatCompletionChunk)
  }

  if (hasWebSearchInChunks(bufferedChunks)) {
    const reconstructed = reconstructFromChunks(bufferedChunks)
    if (reconstructed) {
      const resolved = await resolveWebSearchCalls(
        reconstructed,
        ctx.finalPayload,
        ctx.initiatorOverride,
      )
      const anthropicResponse = translateToAnthropic(
        resolved,
        ctx.requestedModel,
      )
      await emitAnthropicResponseAsStream(stream, anthropicResponse)
      return
    }
  }

  // No web_search calls — replay buffered chunks
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }

  for (const chunk of bufferedChunks) {
    const events = translateChunkToAnthropicEvents(
      chunk,
      streamState,
      ctx.requestedModel,
    )
    for (const event of events) {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    }
  }
}

const tryCountTokens = async (
  c: Context,
  payload: Parameters<typeof getTokenCount>[0],
): Promise<void> => {
  try {
    const selectedModel = state.models?.data.find((m) => m.id === payload.model)
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      setRequestContext(c, { inputTokens: tokenCount.input })
    }
  } catch {
    // Token counting is best-effort, don't fail the request
  }
}

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    initiatorOverride?: "agent" | "user"
    requestedModel?: string
    traceId?: string
    rootSpanId?: string
  },
) => {
  try {
    return await executeChatCompletions(c, anthropicPayload, options)
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 400) {
      const body = await error.response.clone().text()
      if (
        (body.includes("Invalid signature")
          || body.includes("Invalid `signature`"))
        && stripThinkingBlocks(anthropicPayload)
      ) {
        logger.warn(
          "Stripped thinking blocks due to invalid signature, retrying",
        )
        return await executeChatCompletions(c, anthropicPayload, options)
      }
    }
    throw error
  }
}

const executeChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    initiatorOverride?: "agent" | "user"
    requestedModel?: string
    traceId?: string
    rootSpanId?: string
  },
) => {
  const { initiatorOverride, requestedModel, traceId, rootSpanId } =
    options ?? {}
  stripThinkingBlocksForMultiToken(anthropicPayload)
  const openAIPayload = translateToOpenAI(anthropicPayload)

  // Enable thinking/reasoning on the ChatCompletions path
  // Copilot API uses reasoning_effort to enable thinking (returns reasoning_text in response)
  // thinking_budget is also sent for models that support explicit budget control
  if (anthropicPayload.thinking) {
    const extra = openAIPayload as unknown as Record<string, unknown>
    extra.reasoning_effort = "high"
    if (anthropicPayload.thinking.budget_tokens) {
      extra.thinking_budget = anthropicPayload.thinking.budget_tokens
    }
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

  await tryCountTokens(c, finalPayload)

  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(finalPayload),
  )

  // Record select-token span
  const selectTokenStart = traceNow()
  const response = await createChatCompletions(finalPayload, {
    initiator: initiatorOverride,
  })

  // Track which account handled this request (multi-token mode)
  const accountId = getLastUsedAccountId()
  if (accountId !== undefined) {
    setRequestContext(c, { accountId })
  }

  if (traceId) {
    safeTrace(() =>
      traceRecorder.recordSpan({
        id: traceSpanId(),
        traceId,
        parentSpanId: rootSpanId,
        name: "select-token",
        type: "step",
        startTime: selectTokenStart,
        endTime: traceNow(),
        output: JSON.stringify({ accountId }),
      }),
    )
  }

  if (isNonStreaming(response)) {
    const llmSpanStart = traceNow()

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

    if (traceId) {
      safeTrace(() => {
        const inputTokens = finalResponse.usage?.prompt_tokens ?? 0
        const outputTokens = finalResponse.usage?.completion_tokens ?? 0
        const cost = calculateCost(
          finalPayload.model,
          inputTokens,
          outputTokens,
        )
        traceRecorder.recordSpan({
          id: traceSpanId(),
          traceId,
          parentSpanId: rootSpanId,
          name: "copilot-api-call",
          type: "llm",
          startTime: llmSpanStart,
          endTime: traceNow(),
          provider: "ChatCompletions",
          model: finalPayload.model,
          inputTokens,
          outputTokens,
          inputCostUsd: cost.inputCostUsd,
          outputCostUsd: cost.outputCostUsd,
          input: JSON.stringify(finalPayload.messages).slice(0, 500000),
          output: JSON.stringify(finalResponse).slice(0, 500000),
        })
      })
    }

    const anthropicResponse = translateToAnthropic(
      finalResponse,
      requestedModel,
    )
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  // Streaming path
  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const llmSpanStart = traceNow()

    if (needsWebSearchBuffering) {
      await streamChatCompletionsWithWebSearch(stream, response, {
        finalPayload,
        initiatorOverride,
        requestedModel,
      })

      if (traceId) {
        safeTrace(() =>
          traceRecorder.recordSpan({
            id: traceSpanId(),
            traceId,
            parentSpanId: rootSpanId,
            name: "copilot-api-call",
            type: "llm",
            startTime: llmSpanStart,
            endTime: traceNow(),
            provider: "ChatCompletions",
            model: finalPayload.model,
            input: JSON.stringify(finalPayload.messages).slice(0, 500000),
          }),
        )
      }
      return
    }

    // No web_search tool — stream directly without buffering
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    let streamInputTokens = 0
    let streamOutputTokens = 0

    for await (const rawEvent of response) {
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

      // Capture usage from chunks
      if (chunk.usage) {
        streamInputTokens = chunk.usage.prompt_tokens
        streamOutputTokens = chunk.usage.completion_tokens
      }

      const events = translateChunkToAnthropicEvents(
        chunk,
        streamState,
        requestedModel,
      )
      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }

    // Record copilot-api-call span after streaming completes
    if (traceId) {
      safeTrace(() => {
        const cost = calculateCost(
          finalPayload.model,
          streamInputTokens,
          streamOutputTokens,
        )
        traceRecorder.recordSpan({
          id: traceSpanId(),
          traceId,
          parentSpanId: rootSpanId,
          name: "copilot-api-call",
          type: "llm",
          startTime: llmSpanStart,
          endTime: traceNow(),
          provider: "ChatCompletions",
          model: finalPayload.model,
          inputTokens: streamInputTokens,
          outputTokens: streamOutputTokens,
          inputCostUsd: cost.inputCostUsd,
          outputCostUsd: cost.outputCostUsd,
          input: JSON.stringify(finalPayload.messages).slice(0, 500000),
        })
      })
    }
  })
}

type SSEStream = {
  writeSSE: (data: { event: string; data: string }) => Promise<void>
}

type ResponsesStream = AsyncIterable<{ event?: string; data?: string }>

const parseResponsesStreamError = (
  parsed: ResponseStreamEvent,
): string | null => {
  if (parsed.type !== "error") return null
  return "message" in parsed ?
      (parsed as { message: string }).message
    : "Upstream error"
}

const writeResponsesEvents = async (
  stream: SSEStream,
  parsed: ResponseStreamEvent,
  streamState: ReturnType<typeof createResponsesStreamState>,
): Promise<void> => {
  const events = translateResponsesStreamEvent(parsed, streamState)
  for (const event of events) {
    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event),
    })
  }
}

const isWebSearchFunctionCall = (parsed: ResponseStreamEvent): boolean =>
  parsed.type === "response.output_item.done"
  && "item" in parsed
  && (parsed.item as { type?: string }).type === "function_call"
  && (parsed.item as { name?: string }).name === "web_search"

const isResponseCompleted = (
  parsed: ResponseStreamEvent,
): parsed is ResponseStreamEvent & { response: ResponsesResult } =>
  (parsed.type === "response.completed"
    || parsed.type === "response.incomplete")
  && "response" in parsed

const bufferResponsesStream = async (
  stream: SSEStream,
  response: ResponsesStream,
): Promise<{
  events: Array<ResponseStreamEvent>
  hasWebSearch: boolean
  completedResult: ResponsesResult | null
}> => {
  const events: Array<ResponseStreamEvent> = []
  let hasWebSearch = false
  let completedResult: ResponsesResult | null = null

  for await (const chunk of response) {
    if (chunk.event === "ping") {
      await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
      continue
    }
    if (!chunk.data) continue

    const parsed = JSON.parse(chunk.data) as ResponseStreamEvent
    events.push(parsed)

    if (isWebSearchFunctionCall(parsed)) hasWebSearch = true
    if (isResponseCompleted(parsed)) completedResult = parsed.response
  }

  return { events, hasWebSearch, completedResult }
}

const replayBufferedEvents = async (
  stream: SSEStream,
  bufferedEvents: Array<ResponseStreamEvent>,
): Promise<void> => {
  const streamState = createResponsesStreamState()
  let errorForwarded = false

  for (const parsed of bufferedEvents) {
    const errorMsg = parseResponsesStreamError(parsed)
    if (errorMsg) {
      const errorEvent = buildErrorEvent(errorMsg)
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
      errorForwarded = true
      continue
    }

    await writeResponsesEvents(stream, parsed, streamState)
    if (streamState.messageCompleted) break
  }

  if (!streamState.messageCompleted && !errorForwarded) {
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
}

const streamResponsesWithWebSearch = async (
  stream: SSEStream,
  response: ResponsesStream,
  ctx: {
    responsesPayload: ReturnType<
      typeof translateAnthropicMessagesToResponsesPayload
    >
    requestOptions: { vision: boolean; initiator: "agent" | "user" }
    requestedModel?: string
  },
): Promise<{ inputTokens: number; outputTokens: number }> => {
  const { events, hasWebSearch, completedResult } = await bufferResponsesStream(
    stream,
    response,
  )

  const inputTokens = completedResult?.usage?.input_tokens ?? 0
  const outputTokens = completedResult?.usage?.output_tokens ?? 0

  if (hasWebSearch && completedResult) {
    const resolved = await resolveResponsesWebSearchCalls(
      completedResult,
      ctx.responsesPayload,
      ctx.requestOptions,
    )
    const anthropicResponse = translateResponsesResultToAnthropic(resolved)
    if (ctx.requestedModel) anthropicResponse.model = ctx.requestedModel
    await emitAnthropicResponseAsStream(stream, anthropicResponse)
    return { inputTokens, outputTokens }
  }

  await replayBufferedEvents(stream, events)
  return { inputTokens, outputTokens }
}

const streamResponsesDirect = async (
  stream: SSEStream,
  response: ResponsesStream,
): Promise<{ inputTokens: number; outputTokens: number }> => {
  const streamState = createResponsesStreamState()
  let streamInputTokens = 0
  let streamOutputTokens = 0

  for await (const chunk of response) {
    if (chunk.event === "ping") {
      await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
      continue
    }
    if (!chunk.data) continue

    const parsed = JSON.parse(chunk.data) as ResponseStreamEvent
    const errorMsg = parseResponsesStreamError(parsed)
    if (errorMsg) {
      const errorEvent = buildErrorEvent(errorMsg)
      await stream.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
      continue
    }

    // Capture usage from response.completed events
    if (isResponseCompleted(parsed) && parsed.response.usage) {
      streamInputTokens = parsed.response.usage.input_tokens
      streamOutputTokens = parsed.response.usage.output_tokens ?? 0
    }

    await writeResponsesEvents(stream, parsed, streamState)
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

  return { inputTokens: streamInputTokens, outputTokens: streamOutputTokens }
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    initiatorOverride?: "agent" | "user"
    effortOverride?: "low" | "medium" | "high" | "xhigh"
    requestedModel?: string
    traceId?: string
    rootSpanId?: string
  },
) => {
  try {
    return await executeResponsesApi(c, anthropicPayload, options)
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 400) {
      const body = await error.response.clone().text()
      if (
        (body.includes("Invalid signature")
          || body.includes("Invalid `signature`"))
        && stripThinkingBlocks(anthropicPayload)
      ) {
        logger.warn(
          "Stripped thinking blocks due to invalid signature (Responses API), retrying",
        )
        return await executeResponsesApi(c, anthropicPayload, options)
      }
    }
    throw error
  }
}

const executeResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options?: {
    initiatorOverride?: "agent" | "user"
    effortOverride?: "low" | "medium" | "high" | "xhigh"
    requestedModel?: string
    traceId?: string
    rootSpanId?: string
  },
) => {
  const {
    initiatorOverride,
    effortOverride,
    requestedModel,
    traceId,
    rootSpanId,
  } = options ?? {}
  stripThinkingBlocksForMultiToken(anthropicPayload)
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    anthropicPayload,
    effortOverride,
  )
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)

  // Record select-token span
  const selectTokenStart = traceNow()
  const response = await createResponses(responsesPayload, {
    vision,
    initiator: initiatorOverride ?? initiator,
  })

  // Track which account handled this request (multi-token mode)
  const responsesAccountId = getLastUsedAccountId()
  if (responsesAccountId !== undefined) {
    setRequestContext(c, { accountId: responsesAccountId })
  }

  if (traceId) {
    safeTrace(() =>
      traceRecorder.recordSpan({
        id: traceSpanId(),
        traceId,
        parentSpanId: rootSpanId,
        name: "select-token",
        type: "step",
        startTime: selectTokenStart,
        endTime: traceNow(),
        output: JSON.stringify({ accountId: responsesAccountId }),
      }),
    )
  }

  const needsWebSearchBuffering = hasWebSearchToolInPayload(
    anthropicPayload.tools,
  )

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      const llmSpanStart = traceNow()

      if (needsWebSearchBuffering) {
        const wsUsage = await streamResponsesWithWebSearch(stream, response, {
          responsesPayload,
          requestOptions: { vision, initiator: initiatorOverride ?? initiator },
          requestedModel,
        })

        if (traceId) {
          safeTrace(() => {
            const cost = calculateCost(
              anthropicPayload.model,
              wsUsage.inputTokens,
              wsUsage.outputTokens,
            )
            traceRecorder.recordSpan({
              id: traceSpanId(),
              traceId,
              parentSpanId: rootSpanId,
              name: "copilot-api-call",
              type: "llm",
              startTime: llmSpanStart,
              endTime: traceNow(),
              provider: "Responses",
              model: anthropicPayload.model,
              inputTokens: wsUsage.inputTokens,
              outputTokens: wsUsage.outputTokens,
              inputCostUsd: cost.inputCostUsd,
              outputCostUsd: cost.outputCostUsd,
              input: JSON.stringify(anthropicPayload.messages).slice(0, 500000),
            })
          })
        }
        return
      }

      const directUsage = await streamResponsesDirect(stream, response)

      if (traceId) {
        safeTrace(() => {
          const cost = calculateCost(
            anthropicPayload.model,
            directUsage.inputTokens,
            directUsage.outputTokens,
          )
          traceRecorder.recordSpan({
            id: traceSpanId(),
            traceId,
            parentSpanId: rootSpanId,
            name: "copilot-api-call",
            type: "llm",
            startTime: llmSpanStart,
            endTime: traceNow(),
            provider: "Responses",
            model: anthropicPayload.model,
            inputTokens: directUsage.inputTokens,
            outputTokens: directUsage.outputTokens,
            inputCostUsd: cost.inputCostUsd,
            outputCostUsd: cost.outputCostUsd,
            input: JSON.stringify(anthropicPayload.messages).slice(0, 500000),
          })
        })
      }
    })
  }

  // Non-streaming: check for web_search calls
  const llmSpanStart = traceNow()
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

  if (traceId) {
    safeTrace(() => {
      const inputTokens = resolved.usage?.input_tokens ?? 0
      const outputTokens = resolved.usage?.output_tokens ?? 0
      const cost = calculateCost(
        anthropicPayload.model,
        inputTokens,
        outputTokens,
      )
      traceRecorder.recordSpan({
        id: traceSpanId(),
        traceId,
        parentSpanId: rootSpanId,
        name: "copilot-api-call",
        type: "llm",
        startTime: llmSpanStart,
        endTime: traceNow(),
        provider: "Responses",
        model: anthropicPayload.model,
        inputTokens,
        outputTokens,
        inputCostUsd: cost.inputCostUsd,
        outputCostUsd: cost.outputCostUsd,
        input: JSON.stringify(anthropicPayload.messages).slice(0, 500000),
        output: JSON.stringify(resolved).slice(0, 500000),
      })
    })
  }

  const anthropicResponse = translateResponsesResultToAnthropic(resolved)
  if (requestedModel) anthropicResponse.model = requestedModel
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
